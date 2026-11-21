/**
 * Handles the local API communication and polling for one Mill device.
 *
 * Each instance owns its API mutex, connection state and polling timers.
 */

import * as http from "node:http";
import { E_ALREADY_LOCKED, E_CANCELED, Mutex, tryAcquire } from "async-mutex";
import { sanitizeLogMessage } from "./utils";

/**
 * Configuration settings for a Mill heater device.
 */
export interface MillHeaterDeviceConfig {
	/** Optional user defined device name for identification in the adapter. */
	userDefinedName?: string;
	/** IP address or hostname of the Mill heater. */
	host: string;
	/** Whether polling should continue while the heater is switched off. */
	pollWhenOff: boolean;
}

/**
 * Status information returned by the Mill /status endpoint.
 */
export interface HeaterStatus {
	/** Device name reported by the heater. */
	modelName: string | undefined;
	/** Custom name assigned to the heater. */
	customName: string | undefined;
	/** Firmware version of the heater. */
	version: string | undefined;
	/** Current operation key reported by the heater. */
	operationKey: string | undefined;
	/** MAC address of the heater's network interface. */
	macAddress: string | undefined;
}

/** Functions provided by the adapter for managing the device object tree. */
export interface MillHeaterDeviceCallbacks {
	/** Registers the MAC-based ID and handles duplicate IDs or an ID change. */
	onIdentified: (
		device: MillHeaterDevice,
		deviceId: string,
		previousDeviceId: string | undefined,
	) => Promise<boolean>;
	/** Creates or updates this device's ioBroker object tree. */
	createObjects: (device: MillHeaterDevice) => Promise<void>;
	/** Updates the aggregate instance connection state. */
	onConnectionChanged: (device: MillHeaterDevice) => void;
}

/**
 * Normalizes a MAC address to a stable ioBroker object ID.
 *
 * @param macAddress macAddress to normalize
 */
export function normalizeMacAddress(macAddress: string): string | undefined {
	const normalized = macAddress.replace(/[:-]/g, "").trim().toLowerCase();
	return /^[0-9a-f]{12}$/.test(normalized) ? normalized : undefined;
}

/** Supported Mill device types. */
export enum MillDeviceType {
	Oil = "Oil",
	Panel = "Panel",
	WiFiSocket = "Wi-Fi Socket",
	Convection = "Convection",
	Unknown = "Unknown",
}

/**
 * Determines the supported Mill device type from the API model name.
 *
 * @param modelName API model name
 */
export function detectDeviceType(modelName: string | undefined): MillDeviceType {
	const normalized = modelName?.toLowerCase() ?? "";

	if (normalized.includes("oil")) {
		return MillDeviceType.Oil;
	}
	if (normalized.includes("panel")) {
		return MillDeviceType.Panel;
	}
	if (normalized.includes("socket")) {
		return MillDeviceType.WiFiSocket;
	}
	if (normalized.includes("convection")) {
		return MillDeviceType.Convection;
	}

	return MillDeviceType.Unknown;
}

/**
 * Represents a single Mill heater device and manages its API communication,
 * polling intervals and state updates.
 */
export class MillHeaterDevice {
	/** Device types required by model-specific states; all other states are shared by every model. */
	private static readonly DEVICE_STATE_TYPES: Partial<Record<string, MillDeviceType>> = {
		"settings.additional_mode": MillDeviceType.WiFiSocket,
		"settings.heating_level_percentage": MillDeviceType.Oil,
		"settings.limited_heating_power": MillDeviceType.Panel,
	};
	private static readonly MAX_API_RESPONSE_SIZE = 1024 * 1024;
	private readonly apiMutex = new Mutex();
	private readonly apiTimeout: number;
	private readonly host: string;
	private readonly pollInterval1: number;
	private readonly pollInterval2: number;
	private readonly pollWhenOff: boolean;

	private apiConnected: boolean | undefined;
	private apiRequestsPaused = false;
	private deviceId: string | undefined;
	private isUnloading = false;
	private isDisabled = false;
	private isInitialized = false;
	private isObjectsCreated = false;
	private modelName = "";
	private pollingSuspended = false;

	private discoveryRetryTimer: ioBroker.Timeout | undefined;
	private updateFastDataTimer: ioBroker.Timeout | undefined;
	private updateSlowDataTimer: ioBroker.Timeout | undefined;

	public readonly userDefinedName: string;

