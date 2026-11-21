"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var millHeaterDevice_exports = {};
__export(millHeaterDevice_exports, {
  MillDeviceType: () => MillDeviceType,
  MillHeaterDevice: () => MillHeaterDevice,
  detectDeviceType: () => detectDeviceType,
  normalizeMacAddress: () => normalizeMacAddress
});
module.exports = __toCommonJS(millHeaterDevice_exports);
var http = __toESM(require("node:http"));
var import_async_mutex = require("async-mutex");
function normalizeMacAddress(macAddress) {
  const normalized = macAddress.replace(/[:-]/g, "").trim().toLowerCase();
  return /^[0-9a-f]{12}$/.test(normalized) ? normalized : void 0;
}
var MillDeviceType = /* @__PURE__ */ ((MillDeviceType2) => {
  MillDeviceType2["Oil"] = "Oil";
  MillDeviceType2["Panel"] = "Panel";
  MillDeviceType2["WiFiSocket"] = "Wi-Fi Socket";
  MillDeviceType2["Convection"] = "Convection";
  MillDeviceType2["Unknown"] = "Unknown";
  return MillDeviceType2;
})(MillDeviceType || {});
function detectDeviceType(modelName) {
  var _a;
  const normalized = (_a = modelName == null ? void 0 : modelName.toLowerCase()) != null ? _a : "";
  if (normalized.includes("oil")) {
    return "Oil" /* Oil */;
  }
  if (normalized.includes("panel")) {
    return "Panel" /* Panel */;
  }
  if (normalized.includes("socket")) {
    return "Wi-Fi Socket" /* WiFiSocket */;
  }
  if (normalized.includes("convection")) {
    return "Convection" /* Convection */;
  }
  return "Unknown" /* Unknown */;
}
class MillHeaterDevice {
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
  constructor(adapter, config, callbacks, apiTimeout, pollInterval1, pollInterval2) {
    this.adapter = adapter;
    this.callbacks = callbacks;
    var _a;
    this.host = config.host.trim();
    this.userDefinedName = ((_a = config.userDefinedName) == null ? void 0 : _a.trim()) || this.host;
    this.pollWhenOff = config.pollWhenOff !== false;
    this.apiTimeout = apiTimeout;
    this.pollInterval1 = pollInterval1;
    this.pollInterval2 = pollInterval2;
  }
  /** Device types required by model-specific states; all other states are shared by every model. */
  static DEVICE_STATE_TYPES = {
    "settings.additional_mode": "Wi-Fi Socket" /* WiFiSocket */,
    "settings.heating_level_percentage": "Oil" /* Oil */,
    "settings.limited_heating_power": "Panel" /* Panel */
  };
  apiMutex = new import_async_mutex.Mutex();
  apiTimeout;
  host;
  pollInterval1;
  pollInterval2;
  pollWhenOff;
  apiConnected;
  apiRequestsPaused = false;
  deviceId;
  isUnloading = false;
  isDisabled = false;
  isInitialized = false;
  isObjectsCreated = false;
  modelName = "";
  pollingSuspended = false;
  discoveryRetryTimer;
  updateFastDataTimer;
  updateSlowDataTimer;
  userDefinedName;
  /** MAC-based device ID, once it has been identified. */
  get id() {
    return this.deviceId;
  }
  /** Current API reachability, independent of whether the heater is switched on. */
  get isConnected() {
    return this.apiConnected === true;
  }
  /** Configured host, either an IP address or a hostname. */
  get configuredHost() {
    return this.host;
  }
  /** User defined display name. */
  get name() {
    return this.userDefinedName;
  }
  /**
   * Checks whether a state belongs to the model of this device.
   * Unrestricted states are supported by every model.
   *
   * @param stateId - State ID relative to the device root.
   */
  isStateSupported(stateId) {
    const requiredType = MillHeaterDevice.DEVICE_STATE_TYPES[stateId];
    return requiredType === void 0 || detectDeviceType(this.modelName) === requiredType;
  }
  /** Starts the device by reading its status before creating its object tree. */
  async start() {
    await this.tryInitialize();
  }
  /** Stops polling, pending discovery retries, API requests and resets connection status. */
  async unload() {
    this.isUnloading = true;
    this.stopPolling();
    if (this.discoveryRetryTimer !== void 0) {
      this.adapter.clearTimeout(this.discoveryRetryTimer);
      this.discoveryRetryTimer = void 0;
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
  async handleStateChange(id, state) {
    if (this.isUnloading || this.isDisabled || state.ack !== false) {
      return;
    }
    if (!this.isStateSupported(id)) {
      this.adapter.log.warn(
        `Ignoring write to ${this.getStateId(id)}: not supported by ${detectDeviceType(this.modelName)} devices.`
      );
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
  async pauseApiRequests() {
    this.apiRequestsPaused = true;
    await this.apiMutex.runExclusive(() => void 0);
  }
  /**
   * Resumes API requests after the device identity change is complete.
   */
  resumeApiRequests() {
    this.apiRequestsPaused = false;
  }
  getStateId(id) {
    if (!this.deviceId) {
      throw new Error("Cannot access a device state before the device has been identified.");
    }
    return `${this.deviceId}.${id}`;
  }
  setStateChanged(id, value) {
    if (!this.deviceId || this.isUnloading) {
      return;
    }
    void this.adapter.setStateChanged(`${this.deviceId}.${id}`, value, true);
  }
  async tryInitialize() {
    if (this.isUnloading || this.isDisabled || this.isInitialized) {
      return;
    }
    const status = await this.getStatus();
    if (!status || !await this.processStatus(status)) {
      this.scheduleDiscoveryRetry();
      return;
    }
    await this.getTemperatureCalibrationOffset();
    await this.updateFastData();
    this.isInitialized = true;
    this.startPolling();
    this.adapter.log.info(`Mill device ${this.userDefinedName} (${this.deviceId}) initialized at ${this.host}.`);
  }
  scheduleDiscoveryRetry() {
    if (this.isUnloading || this.isDisabled || this.isInitialized || this.discoveryRetryTimer !== void 0) {
      return;
    }
    this.discoveryRetryTimer = this.adapter.setTimeout(() => {
      this.discoveryRetryTimer = void 0;
      void this.tryInitialize().catch((error) => {
        this.adapter.log.error(
          `Device initialization failed for ${this.host}: ${error instanceof Error ? error.message : String(error)}`
        );
        this.scheduleDiscoveryRetry();
      });
    }, this.pollInterval1 * 1e3);
  }
  async acceptMacAddress(macAddress) {
    const newDeviceId = normalizeMacAddress(macAddress);
    if (!newDeviceId) {
      this.adapter.log.warn(`Invalid MAC address reported by ${this.host}: ${macAddress}`);
      return this.isObjectsCreated && this.deviceId !== void 0;
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
    this.isObjectsCreated = false;
    await this.callbacks.createObjects(this);
    this.isObjectsCreated = true;
    this.resumeApiRequests();
    this.adapter.log.info(
      previousDeviceId && previousDeviceId !== newDeviceId ? `Mill device at ${this.host} changed MAC address: ${previousDeviceId} -> ${newDeviceId}.` : `Mill device ${this.userDefinedName} identified with MAC address ${macAddress}.`
    );
    return true;
  }
  disable(reason) {
    this.isDisabled = true;
    this.stopPolling();
    if (this.apiConnected !== false) {
      this.updateApiConnectionState(false);
    }
    this.adapter.log.error(`Mill device ${this.userDefinedName} (${this.host}) disabled: ${reason}`);
  }
  updateInfoStates() {
    if (!this.deviceId) {
      return;
    }
    const values = [
      ["info.name", this.userDefinedName],
      ["info.host", this.host],
      ["info.deviceType", this.modelName ? detectDeviceType(this.modelName) : void 0]
    ];
    for (const [id, value] of values) {
      if (value !== void 0) {
        this.setStateChanged(id, value);
      }
    }
  }
  updateApiConnectionState(connected, path, error) {
    if (connected && (this.isDisabled || this.isUnloading)) {
      return;
    }
    const previousState = this.apiConnected;
    this.setStateChanged("info.connection", connected);
    if (previousState === connected) {
      if (!connected && error) {
        this.adapter.log.debug(
          `Mill API request${path ? ` for ${path}` : ""} at ${this.host} failed: ${error.message}`
        );
      }
      return;
    }
    this.apiConnected = connected;
    this.callbacks.onConnectionChanged(this);
    if (connected) {
      this.adapter.log.info(
        previousState === false ? `Mill device ${this.userDefinedName} connection restored.` : `HTTP connection established with ${this.userDefinedName}.`
      );
      return;
    }
    const reason = error ? `${path ? `${path}: ` : ""}${error.message}` : "Unknown error";
    this.adapter.log.warn(
      `${previousState === true ? "Mill device connection lost" : "Mill device is not reachable"} (${this.userDefinedName}, ${this.host}): ${reason}`
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
  async callApi(path, skipIfBusy = false, method = "GET", body) {
    if (this.isUnloading || this.isDisabled || this.apiRequestsPaused) {
      return void 0;
    }
    if (skipIfBusy && method !== "GET") {
      throw new Error("The skip option is only supported for GET requests.");
    }
    try {
      const result = skipIfBusy ? await (0, import_async_mutex.tryAcquire)(this.apiMutex).runExclusive(() => this.performApiRequest(path, method, body)) : await this.apiMutex.runExclusive(() => this.performApiRequest(path, method, body));
      this.adapter.log.debug(`API response for ${this.host} "${path}": ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      if (error === import_async_mutex.E_ALREADY_LOCKED) {
        this.adapter.log.debug(
          `Skipping API request ${method} ${path} for ${this.host}: another request is running.`
        );
        return void 0;
      }
      if (error === import_async_mutex.E_CANCELED && this.isUnloading) {
        this.adapter.log.debug(`Canceled API request ${method} ${path} for ${this.host} during shutdown.`);
        return void 0;
      }
      this.adapter.log.error(
        `Error executing API request ${method} ${path} for ${this.host}: ${error instanceof Error ? error.message : String(error)}`
      );
      return void 0;
    }
  }
  async performApiRequest(path, method = "GET", body) {
    const url = `http://${this.host}${path}`;
    const headers = {};
    const jsonBody = body !== void 0 ? JSON.stringify(body) : void 0;
    if (jsonBody !== void 0) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(jsonBody);
    }
    this.adapter.log.debug(
      `Request: ${method} ${url}, Header: ${JSON.stringify(headers)}, Request body: ${jsonBody}`
    );
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      const handleRequestError = (error) => {
        if (settled) {
          return;
        }
        this.updateApiConnectionState(false, path, error);
        finish(void 0);
      };
      const request = http.request(url, { method, headers }, (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("error", handleRequestError);
        response.on("end", () => {
          if (settled) {
            return;
          }
          const statusCode = response.statusCode;
          this.adapter.log.debug(`HTTP status for ${path} at ${this.host}: ${statusCode != null ? statusCode : "undefined"}`);
          if (path !== "/status" && this.deviceId && this.isObjectsCreated) {
            this.updateApiConnectionState(true);
          }
          if (statusCode === void 0 || statusCode < 200 || statusCode >= 300) {
            this.adapter.log.error(
              `Mill API request failed for ${path} at ${this.host}: HTTP ${statusCode != null ? statusCode : "unknown"}.`
            );
            if (data.trim()) {
              this.adapter.log.error(`Mill API response from ${this.host}: ${data}`);
            }
            finish(void 0);
            return;
          }
          if (!data.trim()) {
            this.adapter.log.error(`Empty response from ${path} at ${this.host}.`);
            finish(void 0);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              this.adapter.log.error(
                `Invalid API response from ${path} at ${this.host}: response is not an object.`
              );
              finish(void 0);
              return;
            }
            const dataRecord = parsed;
            if (dataRecord.status !== "ok") {
              this.adapter.log.error(
                `Mill API rejected request to ${path} at ${this.host}: status=${String(dataRecord.status)}.`
              );
              finish(void 0);
              return;
            }
            finish(dataRecord);
          } catch (error) {
            this.adapter.log.error(
              `Invalid JSON response from ${path} at ${this.host}: ${error instanceof Error ? error.message : String(error)}`
            );
            finish(void 0);
          }
        });
      });
      request.on("error", handleRequestError);
      request.setTimeout(this.apiTimeout * 1e3, () => {
        request.destroy(new Error(`Timeout calling ${path}.`));
      });
      if (jsonBody !== void 0) {
        request.write(jsonBody);
      }
      request.end();
    });
  }
  async getStatus(skipIfBusy = false) {
    this.adapter.log.debug(`getStatus started for ${this.host}.`);
    const data = await this.callApi("/status", skipIfBusy);
    if (!data) {
      return void 0;
    }
    return {
      modelName: typeof data.name === "string" && data.name.trim() ? data.name.trim() : void 0,
      customName: typeof data.custom_name === "string" ? data.custom_name : void 0,
      version: typeof data.version === "string" ? data.version : void 0,
      operationKey: typeof data.operation_key === "string" ? data.operation_key : void 0,
      macAddress: typeof data.mac_address === "string" && data.mac_address.trim() !== "" ? data.mac_address.trim() : void 0
    };
  }
  /**
   * Processes a status response after validating its model name and MAC address.
   * Registers the device and updates its status and information states.
   *
   * @param status - Status response returned by the Mill API.
   * @returns Whether the status response was successfully processed.
   */
  async processStatus(status) {
    if (!status.modelName || !status.macAddress || !normalizeMacAddress(status.macAddress)) {
      this.adapter.log.debug(
        `Mill status response from ${this.host} does not contain a valid model name and MAC address; initialization will be retried.`
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
    this.updateApiConnectionState(true);
    return true;
  }
  writeStatus(status) {
    const values = [
      ["status.name", status.modelName],
      ["status.custom_name", status.customName],
      ["status.version", status.version],
      ["status.operation_key", status.operationKey],
      ["status.mac_address", status.macAddress]
    ];
    for (const [id, value] of values) {
      if (value !== void 0) {
        this.setStateChanged(id, value);
      }
    }
  }
  async updateFastData(isPolling = false) {
    try {
      if (!this.modelName) {
        const status = await this.getStatus(isPolling);
        if (status) {
          await this.processStatus(status);
        }
      }
      await this.getControlStatus(isPolling);
      if (this.pollingSuspended) {
        return;
      }
      switch (detectDeviceType(this.modelName)) {
        case "Oil" /* Oil */:
          await this.getHeatingLevelPercentage(isPolling);
          break;
        case "Panel" /* Panel */:
          await this.getLimitedHeatingPower(isPolling);
          break;
        case "Wi-Fi Socket" /* WiFiSocket */:
          await this.getAdditionalMode(isPolling);
          break;
        case "Convection" /* Convection */:
        case "Unknown" /* Unknown */:
          break;
      }
    } finally {
      if (isPolling && !this.isUnloading && !this.isDisabled && !this.pollingSuspended) {
        this.scheduleFastPolling();
      }
    }
  }
  async updateSlowData(isPolling = false) {
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
  startPolling() {
    if (this.isUnloading || this.isDisabled || this.pollingSuspended || !this.isInitialized) {
      return;
    }
    this.stopPolling();
    this.scheduleFastPolling();
    this.scheduleSlowPolling();
    this.adapter.log.debug(`Polling started for ${this.userDefinedName} (${this.deviceId}).`);
  }
  stopPolling() {
    if (this.updateFastDataTimer !== void 0) {
      this.adapter.clearTimeout(this.updateFastDataTimer);
      this.updateFastDataTimer = void 0;
    }
    if (this.updateSlowDataTimer !== void 0) {
      this.adapter.clearTimeout(this.updateSlowDataTimer);
      this.updateSlowDataTimer = void 0;
    }
  }
  scheduleFastPolling() {
    if (this.isUnloading || this.isDisabled || this.pollingSuspended || this.updateFastDataTimer !== void 0) {
      return;
    }
    this.updateFastDataTimer = this.adapter.setTimeout(() => {
      this.updateFastDataTimer = void 0;
      void this.updateFastData(true).catch((error) => {
        this.adapter.log.error(
          `Fast update failed for ${this.userDefinedName}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, this.pollInterval1 * 1e3);
  }
  scheduleSlowPolling() {
    if (this.isUnloading || this.isDisabled || this.pollingSuspended || this.updateSlowDataTimer !== void 0) {
      return;
    }
    this.updateSlowDataTimer = this.adapter.setTimeout(() => {
      this.updateSlowDataTimer = void 0;
      void this.updateSlowData(true).catch((error) => {
        this.adapter.log.error(
          `Slow update failed for ${this.userDefinedName}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, this.pollInterval2 * 1e3);
  }
  handleOperationModeForPolling(operationMode) {
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
  async getControlStatus(skipIfBusy = false) {
    this.adapter.log.debug(`getControlStatus started for ${this.host}.`);
    const data = await this.callApi("/control-status", skipIfBusy);
    if (!data) {
      return;
    }
    const ambientTemperature = typeof data.ambient_temperature === "number" ? Math.round(data.ambient_temperature * 10) / 10 : void 0;
    const connectedToCloud = typeof data.connected_to_cloud === "boolean" ? data.connected_to_cloud : void 0;
    const controlSignal = typeof data.control_signal === "number" ? data.control_signal : void 0;
    const currentPower = typeof data.current_power === "number" ? data.current_power : void 0;
    const lockActive = typeof data.lock_active === "string" ? data.lock_active : void 0;
    const openWindowActiveNow = typeof data.open_window_active_now === "string" ? data.open_window_active_now : void 0;
    const operationMode = typeof data.operation_mode === "string" ? data.operation_mode : void 0;
    const rawAmbientTemperature = typeof data.raw_ambient_temperature === "number" ? Math.round(data.raw_ambient_temperature * 10) / 10 : void 0;
    const setTemperature = typeof data.set_temperature === "number" ? data.set_temperature : void 0;
    const switchedOn = typeof data.switched_on === "boolean" ? data.switched_on : void 0;
    const values = [
      ["control-status.ambient_temperature", ambientTemperature],
      ["control-status.connected_to_cloud", connectedToCloud],
      ["control-status.control_signal", controlSignal],
      ["control-status.current_power", currentPower],
      ["control-status.lock_active", lockActive],
      ["control-status.open_window_active_now", openWindowActiveNow],
      ["control-status.operation_mode", operationMode],
      ["control-status.raw_ambient_temperature", rawAmbientTemperature],
      ["control-status.set_temperature", setTemperature],
      ["control-status.switched_on", switchedOn]
    ];
    for (const [id, value] of values) {
      if (value !== void 0) {
        this.setStateChanged(id, value);
      } else {
        this.adapter.log.debug(`${id} not updated for ${this.host}: invalid or missing API value.`);
      }
    }
    if (operationMode !== void 0) {
      this.handleOperationModeForPolling(operationMode);
    }
    this.adapter.log.debug(`Control status response processed for ${this.host}.`);
  }
  async getTemperatureCalibrationOffset(skipIfBusy = false) {
    const data = await this.callApi("/temperature-calibration-offset", skipIfBusy);
    if (!data) {
      return;
    }
    if (typeof data.value === "number") {
      this.setStateChanged("settings.temperature_calibration_offset", data.value);
    } else {
      this.adapter.log.debug(
        `Temperature calibration offset not updated for ${this.host}: invalid or missing API value.`
      );
    }
  }
  async getHeatingLevelPercentage(skipIfBusy = false) {
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
  async getLimitedHeatingPower(skipIfBusy = false) {
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
  async getAdditionalMode(skipIfBusy = false) {
    const data = await this.callApi("/additional-socket-mode", skipIfBusy);
    if (!data) {
      return;
    }
    const additionalMode = typeof data.additional_mode === "number" && Number.isInteger(data.additional_mode) && data.additional_mode >= 0 && data.additional_mode <= 4 ? data.additional_mode : void 0;
    if (additionalMode !== void 0) {
      this.setStateChanged("settings.additional_mode", additionalMode);
    } else {
      this.adapter.log.debug(`Additional mode not updated for ${this.host}: invalid or missing API value.`);
    }
  }
  async setOperationMode(value) {
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
  async setTemperature(value) {
    if (!Number.isFinite(value) || value < 5 || value > 35) {
      this.adapter.log.warn(`Invalid temperature for ${this.userDefinedName}: ${value} \xB0C (allowed: 5-35 \xB0C).`);
      return;
    }
    const data = await this.callApi("/set-temperature", false, "POST", { type: "Normal", value });
    if (!data) {
      this.adapter.log.error(`Failed to set temperature for ${this.userDefinedName} to ${value} \xB0C.`);
      return;
    }
    this.setStateChanged("control-status.set_temperature", value);
    await this.updateFastData();
  }
  async setHeatingLevelPercentage(value) {
    if (detectDeviceType(this.modelName) !== "Oil" /* Oil */) {
      this.adapter.log.warn(
        `Heating level percentage can only be set for oil heaters (${this.userDefinedName}).`
      );
      return;
    }
    if (value !== 40 && value !== 60 && value !== 100) {
      this.adapter.log.warn(
        `Invalid heating level percentage for ${this.userDefinedName}: ${value}. Allowed values are 40, 60 or 100.`
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
  async setLimitedHeatingPower(value) {
    if (detectDeviceType(this.modelName) !== "Panel" /* Panel */) {
      this.adapter.log.warn(`Limited heating power can only be set for panel heaters (${this.userDefinedName}).`);
      return;
    }
    if (!Number.isInteger(value) || value < 10 || value > 100) {
      this.adapter.log.warn(
        `Invalid limited heating power for ${this.userDefinedName}: ${value}. Allowed values are 10 to 100.`
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
  async setAdditionalMode(value) {
    if (detectDeviceType(this.modelName) !== "Wi-Fi Socket" /* WiFiSocket */) {
      this.adapter.log.warn(`Additional mode can only be set for socket heaters (${this.userDefinedName}).`);
      return;
    }
    if (!Number.isInteger(value) || value < 0 || value > 4) {
      this.adapter.log.warn(
        `Invalid additional mode for ${this.userDefinedName}: ${value}. Allowed values are 0 to 4.`
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
  async setTemperatureCalibrationOffset(value) {
    if (!Number.isFinite(value) || value < -30 || value > 30) {
      this.adapter.log.warn(
        `Invalid temperature calibration offset for ${this.userDefinedName}: ${value} \xB0C (allowed: -30 - +30 \xB0C).`
      );
      return;
    }
    const data = await this.callApi("/temperature-calibration-offset", false, "POST", { value });
    if (!data) {
      this.adapter.log.error(
        `Failed to set temperature calibration offset for ${this.userDefinedName} to ${value} \xB0C.`
      );
      return;
    }
    this.setStateChanged("settings.temperature_calibration_offset", value);
    await this.updateFastData();
    await this.updateSlowData();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MillDeviceType,
  MillHeaterDevice,
  detectDeviceType,
  normalizeMacAddress
});
//# sourceMappingURL=millHeaterDevice.js.map
