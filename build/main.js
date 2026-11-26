"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_async_mutex = require("async-mutex");
var utils = __toESM(require("@iobroker/adapter-core"));
var import_millHeaterDevice = require("./lib/millHeaterDevice");
var import_deviceStates = require("./lib/deviceStates");
const MAX_DEVICE_TREES = 2 * 42;
class Millheater extends utils.Adapter {
  devices = [];
  devicesById = /* @__PURE__ */ new Map();
  deviceTreeCleanupMutex = new import_async_mutex.Mutex();
  isUnloading = false;
  configuredDeviceHosts = /* @__PURE__ */ new Set();
  // Must match the limits in admin/jsonConfig.json
  apiTimeoutMin = 1;
  apiTimeoutMax = 60;
  apiTimeout = 0;
  pollInterval1 = 0;
  // Must match the limits in admin/jsonConfig.json
  pollInterval1Max = 3600;
  pollInterval2 = 0;
  // Must match the limits in admin/jsonConfig.json
  pollInterval2Max = 86400;
  constructor(options = {}) {
    super({
      ...options,
      name: "millheater",
      // The adapter core explicitly waits for the ready promise.
      ready: () => this.onReady()
    });
    this.on("stateChange", (id, state) => {
      this.onStateChange(id, state);
    });
    this.on("unload", (callback) => {
      this.onUnload(callback);
    });
  }
  /** Adapter startup. */
  async onReady() {
    this.log.info("Mill Heater Adapter started.");
    this.apiTimeout = this.config.apiTimeout;
    this.pollInterval1 = this.config.pollInterval1;
    this.pollInterval2 = this.config.pollInterval2;
    if (!Number.isInteger(this.apiTimeout) || this.apiTimeout < this.apiTimeoutMin || this.apiTimeout > this.apiTimeoutMax) {
      const message = `HTTP timeout must be between ${this.apiTimeoutMin} and ${this.apiTimeoutMax} seconds.`;
      this.log.error(message);
      this.terminate(message, utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
      return;
    }
    if (!Number.isInteger(this.pollInterval1) || this.pollInterval1 < this.apiTimeout + 1 || this.pollInterval1 > this.pollInterval1Max) {
      const message = `Fast polling interval must be between ${this.apiTimeout + 1} and ${this.pollInterval1Max} seconds.`;
      this.log.error(message);
      this.terminate(message, utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
      return;
    }
    if (!Number.isInteger(this.pollInterval2) || this.pollInterval2 < this.pollInterval1 + this.apiTimeout || this.pollInterval2 > this.pollInterval2Max) {
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
    this.configuredDeviceHosts = new Set(configuredDevices.map((device) => device.host.toLowerCase()));
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
    const callbacks = {
      onIdentified: (device, deviceId, previousDeviceId) => this.onDeviceIdentified(device, deviceId, previousDeviceId),
      createObjects: (device) => this.createDeviceObjects(device),
      onConnectionChanged: () => this.updateInstanceConnectionState()
    };
    for (const config of configuredDevices) {
      this.devices.push(
        new import_millHeaterDevice.MillHeaterDevice(this, config, callbacks, this.apiTimeout, this.pollInterval1, this.pollInterval2)
      );
    }
    await Promise.all(
      this.devices.map(async (device) => {
        try {
          await device.start();
        } catch (error) {
          this.log.error(
            `Failed to start Mill device ${device.userDefinedName} (${device.configuredHost}): ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })
    );
  }
  /** Read and validate the configured device table. */
  readDeviceConfiguration() {
    const configured = this.config.devices;
    const result = [];
    const configuredHosts = /* @__PURE__ */ new Set();
    if (Array.isArray(configured)) {
      for (let index = 0; index < configured.length; index++) {
        const entry = configured[index];
        if (!entry || typeof entry !== "object") {
          this.log.warn(`Ignoring invalid Mill device entry at position ${index + 1}.`);
          continue;
        }
        const candidate = entry;
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
        let userDefinedName = "";
        if (typeof candidate.userDefinedName === "string") {
          userDefinedName = candidate.userDefinedName.trim();
        } else if (typeof candidate.name === "string") {
          userDefinedName = candidate.name.trim();
        }
        result.push({
          userDefinedName,
          host,
          pollWhenOff: candidate.pollWhenOff !== false
        });
      }
    }
    return result;
  }
  /** Create the adapter-level information channel and aggregate connection state. */
  async createInstanceInfoObjects() {
    await this.setObjectNotExists("info", {
      type: "channel",
      common: { name: "Information" },
      native: {}
    });
    await this.setObjectNotExists("info.connection", {
      type: "state",
      common: {
        name: {
          en: "Devices connected",
          de: "Ger\xE4te verbunden",
          ru: "\u041F\u0440\u0438\u0431\u043E\u0440\u044B \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u044B",
          pt: "Dispositivos conectados",
          nl: "Apparaten verbonden",
          fr: "Appareils connect\xE9s",
          it: "Dispositivi connessi",
          es: "Dispositivos conectados",
          pl: "Urz\u0105dzenia po\u0142\u0105czone",
          uk: "\u041F\u0440\u0438\u0441\u0442\u0440\u043E\u0457 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0456",
          "zh-cn": "\u8BBE\u5907\u5DF2\u8FDE\u63A5"
        },
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setState("info.connection", false, true);
  }
  /**
   * Creates the device object tree and its state metadata.
   *
   * @param device - The Mill heater device whose objects are created.
   */
  async createDeviceObjects(device) {
    const deviceId = device.id;
    if (!deviceId) {
      throw new Error("Cannot create device objects before the MAC address has been registered.");
    }
    await this.deviceTreeCleanupMutex.runExclusive(async () => {
      const deviceIds = await this.getDeviceTreeRows();
      if (!deviceIds.includes(deviceId.toLowerCase())) {
        await this.cleanupDeviceTreesLocked(deviceIds, 1);
        const remainingDeviceIds = await this.getDeviceTreeRows();
        if (remainingDeviceIds.length >= MAX_DEVICE_TREES) {
          throw new Error(
            `Cannot create device tree for ${deviceId}: the limit of ${MAX_DEVICE_TREES} device trees has been reached and no historical tree can safely be removed.`
          );
        }
      }
      await this.setObjectNotExists(deviceId, {
        type: "device",
        common: {
          name: device.userDefinedName,
          statusStates: {
            onlineId: "info.connection"
          }
        },
        native: {
          host: device.configuredHost,
          retiredAt: 0
        }
      });
      await this.extendObject(deviceId, {
        common: { name: device.userDefinedName },
        native: {
          host: device.configuredHost,
          retiredAt: 0
        }
      });
      for (const [id, name] of import_deviceStates.DEVICE_CHANNELS) {
        await this.setObjectNotExists(`${deviceId}.${id}`, {
          type: "channel",
          common: { name },
          native: {}
        });
      }
      for (const state of import_deviceStates.DEVICE_STATES) {
        if (!device.isStateSupported(state.id)) {
          continue;
        }
        await this.setObjectNotExists(`${deviceId}.${state.id}`, {
          type: "state",
          common: state.common,
          native: {}
        });
      }
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
  async cleanupDeviceTreesLocked(deviceIds, additionalTrees = 0) {
    const excess = deviceIds.length + additionalTrees - MAX_DEVICE_TREES;
    if (excess <= 0) {
      return 0;
    }
    const candidates = [];
    for (const deviceId of deviceIds) {
      if (this.devicesById.has(deviceId)) {
        continue;
      }
      const object = await this.getObjectAsync(deviceId);
      if (!object) {
        continue;
      }
      const native = typeof object.native === "object" ? object.native : {};
      const retiredAt = typeof native.retiredAt === "number" && Number.isFinite(native.retiredAt) ? native.retiredAt : 0;
      const host = typeof native.host === "string" ? native.host.trim().toLowerCase() : "";
      if (retiredAt <= 0) {
        continue;
      }
      if (host && this.configuredDeviceHosts.has(host)) {
        continue;
      }
      candidates.push({ id: deviceId, retiredAt });
    }
    candidates.sort((a, b) => a.retiredAt - b.retiredAt);
    const toDelete = candidates.slice(0, excess);
    for (const candidate of toDelete) {
      await this.delObjectAsync(candidate.id, { recursive: true });
      this.log.info(`Removed historical Mill device tree ${candidate.id}.`);
    }
    if (toDelete.length < excess) {
      this.log.warn(
        `Device tree limit of ${MAX_DEVICE_TREES} cannot be reached: ${excess - toDelete.length} additional tree(s) could not be removed because no safe historical candidates were available. Active device trees were preserved.`
      );
    }
    return toDelete.length;
  }
  /** Return all MAC-based device roots belonging to this adapter instance. */
  async getDeviceTreeRows() {
    const namespacePrefix = `${this.namespace}.`;
    const result = await this.getObjectViewAsync("system", "device", {
      startkey: namespacePrefix,
      endkey: `${namespacePrefix}\u9999`
    });
    return result.rows.map((row) => row.id).filter(
      (id) => typeof id === "string" && id.startsWith(namespacePrefix) && /^[0-9a-f]{12}$/i.test(id.slice(namespacePrefix.length))
    ).map((id) => id.slice(namespacePrefix.length).toLowerCase());
  }
  /** Set every previously created MAC-based device tree offline at adapter startup. */
  async setExistingDeviceTreesOffline() {
    try {
      await this.deviceTreeCleanupMutex.runExclusive(async () => {
        const deviceIds = await this.getDeviceTreeRows();
        const offlineWrites = [];
        for (const deviceId of deviceIds) {
          const object = await this.getObjectAsync(deviceId);
          if (object) {
            const native = typeof object.native === "object" ? object.native : {};
            const host = typeof native.host === "string" ? native.host.trim().toLowerCase() : "";
            const currentRetiredAt = typeof native.retiredAt === "number" && Number.isFinite(native.retiredAt) ? native.retiredAt : 0;
            if (host && this.configuredDeviceHosts.has(host)) {
              if (currentRetiredAt !== 0) {
                await this.extendObject(deviceId, {
                  native: { retiredAt: 0 }
                });
              }
            } else {
              const retiredAt = currentRetiredAt > 0 ? currentRetiredAt : 1;
              if (host || currentRetiredAt <= 0) {
                await this.extendObject(deviceId, {
                  native: {
                    host: "",
                    retiredAt
                  }
                });
              }
            }
          }
          offlineWrites.push(
            this.setState(`${deviceId}.info.connection`, false, true).then(() => void 0).catch((error) => {
              this.log.warn(
                `Could not set existing Mill device ${deviceId} offline: ${error instanceof Error ? error.message : String(error)}`
              );
            })
          );
        }
        await Promise.all(offlineWrites);
        await this.cleanupDeviceTreesLocked(deviceIds);
      });
    } catch (error) {
      this.log.warn(
        `Could not set existing Mill device trees offline: ${error instanceof Error ? error.message : String(error)}`
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
  async onDeviceIdentified(device, deviceId, previousDeviceId) {
    const normalizedDeviceId = deviceId.toLowerCase();
    if (previousDeviceId && previousDeviceId.toLowerCase() !== normalizedDeviceId) {
      await device.pauseApiRequests();
    }
    const currentOwner = this.devicesById.get(normalizedDeviceId);
    if (currentOwner && currentOwner !== device) {
      this.log.error(
        `MAC address ${normalizedDeviceId} is already assigned to ${currentOwner.userDefinedName} (${currentOwner.configuredHost}); refusing duplicate device ${device.userDefinedName} (${device.configuredHost}).`
      );
      if (previousDeviceId && previousDeviceId.toLowerCase() !== normalizedDeviceId) {
        await this.setState(`${previousDeviceId}.info.connection`, false, true);
        await this.extendObject(previousDeviceId, {
          native: {
            host: "",
            retiredAt: Date.now()
          }
        });
        if (this.devicesById.get(previousDeviceId.toLowerCase()) === device) {
          this.devicesById.delete(previousDeviceId.toLowerCase());
        }
      }
      return false;
    }
    if (previousDeviceId && previousDeviceId.toLowerCase() !== normalizedDeviceId) {
      const oldConnectionStateId = `${previousDeviceId}.info.connection`;
      this.log.debug(`MAC change: setting ${oldConnectionStateId} to false.`);
      await this.setState(oldConnectionStateId, false, true);
      this.log.debug(`MAC change: setState completed for ${oldConnectionStateId}.`);
      await this.extendObject(previousDeviceId, {
        native: {
          host: "",
          retiredAt: Date.now()
        }
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
  updateInstanceConnectionState() {
    if (this.isUnloading) {
      return;
    }
    const connected = this.devices.some((device) => device.isConnected);
    this.log.debug(
      `Adapter connection state: ${connected}; devices: ${this.devices.map((device) => `${device.name}=${device.isConnected}`).join(", ")}.`
    );
    this.setStateChanged("info.connection", connected, true);
  }
  /**
   * Routes state changes from MAC-based device state IDs to the corresponding device object.
   *
   * @param id - The state ID that changed.
   * @param state - The new state value, or `null`/`undefined` if unavailable.
   */
  onStateChange(id, state) {
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
    void device.handleStateChange(stateId, state).catch((error) => {
      this.log.error(
        `Failed to handle state change ${id}: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
  /**
   * Stops all devices and waits until their API mutexes have been released.
   *
   * @param callback - The callback to invoke once unloading is complete.
   */
  onUnload(callback) {
    if (this.isUnloading) {
      callback();
      return;
    }
    this.isUnloading = true;
    this.log.info("Mill Heater Adapter is shutting down.");
    void Promise.allSettled(this.devices.map((device) => device.unload())).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          this.log.error(
            `Error while stopping a Mill device: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
          );
        }
      }
      void this.setState("info.connection", false, true).catch((error) => {
        this.log.error(
          `Could not reset adapter connection state: ${error instanceof Error ? error.message : String(error)}`
        );
      }).finally(callback);
    });
  }
}
if (require.main !== module) {
  module.exports = (options) => new Millheater(options);
} else {
  (() => new Millheater())();
}
//# sourceMappingURL=main.js.map