	/**
	 * Creates a Mill heater device instance with its configuration and callbacks.
	 *
	 * @param adapter - The ioBroker adapter instance.
	 * @param config - The device configuration.
	 * @param callbacks - Callbacks used to communicate with the adapter.
	 * @param apiTimeout - API request timeout in seconds.
	 * @param pollInterval1 - Fast polling interval in seconds.
	 * @param pollInterval2 - Slow polling interval in seconds.
	 */
	public constructor(
		private readonly adapter: ioBroker.Adapter,
		config: MillHeaterDeviceConfig,
		private readonly callbacks: MillHeaterDeviceCallbacks,
		apiTimeout: number,
		pollInterval1: number,
		pollInterval2: number,
	) {
		this.host = config.host.trim();
		//falling back to the host
		this.userDefinedName = config.userDefinedName?.trim() || this.host;
		this.pollWhenOff = config.pollWhenOff !== false;
		this.apiTimeout = apiTimeout;
		this.pollInterval1 = pollInterval1;
		this.pollInterval2 = pollInterval2;
	}

	/** MAC-based device ID, once it has been identified. */
	public get id(): string | undefined {
		return this.deviceId;
	}

	/** Current API reachability, independent of whether the heater is switched on. */
	public get isConnected(): boolean {
		return this.apiConnected === true;
	}

	/** Configured host, either an IP address or a hostname. */
	public get configuredHost(): string {
		return this.host;
	}

	/** User defined display name. */
	public get name(): string {
		return this.userDefinedName;
	}

	/**
	 * Checks whether a state belongs to the model of this device.
	 * Unrestricted states are supported by every model.
	 *
	 * @param stateId - State ID relative to the device root.
	 */
	public isStateSupported(stateId: string): boolean {
		const requiredType = MillHeaterDevice.DEVICE_STATE_TYPES[stateId];
		return requiredType === undefined || detectDeviceType(this.modelName) === requiredType;
	}

	/** Starts the device by reading its status before creating its object tree. */
	public async start(): Promise<void> {
		await this.tryInitialize();
	}

	/** Stops polling, pending discovery retries, API requests and resets connection status. */
	public async unload(): Promise<void> {
		this.isUnloading = true;
		this.stopPolling();

		if (this.discoveryRetryTimer !== undefined) {
			this.adapter.clearTimeout(this.discoveryRetryTimer);
			this.discoveryRetryTimer = undefined;
		}

		this.apiMutex.cancel();
		await this.apiMutex.waitForUnlock();
		if (this.deviceId) {
			this.adapter.setStateChanged(`${this.deviceId}.info.connection`, false, true);
		}
	}

	/**
	 * Handles a state change and routes write operations to this device.
	 * The state ID is relative to the device root.
	 *
	 * @param id - State ID relative to the device root.
	 * @param state - New state value and metadata.
	 * @returns A promise that resolves when the state change has been handled.
	 */
	public async handleStateChange(id: string, state: ioBroker.State): Promise<void> {
		if (this.isUnloading || this.isDisabled || state.ack !== false) {
			return;
		}

		if (!this.isStateSupported(id)) {
			this.adapter.log.warn(
				`Ignoring write to ${this.getStateId(id)}: not supported by ${detectDeviceType(this.modelName)} devices.`,
			);

			// Reset the unsupported state and acknowledge the write.
			await this.adapter.setState(this.getStateId(id), null, true);
			return;
		}

		switch (id) {
			case "control-status.operation_mode":
				if (typeof state.val === "string") {
					await this.setOperationMode(state.val);
				} else {
					this.adapter.log.warn(`Invalid value for ${this.getStateId(id)}: expected a string.`);
				}
				break;

			case "control-status.set_temperature":
				if (typeof state.val === "number") {
					await this.setTemperature(state.val);
				} else {
					this.adapter.log.warn(`Invalid value for ${this.getStateId(id)}: expected a number.`);
				}
				break;

			case "settings.additional_mode":
				if (typeof state.val === "number") {
					await this.setAdditionalMode(state.val);
				} else {
					this.adapter.log.warn(`Invalid value for ${this.getStateId(id)}: expected a number.`);
				}
				break;

			case "settings.heating_level_percentage":
				if (typeof state.val === "number") {
					await this.setHeatingLevelPercentage(state.val);
				} else {
					this.adapter.log.warn(`Invalid value for ${this.getStateId(id)}: expected a number.`);
				}
				break;

			case "settings.limited_heating_power":
				if (typeof state.val === "number") {
					await this.setLimitedHeatingPower(state.val);
				} else {
					this.adapter.log.warn(`Invalid value for ${this.getStateId(id)}: expected a number.`);
				}
				break;

			case "settings.temperature_calibration_offset":
				if (typeof state.val === "number") {
					await this.setTemperatureCalibrationOffset(state.val);
				} else {
					this.adapter.log.warn(`Invalid value for ${this.getStateId(id)}: expected a number.`);
				}
				break;

			default:
				this.adapter.log.debug(`Unsupported command for ${this.getStateId(id)}: ${String(state.val)}`);
				break;
		}
	}

