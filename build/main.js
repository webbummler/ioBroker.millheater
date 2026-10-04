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
var utils = __toESM(require("@iobroker/adapter-core"));
var http = __toESM(require("http"));
var import_async_mutex = require("async-mutex");
class Millheater extends utils.Adapter {
  ipAddress = "";
  apiTimeout = 0;
  pollInterval1 = 0;
  pollInterval2 = 0;
  heaterName = "";
  isUnloading = false;
  pollTimer1;
  pollTimer2;
  apiMutex = new import_async_mutex.Mutex();
  constructor(options = {}) {
    super({
      ...options,
      name: "millheater",
      // Der Core wartet hier explizit auf Promises!
      ready: () => this.onReady()
    });
    this.on("stateChange", (id, state) => {
      this.onStateChange(id, state);
    });
    this.on("unload", (callback) => {
      this.onUnload(callback);
    });
  }
  /**
   * Adapter startup.
   */
  async onReady() {
    this.log.info("Mill Heater Adapter started.");
    const ip = typeof this.config.ip === "string" ? this.config.ip.trim() : "";
    this.ipAddress = ip;
    this.apiTimeout = this.config.apiTimeout;
    this.pollInterval1 = this.config.pollInterval1;
    this.pollInterval2 = this.config.pollInterval2;
    if (!this.ipAddress) {
      this.log.error("No IP address for the Mill heater is configured.");
      this.terminate("No IP address for the Mill heater is configured.", utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
      return;
    }
    if (!Number.isFinite(this.apiTimeout) || this.apiTimeout < 1) {
      this.log.error(`HTTP interval must be at least 1 second.`);
      this.terminate("HTTP interval must be at least 1 second.", utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
      return;
    }
    if (!Number.isFinite(this.pollInterval1) || this.pollInterval1 < this.apiTimeout) {
      this.log.error(`Fast polling interval must be at least ${this.apiTimeout + 1} seconds.`);
      this.terminate(
        `Fast polling interval must be at least ${this.apiTimeout + 1} seconds.`,
        utils.EXIT_CODES.INVALID_ADAPTER_CONFIG
      );
      return;
    }
    if (!Number.isFinite(this.pollInterval2) || this.pollInterval2 < this.pollInterval1 + this.apiTimeout) {
      this.log.error(`Slow polling interval must be at least ${this.pollInterval1 + this.apiTimeout} seconds.`);
      this.terminate(
        `Slow polling interval must be at least ${this.pollInterval1 + this.apiTimeout} seconds.`,
        utils.EXIT_CODES.INVALID_ADAPTER_CONFIG
      );
      return;
    }
    this.log.info("Configuration loaded.");
    this.log.info(`IP address: ${this.ipAddress}`);
    this.log.info(`HTTP timeout: ${this.apiTimeout}`);
    this.log.info(`Polling interval 1: ${this.pollInterval1} seconds`);
    this.log.info(`Polling interval 2: ${this.pollInterval2} seconds`);
    await this.createObjects();
    this.log.info("Object structure created.");
    this.subscribeStates("*");
    await this.updateSlowData();
    await this.updateFastData();
    this.pollTimer1 = this.setInterval(() => {
      void this.updateFastData(true);
    }, this.pollInterval1 * 1e3);
    this.pollTimer2 = this.setInterval(() => {
      void this.updateSlowData(true);
    }, this.pollInterval2 * 1e3);
    this.log.info("Polling timers started.");
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
    if (this.isUnloading) {
      return void 0;
    }
    if (skipIfBusy && method !== "GET") {
      throw new Error("The skip option is only supported for GET requests.");
    }
    try {
      if (skipIfBusy) {
        return await (0, import_async_mutex.tryAcquire)(this.apiMutex).runExclusive(() => this.performApiRequest(path, method, body));
      }
      return await this.apiMutex.runExclusive(() => this.performApiRequest(path, method, body));
    } catch (error) {
      if (error === import_async_mutex.E_ALREADY_LOCKED) {
        this.log.debug(`Skipping API request ${method} ${path} because another request is already running.`);
        return void 0;
      }
      if (error === import_async_mutex.E_CANCELED && this.isUnloading) {
        this.log.debug(`Canceled API request ${method} ${path} because of shutdown.`);
        return void 0;
      }
      this.log.error(
        `Error executing API request ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
      return void 0;
    }
  }
  /**
   * Central Mill API request function.
   *
   * Configuration is deliberately not read here.
   * The IP address was already validated in onReady().
   *
   * HTTP errors, connection errors, timeouts, invalid JSON and
   * unsuccessful API responses are logged and returned as undefined.
   * A valid API response with status "ok" is returned unchanged.
   * info.connection reflects whether the heater responded to the HTTP request.
   * It is set to true when an HTTP response is received and to false
   * for connection errors and timeouts.
   *
   * @param path API endpoint.
   * @param method HTTP method.
   * @param body JSON request body.
   */
  async performApiRequest(path, method = "GET", body) {
    const url = `http://${this.ipAddress}${path}`;
    const headers = {};
    const jsonBody = body !== void 0 ? JSON.stringify(body) : void 0;
    if (jsonBody !== void 0) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(jsonBody);
    }
    this.log.debug(`Request: ${method} ${url}, Header: ${JSON.stringify(headers)}, Request body: ${jsonBody}`);
    return new Promise((resolve) => {
      const request = http.request(
        url,
        {
          method,
          headers
        },
        (response) => {
          let data = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            data += chunk;
          });
          response.on("end", () => {
            const statusCode = response.statusCode;
            this.log.debug(`HTTP status for ${path}: ${statusCode != null ? statusCode : "undefined"}`);
            void this.setState("info.connection", true, true);
            if (statusCode === void 0 || statusCode < 200 || statusCode >= 300) {
              this.log.error(`Mill API request failed for ${path}: HTTP ${statusCode != null ? statusCode : "unknown"}.`);
              if (data.trim()) {
                this.log.error(`Mill API response: ${data}`);
              }
              resolve(void 0);
              return;
            }
            if (!data.trim()) {
              this.log.error(`Empty response from ${path}.`);
              resolve(void 0);
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                this.log.error(`Invalid API response from ${path}: response is not an object.`);
                resolve(void 0);
                return;
              }
              const dataRecord = parsed;
              if (dataRecord.status !== "ok") {
                this.log.error(
                  `Mill API rejected request to ${path}: status=${String(dataRecord.status)}.`
                );
                resolve(void 0);
                return;
              }
              resolve(dataRecord);
            } catch (error) {
              this.log.error(
                `Invalid JSON response from ${path}: ${error instanceof Error ? error.message : String(error)}`
              );
              resolve(void 0);
            }
          });
        }
      );
      request.on("error", (error) => {
        this.log.error(`Error calling ${path}: ${error.message}`);
        void this.setState("info.connection", false, true);
        resolve(void 0);
      });
      request.setTimeout(this.apiTimeout * 1e3, () => {
        this.log.error(`Timeout calling ${path}.`);
        void this.setState("info.connection", false, true);
        request.destroy();
        resolve(void 0);
      });
      if (jsonBody !== void 0) {
        request.write(jsonBody);
      }
      request.end();
    });
  }
  /**
   * Fast update cycle.
   *
   * Valid API values are written to the corresponding states.
   * Invalid, missing or unavailable API values leave the existing state unchanged.
   *
   * @param skipIfBusy If API is busy, skip this request.
   */
  async updateFastData(skipIfBusy = false) {
    await this.getControlStatus(skipIfBusy);
    const heaterName = this.heaterName.toLowerCase();
    if (heaterName.includes("oil")) {
      await this.getHeatingLevelPercentage(skipIfBusy);
    } else if (heaterName.includes("panel")) {
      await this.getLimitedHeatingPower(skipIfBusy);
    }
  }
  /**
   * Slow update cycle.
   *
   * Valid API values are written to the corresponding states.
   * Invalid, missing or unavailable API values leave the existing state unchanged.  
   *
   * @param skipIfBusy If API is busy, skip this request.
   */
  async updateSlowData(skipIfBusy = false) {
    await this.getStatus(skipIfBusy);
    await this.getTemperatureCalibrationOffset(skipIfBusy);
  }
  /**
   * Read current control status.
   *
   * @param skipIfBusy If API is busy, skip this request.
   */
  async getControlStatus(skipIfBusy = false) {
    this.log.debug("getControlStatus started.");
    const data = await this.callApi("/control-status", skipIfBusy);
    if (!data) {
      return false;
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
    if (ambientTemperature !== void 0) {
      void this.setState("control-status.ambient_temperature", ambientTemperature, true);
    }
    if (connectedToCloud !== void 0) {
      void this.setState("control-status.connected_to_cloud", connectedToCloud, true);
    }
    if (controlSignal !== void 0) {
      void this.setState("control-status.control_signal", controlSignal, true);
    }
    if (currentPower !== void 0) {
      void this.setState("control-status.current_power", currentPower, true);
    }
    if (lockActive !== void 0) {
      void this.setState("control-status.lock_active", lockActive, true);
    }
    if (openWindowActiveNow !== void 0) {
      void this.setState("control-status.open_window_active_now", openWindowActiveNow, true);
    }
    if (operationMode !== void 0) {
      void this.setState("control-status.operation_mode", operationMode, true);
    }
    if (rawAmbientTemperature !== void 0) {
      void this.setState("control-status.raw_ambient_temperature", rawAmbientTemperature, true);
    }
    if (setTemperature !== void 0) {
      void this.setState("control-status.set_temperature", setTemperature, true);
    }
    if (switchedOn !== void 0) {
      void this.setState("control-status.switched_on", switchedOn, true);
    }
    this.log.debug("Control status updated.");
    return true;
  }
  /**
   * Read basic heater status.
   *
   * @param skipIfBusy If API is busy, skip this request.
   */
  async getStatus(skipIfBusy = false) {
    this.log.debug("getStatus started.");
    const data = await this.callApi("/status", skipIfBusy);
    if (!data) {
      return;
    }
    const name = typeof data.name === "string" ? data.name : void 0;
    const customName = typeof data.custom_name === "string" ? data.custom_name : void 0;
    const version = typeof data.version === "string" ? data.version : void 0;
    const operationKey = typeof data.operation_key === "string" ? data.operation_key : void 0;
    const macAddress = typeof data.mac_address === "string" ? data.mac_address : void 0;
    if (name !== void 0) {
      this.heaterName = name;
      void this.setState("status.name", name, true);
    }
    if (customName !== void 0) {
      void this.setState("status.custom_name", customName, true);
    }
    if (version !== void 0) {
      void this.setState("status.version", version, true);
    }
    if (operationKey !== void 0) {
      void this.setState("status.operation_key", operationKey, true);
    }
    if (macAddress !== void 0) {
      void this.setState("status.mac_address", macAddress, true);
    }
    this.log.debug("Status updated.");
  }
  /**
   * Read temperature calibration offset.
   *
   * @param skipIfBusy If API is busy, skip this request.
   */
  async getTemperatureCalibrationOffset(skipIfBusy = false) {
    this.log.debug("getTemperatureCalibrationOffset started.");
    const data = await this.callApi("/temperature-calibration-offset", skipIfBusy);
    if (!data) {
      return;
    }
    const temperatureCalibrationOffset = typeof data.value === "number" ? data.value : void 0;
    if (temperatureCalibrationOffset !== void 0) {
      void this.setState("settings.temperature_calibration_offset", temperatureCalibrationOffset, true);
    }
    this.log.debug("Temperature calibration offset updated.");
  }
  /**
   * Read oil heater power.
   *
   * @param skipIfBusy If API is busy, skip this request.
   */
  async getHeatingLevelPercentage(skipIfBusy = false) {
    this.log.debug("getHeatingLevelPercentage started.");
    const data = await this.callApi("/oil-heater-power", skipIfBusy);
    if (!data) {
      return;
    }
    const heatingLevelPercentage = typeof data.value === "number" ? data.value : void 0;
    if (heatingLevelPercentage !== void 0) {
      void this.setState("settings.heating_level_percentage", heatingLevelPercentage, true);
    }
    this.log.debug("Oil heater power updated.");
  }
  /**
   * Read panel heater power limitation.
   *
   * @param skipIfBusy If API is busy, skip this request.
   */
  async getLimitedHeatingPower(skipIfBusy = false) {
    this.log.debug("getLimitedHeatingPower started.");
    const data = await this.callApi("/limited-heating-power", skipIfBusy);
    if (!data) {
      return;
    }
    const limitedHeatingPower = typeof data.value === "number" ? data.value : void 0;
    if (limitedHeatingPower !== void 0) {
      void this.setState("settings.limited_heating_power", limitedHeatingPower, true);
    }
    this.log.debug("Limited heating power updated.");
  }
  /**
   * @param value the Operation mode of the heater.
   */
  async setOperationMode(value) {
    const validModes = ["Off", "Weekly program", "Independent device", "Control individually"];
    if (!validModes.includes(value)) {
      this.log.warn(`Invalid operation mode: "${value}".`);
      return;
    }
    const data = await this.callApi("/operation-mode", false, "POST", { mode: value });
    if (!data) {
      this.log.error(`Failed to set operation mode to "${value}".`);
      return;
    }
    void this.setState("control-status.operation_mode", value, true);
    this.log.debug(`Operation mode set to "${value}".`);
    await this.updateFastData();
  }
  /**
   * "Normal" is used for the temperature value in the selected operation mode "Control individually".
   *
   * @param value Target temperature.
   * The temperature can be set even when the device is switched off.
   * However, the configured temperature is only returned by the API
   * via GET/control-status after the device has been switched on.
   * Alternativ the temperature must be read by API via GET/set-temperature.
   */
  async setTemperature(value) {
    if (!Number.isFinite(value) || value < 5 || value > 35) {
      this.log.warn(`Invalid temperature: ${value} \xB0C (allowed: 5-35 \xB0C)`);
      return;
    }
    const data = await this.callApi("/set-temperature", false, "POST", { type: "Normal", value });
    if (!data) {
      this.log.error(`Failed to set temperature to ${value} \xB0C.`);
      return;
    }
    void this.setState("control-status.set_temperature", value, true);
    this.log.debug(`Temperature set to ${value} \xB0C.`);
    await this.updateFastData();
  }
  /**
   * The API accepts the heating level as a percentage of the nominal power.
   *
   * @param value Maximum heating level of an oil heater.
   */
  async setHeatingLevelPercentage(value) {
    if (!this.heaterName.toLowerCase().includes("oil")) {
      this.log.warn("Heating level percentage can only be set for oil heaters.");
      return;
    }
    if (value !== 40 && value !== 60 && value !== 100) {
      this.log.warn(`Invalid heating level percentage: ${value}. Allowed values are 40, 60 or 100.`);
      return;
    }
    const data = await this.callApi("/oil-heater-power", false, "POST", { heating_level_percentage: value });
    if (!data) {
      this.log.error(`Failed to set heating level percentage to ${value}%.`);
      return;
    }
    void this.setState("settings.heating_level_percentage", value, true);
    this.log.debug(`Heating level percentage set to ${value}%.`);
    await this.updateFastData();
  }
  /**
   * The API accepts the heating level as a percentage of maximum power.
   *
   * @param value Maximum heating power that the heater may use.
   */
  async setLimitedHeatingPower(value) {
    if (!this.heaterName.toLowerCase().includes("panel")) {
      this.log.warn("Limited heating power can only be set for panel heaters.");
      return;
    }
    if (!Number.isInteger(value) || value < 10 || value > 100) {
      this.log.warn(`Invalid limited heating power: ${value}. Allowed values are 10 to 100.`);
      return;
    }
    const data = await this.callApi("/limited-heating-power", false, "POST", { limited_heating_power: value });
    if (!data) {
      this.log.error(`Failed to set limited heating power to ${value}%.`);
      return;
    }
    void this.setState("settings.limited_heating_power", value, true);
    this.log.debug(`Limited heating power set to ${value}%.`);
    await this.updateFastData();
  }
  /**
   * @param value Temperature calibration offset.
   */
  async setTemperatureCalibrationOffset(value) {
    if (!Number.isFinite(value) || value < -30 || value > 30) {
      this.log.warn(`Invalid temperature calibration offset: ${value} \xB0C (allowed: -30 - +30 \xB0C)`);
      return;
    }
    const data = await this.callApi("/temperature-calibration-offset", false, "POST", { value });
    if (!data) {
      this.log.error(`Failed to set temperature calibration offset to ${value} \xB0C.`);
      return;
    }
    void this.setState("settings.temperature_calibration_offset", value, true);
    this.log.debug(`Temperature calibration offset set to ${value} \xB0C.`);
    await this.updateFastData();
    await this.updateSlowData();
  }
  /**
   * Create the complete object tree.
   *
   * setObjectNotExistsAsync() is deliberately used so existing
   * objects are not overwritten.
   */
  async createObjects() {
    await this.setObjectNotExistsAsync("info", {
      type: "channel",
      common: {
        name: "Information"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: {
        name: "Connection",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("status", {
      type: "channel",
      common: {
        name: "Status"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("status.name", {
      type: "state",
      common: {
        name: {
          en: "Device name/Model",
          de: "Bezeichnung des Ger\xE4ts/Ger\xE4temodell"
        },
        type: "string",
        role: "info.model",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("status.custom_name", {
      type: "state",
      common: {
        name: {
          en: "Custom name",
          de: "Name des Ger\xE4ts"
        },
        type: "string",
        role: "info.name",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("status.version", {
      type: "state",
      common: {
        name: {
          en: "API/Firmware version number",
          de: "API-/Firmwareversionsnummer"
        },
        type: "string",
        role: "info.version",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("status.operation_key", {
      type: "state",
      common: {
        name: "if there is some operation problem (like broken temperature sensor), it may be reported in this field",
        type: "string",
        role: "state",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("status.mac_address", {
      type: "state",
      common: {
        name: "device's MAC (Media Access Control) address",
        type: "string",
        role: "info.mac",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status", {
      type: "channel",
      common: {
        name: "Control status"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.ambient_temperature", {
      type: "state",
      common: {
        name: "the temperature measured by sensor in Celsius degrees (with calibration offset value included)",
        type: "number",
        role: "value.temperature",
        read: true,
        write: false,
        unit: "\xB0C"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.connected_to_cloud", {
      type: "state",
      common: {
        name: "the information whether device has connection with the cloud",
        type: "boolean",
        role: "sensor",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.control_signal", {
      type: "state",
      common: {
        name: "the control signal of the PID regulator (0-100%)",
        type: "number",
        role: "value",
        read: true,
        write: false,
        unit: "%",
        min: 0,
        max: 100
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.current_power", {
      type: "state",
      common: {
        name: "the current heating power in Watts",
        type: "number",
        role: "value.power",
        read: true,
        write: false,
        unit: "W"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.lock_active", {
      type: "state",
      common: {
        name: "the lock status (No lock, Child lock, Commercial lock)",
        type: "string",
        role: "state",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.open_window_active_now", {
      type: "state",
      common: {
        name: "the open window status (Disabled not active now, Enabled active now, Enabled not active now)",
        type: "string",
        role: "state",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.operation_mode", {
      type: "state",
      common: {
        name: "the current mode of operation",
        type: "string",
        role: "state",
        read: true,
        write: true,
        states: {
          Off: "Off",
          "Weekly program": "Weekly program",
          "Independent device": "Independent device",
          "Control individually": "Control individually",
          Invalid: "Invalid"
        }
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.raw_ambient_temperature", {
      type: "state",
      common: {
        name: "the temperature measured by sensor in Celsius degrees without calibration offset",
        type: "number",
        role: "value.temperature",
        read: true,
        write: false,
        unit: "\xB0C"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.set_temperature", {
      type: "state",
      common: {
        name: "the current set temperature in Celsius degrees",
        type: "number",
        role: "level.temperature",
        read: true,
        write: true,
        min: 5,
        max: 35,
        unit: "\xB0C"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.switched_on", {
      type: "state",
      common: {
        name: "true if the device is switched on - whether it is set to working, with heating",
        type: "boolean",
        role: "sensor.switch",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("settings", {
      type: "channel",
      common: {
        name: "Settings"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("settings.heating_level_percentage", {
      type: "state",
      common: {
        name: "the heating level in percentage",
        type: "number",
        role: "level",
        read: true,
        write: true,
        states: {
          40: "40",
          60: "60",
          100: "100"
        },
        unit: "%"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("settings.limited_heating_power", {
      type: "state",
      common: {
        name: "percentage of maximum power that heater can use, value in range 10 - 100",
        type: "number",
        role: "level",
        read: true,
        write: true,
        unit: "%",
        min: 10,
        max: 100
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("settings.temperature_calibration_offset", {
      type: "state",
      common: {
        name: "the calibration offset value in Celsius degrees",
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: -30,
        max: 30,
        unit: "\xB0C"
      },
      native: {}
    });
  }
  /**
   * Handle state changes.
   *
   * @param id id state ID
   * @param state state New state.
   */
  onStateChange(id, state) {
    if (!state) {
      this.log.debug(`State deleted: ${id}`);
      return;
    }
    if (state.ack !== false) {
      return;
    }
    switch (id) {
      case `${this.namespace}.control-status.operation_mode`:
        if (typeof state.val === "string") {
          void this.setOperationMode(state.val);
        }
        break;
      case `${this.namespace}.control-status.set_temperature`:
        if (typeof state.val === "number") {
          void this.setTemperature(state.val);
        } else {
          this.log.warn(`Invalid value for ${id}: expected a number.`);
        }
        break;
      case `${this.namespace}.settings.heating_level_percentage`:
        if (typeof state.val === "number") {
          void this.setHeatingLevelPercentage(state.val);
        } else {
          this.log.warn(`Invalid value for ${id}: expected a number.`);
        }
        break;
      case `${this.namespace}.settings.limited_heating_power`:
        if (typeof state.val === "number") {
          void this.setLimitedHeatingPower(state.val);
        } else {
          this.log.warn(`Invalid value for ${id}: expected a number.`);
        }
        break;
      case `${this.namespace}.settings.temperature_calibration_offset`:
        if (typeof state.val === "number") {
          void this.setTemperatureCalibrationOffset(state.val);
        } else {
          this.log.warn(`Invalid value for ${id}: expected a number.`);
        }
        break;
      default:
        this.log.debug(`Unsupported command for ${id}: ${String(state.val)}`);
        break;
    }
  }
  /**
   * @param callback Callback used to complete adapter shutdown.
   */
  onUnload(callback) {
    this.isUnloading = true;
    try {
      this.log.info("Mill Heater Adapter is shutting down.");
      if (this.pollTimer1 !== void 0) {
        this.clearInterval(this.pollTimer1);
        this.pollTimer1 = void 0;
      }
      if (this.pollTimer2 !== void 0) {
        this.clearInterval(this.pollTimer2);
        this.pollTimer2 = void 0;
      }
      this.apiMutex.cancel();
      void this.apiMutex.waitForUnlock().then(() => {
        callback();
      });
    } catch (error) {
      this.log.error(`Error during shutdown: ${error instanceof Error ? error.message : String(error)}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Millheater(options);
} else {
  (() => new Millheater())();
}
//# sourceMappingURL=main.js.map
