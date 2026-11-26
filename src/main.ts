/**
 * ioBroker Mill Heater Adapter
 *
 * One adapter instance can manage multiple Mill devices. Each physical
 * device is represented by its own MillHeaterDevice instance, which owns
 * its API mutex, connection state and polling timers.
 */

import { Mutex } from "async-mutex";
import * as utils from "@iobroker/adapter-core";
import { MillHeaterDevice, type MillHeaterDeviceCallbacks, type MillHeaterDeviceConfig } from "./lib/millHeaterDevice";
import { DEVICE_CHANNELS, DEVICE_STATES } from "./lib/deviceStates";

// Maximum number of MAC-based device trees and configured devices.
const MAX_DEVICE_TREES = 2 * 42;

interface ConfiguredMillDevice extends MillHeaterDeviceConfig {
	host: string;
}

class Millheater extends utils.Adapter {
	private readonly devices: MillHeaterDevice[] = [];
	private readonly devicesById = new Map<string, MillHeaterDevice>();
	private readonly deviceTreeCleanupMutex = new Mutex();

	private isUnloading = false;
	private configuredDeviceHosts = new Set<string>();

	// Must match the limits in admin/jsonConfig.json
	private readonly apiTimeoutMin = 1;
	private readonly apiTimeoutMax = 60;
	private apiTimeout = 0;

	private pollInterval1 = 0;

	// Must match the limits in admin/jsonConfig.json
	private readonly pollInterval1Max = 3600;

	private pollInterval2 = 0;