	/**
	 * Pauses new API requests and waits for already queued or running requests to finish.
	 */
	public async pauseApiRequests(): Promise<void> {
		this.apiRequestsPaused = true;

		// Wait until all API requests queued before the pause have finished.
		await this.apiMutex.runExclusive(() => undefined);
	}

	/**
	 * Resumes API requests after the device identity change is complete.
	 */
	public resumeApiRequests(): void {
		this.apiRequestsPaused = false;
	}

	private getStateId(id: string): string {
		if (!this.deviceId) {
			throw new Error("Cannot access a device state before the device has been identified.");
		}
		return `${this.deviceId}.${id}`;
	}

	private setStateChanged(id: string, value: ioBroker.StateValue): void {
		if (!this.deviceId || this.isUnloading) {
			return;
		}
		void this.adapter.setStateChanged(`${this.deviceId}.${id}`, value, true);
	}

	private async tryInitialize(): Promise<void> {
		if (this.isUnloading || this.isDisabled || this.isInitialized) {
			return;
		}

		const status = await this.getStatus();
		if (!status || !(await this.processStatus(status))) {
			this.scheduleDiscoveryRetry();
			return;
		}

		await this.getTemperatureCalibrationOffset();
		await this.updateFastData();
		this.isInitialized = true;
		this.startPolling();
		this.adapter.log.info(`Mill device ${this.userDefinedName} (${this.deviceId}) initialized at ${this.host}.`);
	}

	private scheduleDiscoveryRetry(): void {
		if (this.isUnloading || this.isDisabled || this.isInitialized || this.discoveryRetryTimer !== undefined) {
			return;
		}

		this.discoveryRetryTimer = this.adapter.setTimeout(() => {
			this.discoveryRetryTimer = undefined;
			void this.tryInitialize().catch(error => {
				this.adapter.log.error(
					`Device initialization failed for ${this.host}: ${error instanceof Error ? error.message : String(error)}`,
				);
				this.scheduleDiscoveryRetry();
			});
		}, this.pollInterval1 * 1000);
	}

	private async acceptMacAddress(macAddress: string): Promise<boolean> {
		const newDeviceId = normalizeMacAddress(macAddress);
		if (!newDeviceId) {
			this.adapter.log.warn(`Invalid MAC address reported by ${this.host}: ${macAddress}`);
			// An already initialized device keeps its identity until a valid replacement MAC is reported.
			return this.isObjectsCreated && this.deviceId !== undefined;
		}

		if (this.deviceId === newDeviceId && this.isObjectsCreated) {
			return true;
		}

		const previousDeviceId = this.deviceId;
		const accepted = await this.callbacks.onIdentified(this, newDeviceId, previousDeviceId);
		if (!accepted) {
			this.disable(`MAC address ${macAddress} is already assigned to another configured device.`);
			return false;
		}

		this.deviceId = newDeviceId;
		// The new MAC needs its own object tree, which is only considered created after successful setup.
		this.isObjectsCreated = false;
		await this.callbacks.createObjects(this);
		this.isObjectsCreated = true;

		// Resume API requests after the device identity and object tree are ready.
		this.resumeApiRequests();

		this.adapter.log.info(
			previousDeviceId && previousDeviceId !== newDeviceId
				? `Mill device at ${this.host} changed MAC address: ${previousDeviceId} -> ${newDeviceId}.`
				: `Mill device ${this.userDefinedName} identified with MAC address ${macAddress}.`,
		);
		return true;
	}

	private disable(reason: string): void {
		this.isDisabled = true;
		this.stopPolling();
		if (this.apiConnected !== false) {
			this.updateApiConnectionState(false);
		}
		this.adapter.log.error(`Mill device ${this.userDefinedName} (${this.host}) disabled: ${reason}`);
	}

	private updateInfoStates(): void {
		if (!this.deviceId) {
			return;
		}

		const values: Array<[string, ioBroker.StateValue | undefined]> = [
			["info.name", this.userDefinedName],
			["info.host", this.host],
			["info.deviceType", this.modelName ? detectDeviceType(this.modelName) : undefined],
		];

		for (const [id, value] of values) {
			if (value !== undefined) {
				this.setStateChanged(id, value);
			}
		}
	}

	private updateApiConnectionState(connected: boolean, path?: string, error?: Error): void {
		// Prevent late API responses from re-enabling a disabled or unloading device.
		if (connected && (this.isDisabled || this.isUnloading)) {
			return;
		}
		const previousState = this.apiConnected;

		this.setStateChanged("info.connection", connected);

		if (previousState === connected) {
			if (!connected && error) {
				this.adapter.log.debug(
					`Mill API request${path ? ` for ${path}` : ""} at ${this.host} failed: ${error.message}`,
				);
			}
			return;
		}

		this.apiConnected = connected;
		this.callbacks.onConnectionChanged(this);

		if (connected) {
			this.adapter.log.info(
				previousState === false
					? `Mill device ${this.userDefinedName} connection restored.`
					: `HTTP connection established with ${this.userDefinedName}.`,
			);
			return;
		}

		const reason = error ? `${path ? `${path}: ` : ""}${error.message}` : "Unknown error";
		this.adapter.log.warn(
			`${previousState === true ? "Mill device connection lost" : "Mill device is not reachable"} (${this.userDefinedName}, ${this.host}): ${reason}`,
		);
	}