	// Must match the limits in admin/jsonConfig.json
	private readonly pollInterval2Max = 86400;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: "millheater",
			// The adapter core explicitly waits for the ready promise.
			ready: () => this.onReady(),
		});

		this.on("stateChange", (id, state) => {
			this.onStateChange(id, state);
		});

		this.on("unload", callback => {
			this.onUnload(callback);
		});
	}

	/** Adapter startup. */
	private async onReady(): Promise<void> {
		this.log.info("Mill Heater Adapter started.");

		this.apiTimeout = this.config.apiTimeout;
		this.pollInterval1 = this.config.pollInterval1;
		this.pollInterval2 = this.config.pollInterval2;

		if (
			!Number.isInteger(this.apiTimeout) ||
			this.apiTimeout < this.apiTimeoutMin ||
			this.apiTimeout > this.apiTimeoutMax
		) {
			const message = `HTTP timeout must be between ${this.apiTimeoutMin} and ${this.apiTimeoutMax} seconds.`;
			this.log.error(message);
			this.terminate(message, utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			return;
		}

		if (
			!Number.isInteger(this.pollInterval1) ||
			this.pollInterval1 < this.apiTimeout + 1 ||
			this.pollInterval1 > this.pollInterval1Max
		) {
			const message = `Fast polling interval must be between ${this.apiTimeout + 1} and ${this.pollInterval1Max} seconds.`;
			this.log.error(message);
			this.terminate(message, utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			return;
		}

		if (
			!Number.isInteger(this.pollInterval2) ||
			this.pollInterval2 < this.pollInterval1 + this.apiTimeout ||
			this.pollInterval2 > this.pollInterval2Max
		) {
			const message = `Slow polling interval must be between ${this.pollInterval1 + this.apiTimeout} and ${this.pollInterval2Max} seconds.`;
			this.log.error(message);
			this.terminate(message, utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			return;
		}

		const configuredDevices = this.readDeviceConfiguration();
		if (configuredDevices.length > MAX_DEVICE_TREES) {
			const message = `A maximum of ${MAX_DEVICE_TREES} Mill devices can be configured.`;
			this.log.error(message);
			this.terminate(message, utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			return;
		}

		this.configuredDeviceHosts = new Set(configuredDevices.map(device => device.host.toLowerCase()));
		if (configuredDevices.length === 0) {
			const message = "At least one Mill device must be configured.";
			this.log.error(message);
			this.terminate(message, utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			return;
		}

		await this.createInstanceInfoObjects();
		await this.setExistingDeviceTreesOffline();
		this.subscribeStates("*");

		this.log.info("Configuration loaded.");
		this.log.info(`HTTP timeout: ${this.apiTimeout}`);
		this.log.info(`Polling interval 1: ${this.pollInterval1} seconds`);
		this.log.info(`Polling interval 2: ${this.pollInterval2} seconds`);
		this.log.info(`${configuredDevices.length} Mill device(s) configured.`);

		const callbacks: MillHeaterDeviceCallbacks = {
			onIdentified: (device, deviceId, previousDeviceId) =>
				this.onDeviceIdentified(device, deviceId, previousDeviceId),
			createObjects: device => this.createDeviceObjects(device),
			onConnectionChanged: () => this.updateInstanceConnectionState(),
		};

		for (const config of configuredDevices) {
			this.devices.push(
				new MillHeaterDevice(this, config, callbacks, this.apiTimeout, this.pollInterval1, this.pollInterval2),
			);
		}

		// Start all devices independently. A failed or slow device must not
		// prevent the other configured devices from initializing.
		await Promise.all(
			this.devices.map(async device => {
				try {
					await device.start();
				} catch (error) {
					this.log.error(
						`Failed to start Mill device ${device.userDefinedName} (${device.configuredHost}): ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}),
		);
	}

	/** Read and validate the configured device table. */
	private readDeviceConfiguration(): ConfiguredMillDevice[] {
		const configured = this.config.devices;
		const result: ConfiguredMillDevice[] = [];
		const configuredHosts = new Set<string>();

		if (Array.isArray(configured)) {
			for (let index = 0; index < configured.length; index++) {
				const entry: unknown = configured[index];
				if (!entry || typeof entry !== "object") {
					this.log.warn(`Ignoring invalid Mill device entry at position ${index + 1}.`);
					continue;
				}

				const candidate = entry as Record<string, unknown>;
				const host = typeof candidate.host === "string" ? candidate.host.trim() : "";
				if (!host || /\s/.test(host) || /^https?:\/\//i.test(host)) {
					this.log.warn(`Ignoring Mill device entry ${index + 1}: invalid IP address or hostname.`);
					continue;
				}

				const hostKey = host.toLowerCase();
				if (configuredHosts.has(hostKey)) {
					this.log.warn(`Ignoring duplicate Mill device host: ${host}.`);
					continue;
				}
				configuredHosts.add(hostKey);

				// Keep existing adapter configurations working after the config field was renamed.
				let userDefinedName = "";
				if (typeof candidate.userDefinedName === "string") {
					userDefinedName = candidate.userDefinedName.trim();
				} else if (typeof candidate.name === "string") {
					userDefinedName = candidate.name.trim();
				}

				result.push({
					userDefinedName,
					host,
					pollWhenOff: candidate.pollWhenOff !== false,
				});
			}
		}

		return result;
	}

	/** Create the adapter-level information channel and aggregate connection state. */
	private async createInstanceInfoObjects(): Promise<void> {
		await this.setObjectNotExists("info", {
			type: "channel",
			common: { name: "Information" },
			native: {},
		});
		await this.setObjectNotExists("info.connection", {
			type: "state",
			common: {
				name: {
					en: "Devices connected",
					de: "Geräte verbunden",
					ru: "Приборы подключены",
					pt: "Dispositivos conectados",
					nl: "Apparaten verbonden",
					fr: "Appareils connectés",
					it: "Dispositivi connessi",
					es: "Dispositivos conectados",
					pl: "Urządzenia połączone",
					uk: "Пристрої підключені",
					"zh-cn": "设备已连接",
				},
				type: "boolean",
				role: "indicator.connected",
				read: true,
				write: false,
			},
			native: {},
		});
		// Use setState because startup must wait until the initial offline state has been written.
		// setStateChanged does not return a Promise that can be awaited.
		await this.setState("info.connection", false, true);
	}

	/**
	 * Creates the device object tree and its state metadata.
	 *
	 * @param device - The Mill heater device whose objects are created.
	 */
	private async createDeviceObjects(device: MillHeaterDevice): Promise<void> {
		const deviceId = device.id;
		if (!deviceId) {
			throw new Error("Cannot create device objects before the MAC address has been registered.");
		}

		await this.deviceTreeCleanupMutex.runExclusive(async () => {
			const deviceIds = await this.getDeviceTreeRows();

			// Only a genuinely new MAC-based device tree requires another slot.
			if (!deviceIds.includes(deviceId.toLowerCase())) {
				await this.cleanupDeviceTreesLocked(deviceIds, 1);

				const remainingDeviceIds = await this.getDeviceTreeRows();
				if (remainingDeviceIds.length >= MAX_DEVICE_TREES) {
					throw new Error(
						`Cannot create device tree for ${deviceId}: the limit of ${MAX_DEVICE_TREES} device trees has been reached and no historical tree can safely be removed.`,
					);
				}
			}

			await this.setObjectNotExists(deviceId, {
				type: "device",
				common: {
					name: device.userDefinedName,
					statusStates: {
						onlineId: "info.connection",
					},
				},
				native: {
					host: device.configuredHost,
					retiredAt: 0,
				},
			});

			// Also reactivate an existing tree when its MAC address returns.
			await this.extendObject(deviceId, {
				common: { name: device.userDefinedName },
				native: {
					host: device.configuredHost,
					retiredAt: 0,
				},
			});

			for (const [id, name] of DEVICE_CHANNELS) {
				await this.setObjectNotExists(`${deviceId}.${id}`, {
					type: "channel",
					common: { name },
					native: {},
				});
			}

			for (const state of DEVICE_STATES) {
				if (!device.isStateSupported(state.id)) {
					continue;
				}

				await this.setObjectNotExists(`${deviceId}.${state.id}`, {
					type: "state",
					common: state.common,
					native: {},
				});
			}

			// A new MAC starts offline until its status has been successfully processed.
			this.setStateChanged(`${deviceId}.info.connection`, false, true);
		});
	}

	/**
	 * Remove the oldest historical device trees if the configured limit would be exceeded.
	 *
	 * Must be called while holding deviceTreeCleanupMutex.
	 *
	 * @param deviceIds - Existing MAC-based device IDs.
	 * @param additionalTrees - Number of additional trees that need capacity.
	 * @returns Number of deleted device trees.
	 */
	private async cleanupDeviceTreesLocked(deviceIds: string[], additionalTrees = 0): Promise<number> {
		const excess = deviceIds.length + additionalTrees - MAX_DEVICE_TREES;
		if (excess <= 0) {
			return 0;
		}

		const candidates: Array<{ id: string; retiredAt: number }> = [];

		for (const deviceId of deviceIds) {
			// Never consider a device currently assigned to a running device instance.
			if (this.devicesById.has(deviceId)) {
				continue;
			}

			const object = await this.getObjectAsync(deviceId);
			if (!object) {
				continue;
			}

			const native = typeof object.native === "object" ? (object.native as Record<string, unknown>) : {};
			const retiredAt =
				typeof native.retiredAt === "number" && Number.isFinite(native.retiredAt) ? native.retiredAt : 0;
			const host = typeof native.host === "string" ? native.host.trim().toLowerCase() : "";

			// Only explicitly retired trees can be deleted.
			if (retiredAt <= 0) {
				continue;
			}

			// A tree belonging to a currently configured host is protected.
			if (host && this.configuredDeviceHosts.has(host)) {
				continue;
			}

			candidates.push({ id: deviceId, retiredAt });
		}

		// Oldest retired trees first.
		candidates.sort((a, b) => a.retiredAt - b.retiredAt);

		const toDelete = candidates.slice(0, excess);

		for (const candidate of toDelete) {
			await this.delObjectAsync(candidate.id, { recursive: true });
			this.log.info(`Removed historical Mill device tree ${candidate.id}.`);
		}

		if (toDelete.length < excess) {
			this.log.warn(
				`Device tree limit of ${MAX_DEVICE_TREES} cannot be reached: ${excess - toDelete.length} additional tree(s) could not be removed because no safe historical candidates were available. Active device trees were preserved.`,
			);
		}

		return toDelete.length;
	}

	/** Return all MAC-based device roots belonging to this adapter instance. */
	private async getDeviceTreeRows(): Promise<string[]> {
		const namespacePrefix = `${this.namespace}.`;
		const result = await this.getObjectViewAsync("system", "device", {
			startkey: namespacePrefix,
			endkey: `${namespacePrefix}\u9999`,
		});

		return result.rows
			.map(row => row.id)
			.filter(
				(id): id is string =>
					typeof id === "string" &&
					id.startsWith(namespacePrefix) &&
					/^[0-9a-f]{12}$/i.test(id.slice(namespacePrefix.length)),
			)
			.map(id => id.slice(namespacePrefix.length).toLowerCase());
	}

	/** Set every previously created MAC-based device tree offline at adapter startup. */
	private async setExistingDeviceTreesOffline(): Promise<void> {
		try {
			await this.deviceTreeCleanupMutex.runExclusive(async () => {
				const deviceIds = await this.getDeviceTreeRows();
				const offlineWrites: Promise<void>[] = [];

				for (const deviceId of deviceIds) {
					const object = await this.getObjectAsync(deviceId);

					if (object) {
						const native =
							typeof object.native === "object" ? (object.native as Record<string, unknown>) : {};
						const host = typeof native.host === "string" ? native.host.trim().toLowerCase() : "";
						const currentRetiredAt =
							typeof native.retiredAt === "number" && Number.isFinite(native.retiredAt)
								? native.retiredAt
								: 0;

						if (host && this.configuredDeviceHosts.has(host)) {
							if (currentRetiredAt !== 0) {
								await this.extendObject(deviceId, {
									native: { retiredAt: 0 },
								});
							}
						} else {
							// Legacy trees without retirement information are treated as oldest.
							const retiredAt = currentRetiredAt > 0 ? currentRetiredAt : 1;

							if (host || currentRetiredAt <= 0) {
								await this.extendObject(deviceId, {
									native: {
										host: "",
										retiredAt,
									},
								});
							}
						}
					}

					// Use setState because its Promise can be awaited.
					offlineWrites.push(
						this.setState(`${deviceId}.info.connection`, false, true)
							.then(() => undefined)
							.catch(error => {
								this.log.warn(
									`Could not set existing Mill device ${deviceId} offline: ${error instanceof Error ? error.message : String(error)}`,
								);
							}),
					);
				}

				await Promise.all(offlineWrites);

				// Remove excess historical trees, but never active trees.
				await this.cleanupDeviceTreesLocked(deviceIds);
			});
		} catch (error) {
			this.log.warn(
				`Could not set existing Mill device trees offline: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Registers the device ID based on its MAC address and handles physical device replacement.
	 *
	 * @param device - The Mill heater device that was identified.
	 * @param deviceId - The newly identified device ID.
	 * @param previousDeviceId - The previously registered device ID, if available.
	 * @returns Whether the device was successfully identified.
	 */
	private async onDeviceIdentified(
		device: MillHeaterDevice,
		deviceId: string,
		previousDeviceId: string | undefined,
	): Promise<boolean> {
		const normalizedDeviceId = deviceId.toLowerCase();

		// Stop API requests and wait for any pending requests to finish.
		if (previousDeviceId && previousDeviceId.toLowerCase() !== normalizedDeviceId) {
			await device.pauseApiRequests();
		}

		const currentOwner = this.devicesById.get(normalizedDeviceId);
		if (currentOwner && currentOwner !== device) {
			this.log.error(
				`MAC address ${normalizedDeviceId} is already assigned to ${currentOwner.userDefinedName} (${currentOwner.configuredHost}); refusing duplicate device ${device.userDefinedName} (${device.configuredHost}).`,
			);
			// If this device had a previous identity, it is no longer active either.
			if (previousDeviceId && previousDeviceId.toLowerCase() !== normalizedDeviceId) {
				// Use setState because its Promise can be awaited to ensure the old device is marked offline
				// before the MAC mapping is changed. setStateChanged does not provide an awaitable Promise here.
				await this.setState(`${previousDeviceId}.info.connection`, false, true);
				await this.extendObject(previousDeviceId, {
					native: {
						host: "",
						retiredAt: Date.now(),
					},
				});
				if (this.devicesById.get(previousDeviceId.toLowerCase()) === device) {
					this.devicesById.delete(previousDeviceId.toLowerCase());
				}
			}
			return false;
		}

		// Keep the old tree and its values, mark it offline and remove its write routing.
		if (previousDeviceId && previousDeviceId.toLowerCase() !== normalizedDeviceId) {
			const oldConnectionStateId = `${previousDeviceId}.info.connection`;
			this.log.debug(`MAC change: setting ${oldConnectionStateId} to false.`);

			// Keep the old tree and all its values, but mark it offline and stop routing writes to it.
			// Use setState because its Promise can be awaited to ensure the old device is marked offline
			// before the MAC mapping is changed. setStateChanged does not provide an awaitable Promise here.
			await this.setState(oldConnectionStateId, false, true);
			this.log.debug(`MAC change: setState completed for ${oldConnectionStateId}.`);

			// Remove the old host mapping to prevent restoring the obsolete MAC on the next start.
			await this.extendObject(previousDeviceId, {
				native: {
					host: "",
					retiredAt: Date.now(),
				},
			});
			this.log.debug(`MAC change: extendObject completed for ${previousDeviceId}.`);
			if (this.devicesById.get(previousDeviceId.toLowerCase()) === device) {
				this.devicesById.delete(previousDeviceId.toLowerCase());
			}
		}

		this.devicesById.set(normalizedDeviceId, device);
		return true;
	}

	/** Update adapter-level connection state: true when at least one configured device is connected. */
	private updateInstanceConnectionState(): void {
		if (this.isUnloading) {
			return;
		}

		const connected = this.devices.some(device => device.isConnected);
		this.log.debug(
			`Adapter connection state: ${connected}; devices: ${this.devices.map(device => `${device.name}=${device.isConnected}`).join(", ")}.`,
		);
		this.setStateChanged("info.connection", connected, true);
	}

	/**
	 * Routes state changes from MAC-based device state IDs to the corresponding device object.
	 *
	 * @param id - The state ID that changed.
	 * @param state - The new state value, or `null`/`undefined` if unavailable.
	 */
	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (state && id.endsWith(".info.connection")) {
			this.log.debug(`Connection state update: ${id} = ${String(state.val)} (ack: ${state.ack})`);
		}
		if (!state || state.ack !== false || this.isUnloading) {
			return;
		}

		const namespacePrefix = `${this.namespace}.`;
		if (!id.startsWith(namespacePrefix)) {
			return;
		}

		const relativeId = id.slice(namespacePrefix.length);
		const separator = relativeId.indexOf(".");
		if (separator <= 0) {
			return;
		}

		const deviceId = relativeId.slice(0, separator).toLowerCase();
		const stateId = relativeId.slice(separator + 1);
		const device = this.devicesById.get(deviceId);
		if (!device) {
			this.log.debug(`Ignoring command for unknown Mill device ${deviceId}: ${stateId}.`);
			return;
		}

		void device.handleStateChange(stateId, state).catch(error => {
			this.log.error(
				`Failed to handle state change ${id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	/**
	 * Stops all devices and waits until their API mutexes have been released.
	 *
	 * @param callback - The callback to invoke once unloading is complete.
	 */
	private onUnload(callback: () => void): void {
		if (this.isUnloading) {
			callback();
			return;
		}

		this.isUnloading = true;
		this.log.info("Mill Heater Adapter is shutting down.");

		void Promise.allSettled(this.devices.map(device => device.unload())).then(results => {
			for (const result of results) {
				if (result.status === "rejected") {
					this.log.error(
						`Error while stopping a Mill device: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
					);
				}
			}
			// Reset the adapter-level connection state before completing shutdown.
			// Use setState so shutdown waits for the offline state to be written before calling the callback.
			// setStateChanged does not return a Promise that can be awaited.
			void this.setState("info.connection", false, true)
				.catch(error => {
					this.log.error(
						`Could not reset adapter connection state: ${error instanceof Error ? error.message : String(error)}`,
					);
				})
				.finally(callback);
		});
	}
}

if (require.main !== module) {
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Millheater(options);
} else {
	(() => new Millheater())();
}