	/**
	 * normal api request
	 * uses a Mutex
	 *
	 * @param path API endpoint.
	 * @param skipIfBusy GET request is skippable.
	 * @param method HTTP method.
	 * @param body JSON request body.
	 */
	private async callApi(
		path: string,
		skipIfBusy = false,
		method: "GET" | "POST" = "GET",
		body?: unknown,
	): Promise<Record<string, unknown> | undefined> {
		if (this.isUnloading || this.isDisabled || this.apiRequestsPaused) {
			return undefined;
		}
		if (skipIfBusy && method !== "GET") {
			throw new Error("The skip option is only supported for GET requests.");
		}

		try {
			const result = skipIfBusy
				? await tryAcquire(this.apiMutex).runExclusive(() => this.performApiRequest(path, method, body))
				: await this.apiMutex.runExclusive(() => this.performApiRequest(path, method, body));
			this.adapter.log.debug(`API response for ${this.host} "${path}": ${JSON.stringify(result)}`);
			return result;
		} catch (error) {
			if (error === E_ALREADY_LOCKED) {
				this.adapter.log.debug(
					`Skipping API request ${method} ${path} for ${this.host}: another request is running.`,
				);
				return undefined;
			}
			// isUnloading may change while an asynchronous request is running.
			/* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition */
			if (error === E_CANCELED && this.isUnloading) {
				this.adapter.log.debug(`Canceled API request ${method} ${path} for ${this.host} during shutdown.`);
				return undefined;
			}
			this.adapter.log.error(
				`Error executing API request ${method} ${path} for ${this.host}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	private async performApiRequest(
		path: string,
		method: "GET" | "POST" = "GET",
		body?: unknown,
	): Promise<Record<string, unknown> | undefined> {
		const url = `http://${this.host}${path}`;
		const headers: http.OutgoingHttpHeaders = {};
		const jsonBody = body !== undefined ? JSON.stringify(body) : undefined;
		if (jsonBody !== undefined) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = Buffer.byteLength(jsonBody);
		}

		this.adapter.log.debug(
			`Request: ${method} ${url}, Header: ${JSON.stringify(headers)}, Request body: ${jsonBody}`,
		);

		return new Promise(resolve => {
			let settled = false;

			const request = http.request(url, { method, headers });

			const totalTimeout = this.adapter.setTimeout(() => {
				request.destroy(new Error(`Total timeout calling ${path}.`));
			}, this.apiTimeout * 1000);

			const finish = (result: Record<string, unknown> | undefined): void => {
				if (settled) {
					return;
				}
				settled = true;
				this.adapter.clearTimeout(totalTimeout);
				resolve(result);
			};

			const handleRequestError = (error: Error): void => {
				if (settled) {
					return;
				}
				this.updateApiConnectionState(false, path, error);
				finish(undefined);
			};

			request.on("response", response => {
				let data = "";
				let receivedBytes = 0;

				response.on("data", chunk => {
					receivedBytes += chunk.length;
					// CWE-770 - Allocation of Resources Without Limits
					if (receivedBytes > MillHeaterDevice.MAX_API_RESPONSE_SIZE) {
						response.destroy(
							new Error(
								`API response from ${path} exceeds the maximum size of ${MillHeaterDevice.MAX_API_RESPONSE_SIZE} bytes.`,
							),
						);
						return;
					}
					data += chunk.toString("utf8");
				});

				response.on("error", handleRequestError);

				response.on("end", () => {
					if (settled) {
						return;
					}
					const statusCode = response.statusCode;
					this.adapter.log.debug(`HTTP status for ${path} at ${this.host}: ${statusCode ?? "undefined"}`);

					// A /status response only confirms a Mill device connection after its
					// model and MAC address have been validated and accepted in processStatus().
					if (path !== "/status" && this.deviceId && this.isObjectsCreated) {
						// For identified devices, an HTTP response confirms API reachability.
						this.updateApiConnectionState(true);
					}

					if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
						this.adapter.log.error(
							`Mill API request failed for ${path} at ${this.host}: HTTP ${statusCode ?? "unknown"}.`,
						);
						if (data.trim()) {
							this.adapter.log.error(
								`Mill API response from ${sanitizeLogMessage(this.host)}: ${sanitizeLogMessage(data)}`,
							);
						}
						finish(undefined);
						return;
					}

					if (!data.trim()) {
						this.adapter.log.error(`Empty response from ${path} at ${this.host}.`);
						finish(undefined);
						return;
					}

					try {
						const parsed: unknown = JSON.parse(data);
						if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
							this.adapter.log.error(
								`Invalid API response from ${path} at ${this.host}: response is not an object.`,
							);
							finish(undefined);
							return;
						}

						const dataRecord = parsed as Record<string, unknown>;
						if (dataRecord.status !== "ok") {
							this.adapter.log.error(
								`Mill API rejected request to ${path} at ${this.host}: status=${String(dataRecord.status)}.`,
							);
							finish(undefined);
							return;
						}

						finish(dataRecord);
					} catch (error) {
						this.adapter.log.error(
							`Invalid JSON response from ${path} at ${this.host}: ${error instanceof Error ? error.message : String(error)}`,
						);
						finish(undefined);
					}
				});
			});

			request.on("error", handleRequestError);
			request.setTimeout(this.apiTimeout * 1000, () => {
				request.destroy(new Error(`Timeout calling ${path}.`));
			});

			if (jsonBody !== undefined) {
				request.write(jsonBody);
			}
			request.end();
		});
	}

	private async getStatus(skipIfBusy = false): Promise<HeaterStatus | undefined> {
		this.adapter.log.debug(`getStatus started for ${this.host}.`);
		const data = await this.callApi("/status", skipIfBusy);
		if (!data) {
			return undefined;
		}

		return {
			modelName: typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined,
			customName: typeof data.custom_name === "string" ? data.custom_name : undefined,
			version: typeof data.version === "string" ? data.version : undefined,
			operationKey: typeof data.operation_key === "string" ? data.operation_key : undefined,
			macAddress:
				typeof data.mac_address === "string" && data.mac_address.trim() !== ""
					? data.mac_address.trim()
					: undefined,
		};
	}

	/**
	 * Processes a status response after validating its model name and MAC address.
	 * Registers the device and updates its status and information states.
	 *
	 * @param status - Status response returned by the Mill API.
	 * @returns Whether the status response was successfully processed.
	 */
	private async processStatus(status: HeaterStatus): Promise<boolean> {
		if (!status.modelName || !status.macAddress || !normalizeMacAddress(status.macAddress)) {
			this.adapter.log.debug(
				`Mill status response from ${this.host} does not contain a valid model name and MAC address; initialization will be retried.`,
			);
			return false;
		}

		this.modelName = status.modelName;
		const accepted = await this.acceptMacAddress(status.macAddress);
		if (!accepted || !this.deviceId || !this.isObjectsCreated) {
			return false;
		}

		this.writeStatus(status);
		this.updateInfoStates();
		// The device is now identified, its MAC is uniquely assigned, and its object tree exists.
		this.updateApiConnectionState(true);
		return true;
	}

	private writeStatus(status: HeaterStatus): void {
		const values: Array<[string, ioBroker.StateValue | undefined]> = [
			["status.name", status.modelName],
			["status.custom_name", status.customName],
			["status.version", status.version],
			["status.operation_key", status.operationKey],
			["status.mac_address", status.macAddress],
		];

		for (const [id, value] of values) {
			if (value !== undefined) {
				this.setStateChanged(id, value);
			}
		}
	}

	private async updateFastData(isPolling = false): Promise<void> {
		try {
			if (!this.modelName) {
				const status = await this.getStatus(isPolling);
				if (status) {
					await this.processStatus(status);
				}
			}
			await this.getControlStatus(isPolling);
			// Stop the current update cycle if polling was suspended because the device has operation mode Off.
			if (this.pollingSuspended) {
				return;
			}
			switch (detectDeviceType(this.modelName)) {
				case MillDeviceType.Oil:
					await this.getHeatingLevelPercentage(isPolling);
					break;
				case MillDeviceType.Panel:
					await this.getLimitedHeatingPower(isPolling);
					break;
				case MillDeviceType.WiFiSocket:
					await this.getAdditionalMode(isPolling);
					break;
				case MillDeviceType.Convection:
				case MillDeviceType.Unknown:
					break;
			}
		} finally {
			if (isPolling && !this.isUnloading && !this.isDisabled && !this.pollingSuspended) {
				this.scheduleFastPolling();
			}
		}
	}

	private async updateSlowData(isPolling = false): Promise<void> {
		try {
			const status = await this.getStatus(isPolling);
			if (status) {
				await this.processStatus(status);
			}
			await this.getTemperatureCalibrationOffset(isPolling);
		} finally {
			if (isPolling && !this.isUnloading && !this.isDisabled && !this.pollingSuspended) {
				this.scheduleSlowPolling();
			}
		}
	}

	private startPolling(): void {
		if (this.isUnloading || this.isDisabled || this.pollingSuspended || !this.isInitialized) {
			return;
		}
		this.stopPolling();
		this.scheduleFastPolling();
		this.scheduleSlowPolling();
		this.adapter.log.debug(`Polling started for ${this.userDefinedName} (${this.deviceId}).`);
	}

	private stopPolling(): void {
		if (this.updateFastDataTimer !== undefined) {
			this.adapter.clearTimeout(this.updateFastDataTimer);
			this.updateFastDataTimer = undefined;
		}
		if (this.updateSlowDataTimer !== undefined) {
			this.adapter.clearTimeout(this.updateSlowDataTimer);
			this.updateSlowDataTimer = undefined;
		}
	}

	private scheduleFastPolling(): void {
		if (this.isUnloading || this.isDisabled || this.pollingSuspended || this.updateFastDataTimer !== undefined) {
			return;
		}
		this.updateFastDataTimer = this.adapter.setTimeout(() => {
			this.updateFastDataTimer = undefined;
			void this.updateFastData(true).catch(error => {
				this.adapter.log.error(
					`Fast update failed for ${this.userDefinedName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}, this.pollInterval1 * 1000);
	}

	private scheduleSlowPolling(): void {
		if (this.isUnloading || this.isDisabled || this.pollingSuspended || this.updateSlowDataTimer !== undefined) {
			return;
		}
		this.updateSlowDataTimer = this.adapter.setTimeout(() => {
			this.updateSlowDataTimer = undefined;
			void this.updateSlowData(true).catch(error => {
				this.adapter.log.error(
					`Slow update failed for ${this.userDefinedName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}, this.pollInterval2 * 1000);
	}

	private handleOperationModeForPolling(operationMode: string): void {
		if (this.pollWhenOff) {
			return;
		}

		if (operationMode === "Off") {
			if (!this.pollingSuspended) {
				this.pollingSuspended = true;
				this.stopPolling();
				this.adapter.log.info(`Polling suspended for ${this.userDefinedName}: operation mode is Off.`);
			}
			return;
		}

		if (this.pollingSuspended) {
			this.pollingSuspended = false;
			this.adapter.log.info(`Polling resumed for ${this.userDefinedName}: operation mode is no longer Off.`);
			this.startPolling();
		}
	}

	private async getControlStatus(skipIfBusy = false): Promise<void> {
		this.adapter.log.debug(`getControlStatus started for ${this.host}.`);
		const data = await this.callApi("/control-status", skipIfBusy);
		if (!data) {
			return;
		}

		const ambientTemperature =
			typeof data.ambient_temperature === "number" ? Math.round(data.ambient_temperature * 10) / 10 : undefined;
		const connectedToCloud = typeof data.connected_to_cloud === "boolean" ? data.connected_to_cloud : undefined;
		const controlSignal = typeof data.control_signal === "number" ? data.control_signal : undefined;
		const currentPower = typeof data.current_power === "number" ? data.current_power : undefined;
		const lockActive = typeof data.lock_active === "string" ? data.lock_active : undefined;
		const openWindowActiveNow =
			typeof data.open_window_active_now === "string" ? data.open_window_active_now : undefined;
		const operationMode = typeof data.operation_mode === "string" ? data.operation_mode : undefined;
		const rawAmbientTemperature =
			typeof data.raw_ambient_temperature === "number"
				? Math.round(data.raw_ambient_temperature * 10) / 10
				: undefined;
		const setTemperature = typeof data.set_temperature === "number" ? data.set_temperature : undefined;
		const switchedOn = typeof data.switched_on === "boolean" ? data.switched_on : undefined;

		const values: Array<[string, ioBroker.StateValue | undefined]> = [
			["control-status.ambient_temperature", ambientTemperature],
			["control-status.connected_to_cloud", connectedToCloud],
			["control-status.control_signal", controlSignal],
			["control-status.current_power", currentPower],
			["control-status.lock_active", lockActive],
			["control-status.open_window_active_now", openWindowActiveNow],
			["control-status.operation_mode", operationMode],
			["control-status.raw_ambient_temperature", rawAmbientTemperature],
			["control-status.set_temperature", setTemperature],
			["control-status.switched_on", switchedOn],
		];

		for (const [id, value] of values) {
			if (value !== undefined) {
				this.setStateChanged(id, value);
			} else {
				this.adapter.log.debug(`${id} not updated for ${this.host}: invalid or missing API value.`);
			}
		}

		if (operationMode !== undefined) {
			this.handleOperationModeForPolling(operationMode);
		}

		this.adapter.log.debug(`Control status response processed for ${this.host}.`);
	}

	private async getTemperatureCalibrationOffset(skipIfBusy = false): Promise<void> {
		const data = await this.callApi("/temperature-calibration-offset", skipIfBusy);
		if (!data) {
			return;
		}
		if (typeof data.value === "number") {
			this.setStateChanged("settings.temperature_calibration_offset", data.value);
		} else {
			this.adapter.log.debug(
				`Temperature calibration offset not updated for ${this.host}: invalid or missing API value.`,
			);
		}
	}

	private async getHeatingLevelPercentage(skipIfBusy = false): Promise<void> {
		const data = await this.callApi("/oil-heater-power", skipIfBusy);
		if (!data) {
			return;
		}
		if (typeof data.value === "number") {
			this.setStateChanged("settings.heating_level_percentage", data.value);
		} else {
			this.adapter.log.debug(`Oil heater power not updated for ${this.host}: invalid or missing API value.`);
		}
	}

	private async getLimitedHeatingPower(skipIfBusy = false): Promise<void> {
		const data = await this.callApi("/limited-heating-power", skipIfBusy);
		if (!data) {
			return;
		}
		if (typeof data.limited_heating_power === "number") {
			this.setStateChanged("settings.limited_heating_power", data.limited_heating_power);
		} else {
			this.adapter.log.debug(`Limited heating power not updated for ${this.host}: invalid or missing API value.`);
		}
	}

	private async getAdditionalMode(skipIfBusy = false): Promise<void> {
		const data = await this.callApi("/additional-socket-mode", skipIfBusy);
		if (!data) {
			return;
		}
		const additionalMode =
			typeof data.additional_mode === "number" &&
			Number.isInteger(data.additional_mode) &&
			data.additional_mode >= 0 &&
			data.additional_mode <= 4
				? data.additional_mode
				: undefined;
		if (additionalMode !== undefined) {
			this.setStateChanged("settings.additional_mode", additionalMode);
		} else {
			this.adapter.log.debug(`Additional mode not updated for ${this.host}: invalid or missing API value.`);
		}
	}

	private async setOperationMode(value: string): Promise<void> {
		const validModes = ["Off", "Weekly program", "Independent device", "Control individually"];
		if (!validModes.includes(value)) {
			this.adapter.log.warn(`Invalid operation mode for ${this.userDefinedName}: "${value}".`);
			return;
		}
		const data = await this.callApi("/operation-mode", false, "POST", { mode: value });
		if (!data) {
			this.adapter.log.error(`Failed to set operation mode for ${this.userDefinedName} to "${value}".`);
			return;
		}
		this.setStateChanged("control-status.operation_mode", value);
		await this.updateFastData();
	}

	private async setTemperature(value: number): Promise<void> {
		if (!Number.isFinite(value) || value < 5 || value > 35) {
			this.adapter.log.warn(`Invalid temperature for ${this.userDefinedName}: ${value} °C (allowed: 5-35 °C).`);
			return;
		}
		const data = await this.callApi("/set-temperature", false, "POST", { type: "Normal", value });
		if (!data) {
			this.adapter.log.error(`Failed to set temperature for ${this.userDefinedName} to ${value} °C.`);
			return;
		}
		this.setStateChanged("control-status.set_temperature", value);
		await this.updateFastData();
	}

	private async setHeatingLevelPercentage(value: number): Promise<void> {
		if (detectDeviceType(this.modelName) !== MillDeviceType.Oil) {
			this.adapter.log.warn(
				`Heating level percentage can only be set for oil heaters (${this.userDefinedName}).`,
			);
			return;
		}
		if (value !== 40 && value !== 60 && value !== 100) {
			this.adapter.log.warn(
				`Invalid heating level percentage for ${this.userDefinedName}: ${value}. Allowed values are 40, 60 or 100.`,
			);
			return;
		}
		const data = await this.callApi("/oil-heater-power", false, "POST", { heating_level_percentage: value });
		if (!data) {
			this.adapter.log.error(`Failed to set heating level percentage for ${this.userDefinedName} to ${value}%.`);
			return;
		}
		this.setStateChanged("settings.heating_level_percentage", value);
		await this.updateFastData();
	}

	private async setLimitedHeatingPower(value: number): Promise<void> {
		if (detectDeviceType(this.modelName) !== MillDeviceType.Panel) {
			this.adapter.log.warn(`Limited heating power can only be set for panel heaters (${this.userDefinedName}).`);
			return;
		}
		if (!Number.isInteger(value) || value < 10 || value > 100) {
			this.adapter.log.warn(
				`Invalid limited heating power for ${this.userDefinedName}: ${value}. Allowed values are 10 to 100.`,
			);
			return;
		}
		const data = await this.callApi("/limited-heating-power", false, "POST", { limited_heating_power: value });
		if (!data) {
			this.adapter.log.error(`Failed to set limited heating power for ${this.userDefinedName} to ${value}%.`);
			return;
		}
		this.setStateChanged("settings.limited_heating_power", value);
		await this.updateFastData();
	}

	private async setAdditionalMode(value: number): Promise<void> {
		if (detectDeviceType(this.modelName) !== MillDeviceType.WiFiSocket) {
			this.adapter.log.warn(`Additional mode can only be set for socket heaters (${this.userDefinedName}).`);
			return;
		}
		if (!Number.isInteger(value) || value < 0 || value > 4) {
			this.adapter.log.warn(
				`Invalid additional mode for ${this.userDefinedName}: ${value}. Allowed values are 0 to 4.`,
			);
			return;
		}
		const data = await this.callApi("/additional-socket-mode", false, "POST", { additional_mode: value });
		if (!data) {
			this.adapter.log.error(`Failed to set additional mode for ${this.userDefinedName} to ${value}.`);
			return;
		}
		this.setStateChanged("settings.additional_mode", value);
		await this.updateFastData();
	}

	private async setTemperatureCalibrationOffset(value: number): Promise<void> {
		if (!Number.isFinite(value) || value < -30 || value > 30) {
			this.adapter.log.warn(
				`Invalid temperature calibration offset for ${this.userDefinedName}: ${value} °C (allowed: -30 - +30 °C).`,
			);
			return;
		}
		const data = await this.callApi("/temperature-calibration-offset", false, "POST", { value });
		if (!data) {
			this.adapter.log.error(
				`Failed to set temperature calibration offset for ${this.userDefinedName} to ${value} °C.`,
			);
			return;
		}
		this.setStateChanged("settings.temperature_calibration_offset", value);
		await this.updateFastData();
		await this.updateSlowData();
	}
}
