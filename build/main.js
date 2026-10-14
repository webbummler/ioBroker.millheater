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
var http = __toESM(require("node:http"));
var import_async_mutex = require("async-mutex");
class Millheater extends utils.Adapter {
  ipHostname = "";
  apiTimeout = 0;
  // Must match the limits in admin/jsonConfig.json
  apiTimeoutMin = 1;
  apiTimeoutMax = 60;
  pollInterval1 = 0;
  // Must match the limits in admin/jsonConfig.json
  pollInterval1Max = 3600;
  pollInterval2 = 0;
  // Must match the limits in admin/jsonConfig.json
  pollInterval2Max = 86400;
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
    const host = typeof this.config.host === "string" ? this.config.host.trim() : "";
    this.ipHostname = host;
    this.apiTimeout = this.config.apiTimeout;
    this.pollInterval1 = this.config.pollInterval1;
    this.pollInterval2 = this.config.pollInterval2;
    if (!this.ipHostname) {
      this.log.error("No IP address or hostname for the Mill heater is configured.");
      this.terminate(
        "No IP address or hostname for the Mill heater is configured.",
        utils.EXIT_CODES.INVALID_ADAPTER_CONFIG
      );
      return;
    }
    if (!Number.isInteger(this.apiTimeout) || this.apiTimeout < this.apiTimeoutMin || this.apiTimeout > this.apiTimeoutMax) {
      this.log.error(`HTTP timeout must be between ${this.apiTimeoutMin} and ${this.apiTimeoutMax} seconds.`);
      this.terminate(
        "HTTP timeout must be between ${this.apiTimeoutMin} and ${this.apiTimeoutMax} seconds.",
        utils.EXIT_CODES.INVALID_ADAPTER_CONFIG
      );
      return;
    }
    if (!Number.isInteger(this.pollInterval1) || this.pollInterval1 < this.apiTimeout + 1 || this.pollInterval1 > this.pollInterval1Max) {
      this.log.error(
        `Fast polling interval must be between ${this.apiTimeout + 1} and ${this.pollInterval1Max} seconds.`
      );
      this.terminate(
        `Fast polling interval must be between ${this.apiTimeout + 1} and ${this.pollInterval1Max} seconds.`,
        utils.EXIT_CODES.INVALID_ADAPTER_CONFIG
      );
      return;
    }
    if (!Number.isInteger(this.pollInterval2) || this.pollInterval2 < this.pollInterval1 + this.apiTimeout || this.pollInterval2 > this.pollInterval2Max) {
      this.log.error(
        `Slow polling interval must be between ${this.pollInterval1 + this.apiTimeout} and ${this.pollInterval2Max} seconds.`
      );
      this.terminate(
        `Slow polling interval must be between ${this.pollInterval1 + this.apiTimeout} and ${this.pollInterval2Max} seconds.`,
        utils.EXIT_CODES.INVALID_ADAPTER_CONFIG
      );
      return;
    }
    this.log.info("Configuration loaded.");
    this.log.info(`IP address / hostname: ${this.ipHostname}`);
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
    const url = `http://${this.ipHostname}${path}`;
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
    if (!this.heaterName) {
      await this.getStatus(skipIfBusy);
    }
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
          de: "Ger\xE4tename/Modell",
          ru: "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435/\u043C\u043E\u0434\u0435\u043B\u044C \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430",
          pt: "Nome/Modelo do dispositivo",
          nl: "Apparaatnaam/Model",
          fr: "Nom/Mod\xE8le de l'appareil",
          it: "Nome/Modello del dispositivo",
          es: "Nombre/modelo del dispositivo",
          pl: "Nazwa/model urz\u0105dzenia",
          uk: "\u041D\u0430\u0437\u0432\u0430/\u043C\u043E\u0434\u0435\u043B\u044C \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E",
          "zh-cn": "\u8BBE\u5907\u540D\u79F0/\u578B\u53F7"
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
          de: "Name des Ger\xE4ts",
          ru: "\u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u0441\u043A\u043E\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435",
          pt: "Nome personalizado",
          nl: "Aangepaste naam",
          fr: "Nom personnalis\xE9",
          it: "Nome personalizzato",
          es: "Nombre personalizado",
          pl: "Nazwa w\u0142asna",
          uk: "\u0412\u043B\u0430\u0441\u043D\u0430 \u043D\u0430\u0437\u0432\u0430",
          "zh-cn": "\u81EA\u5B9A\u4E49\u540D\u79F0"
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
          de: "API-/Firmwareversionsnummer",
          ru: "\u041D\u043E\u043C\u0435\u0440 \u0432\u0435\u0440\u0441\u0438\u0438 API/\u043F\u0440\u043E\u0448\u0438\u0432\u043A\u0438",
          pt: "N\xFAmero da vers\xE3o da API/firmware",
          nl: "API-/firmwareversienummer",
          fr: "Num\xE9ro de version de l\u2019API/du firmware",
          it: "Numero di versione API/firmware",
          es: "N\xFAmero de versi\xF3n de la API/firmware",
          pl: "Numer wersji API/oprogramowania uk\u0142adowego",
          uk: "\u041D\u043E\u043C\u0435\u0440 \u0432\u0435\u0440\u0441\u0456\u0457 API/\u043F\u0440\u043E\u0448\u0438\u0432\u043A\u0438",
          "zh-cn": "API/\u56FA\u4EF6\u7248\u672C\u53F7"
        },
        type: "string",
        role: "info.firmware",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("status.operation_key", {
      type: "state",
      common: {
        name: {
          en: "If an operational problem occurs (e.g. a faulty temperature sensor), it may be reported in this field.",
          de: "Wenn ein Betriebsproblem auftritt (z. B. ein defekter Temperatursensor), kann es in diesem Feld gemeldet werden.",
          ru: "\u041F\u0440\u0438 \u0432\u043E\u0437\u043D\u0438\u043A\u043D\u043E\u0432\u0435\u043D\u0438\u0438 \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u044B \u0432 \u0440\u0430\u0431\u043E\u0442\u0435 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, \u043D\u0435\u0438\u0441\u043F\u0440\u0430\u0432\u043D\u043E\u0441\u0442\u0438 \u0434\u0430\u0442\u0447\u0438\u043A\u0430 \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u044B) \u043E\u043D\u0430 \u043C\u043E\u0436\u0435\u0442 \u043E\u0442\u043E\u0431\u0440\u0430\u0436\u0430\u0442\u044C\u0441\u044F \u0432 \u044D\u0442\u043E\u043C \u043F\u043E\u043B\u0435.",
          pt: "Se ocorrer um problema de funcionamento (por exemplo, um sensor de temperatura avariado), ele poder\xE1 ser indicado neste campo.",
          nl: "Als er een probleem met de werking optreedt (bijvoorbeeld een defecte temperatuursensor), kan dit in dit veld worden gemeld.",
          fr: "En cas de probl\xE8me de fonctionnement (par exemple, un capteur de temp\xE9rature d\xE9fectueux), celui-ci peut \xEAtre signal\xE9 dans ce champ.",
          it: "Se si verifica un problema di funzionamento (ad esempio, un sensore di temperatura guasto), pu\xF2 essere segnalato in questo campo.",
          es: "Si se produce un problema de funcionamiento (por ejemplo, un sensor de temperatura averiado), puede indicarse en este campo.",
          pl: "Je\u015Bli wyst\u0105pi problem z dzia\u0142aniem (np. uszkodzony czujnik temperatury), mo\u017Ce on zosta\u0107 zg\u0142oszony w tym polu.",
          uk: "\u042F\u043A\u0449\u043E \u0432\u0438\u043D\u0438\u043A\u0430\u0454 \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u0430 \u0432 \u0440\u043E\u0431\u043E\u0442\u0456 (\u043D\u0430\u043F\u0440\u0438\u043A\u043B\u0430\u0434, \u043D\u0435\u0441\u043F\u0440\u0430\u0432\u043D\u0438\u0439 \u0434\u0430\u0442\u0447\u0438\u043A \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0438), \u0457\u0457 \u043C\u043E\u0436\u043D\u0430 \u0432\u043A\u0430\u0437\u0430\u0442\u0438 \u0432 \u0446\u044C\u043E\u043C\u0443 \u043F\u043E\u043B\u0456.",
          "zh-cn": "\u5982\u679C\u51FA\u73B0\u8FD0\u884C\u95EE\u9898\uFF08\u4F8B\u5982\u6E29\u5EA6\u4F20\u611F\u5668\u635F\u574F\uFF09\uFF0C\u53EF\u4EE5\u5728\u6B64\u5B57\u6BB5\u4E2D\u62A5\u544A\u3002"
        },
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
        name: {
          en: "Device MAC (Media Access Control) address",
          de: "MAC-Adresse (Media Access Control) des Ger\xE4ts",
          ru: "MAC-\u0430\u0434\u0440\u0435\u0441 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430 (Media Access Control)",
          pt: "Endere\xE7o MAC (Media Access Control) do dispositivo",
          nl: "MAC-adres (Media Access Control) van het apparaat",
          fr: "Adresse MAC (Media Access Control) de l\u2019appareil",
          it: "Indirizzo MAC (Media Access Control) del dispositivo",
          es: "Direcci\xF3n MAC (Media Access Control) del dispositivo",
          pl: "Adres MAC (Media Access Control) urz\u0105dzenia",
          uk: "MAC-\u0430\u0434\u0440\u0435\u0441\u0430 \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E (Media Access Control)",
          "zh-cn": "\u8BBE\u5907\u7684 MAC \u5730\u5740\uFF08\u5A92\u4F53\u8BBF\u95EE\u63A7\u5236\uFF09"
        },
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
        name: {
          en: "Temperature measured by the sensor in degrees Celsius, including the calibration offset",
          de: "Vom Sensor gemessene Temperatur in Grad Celsius einschlie\xDFlich Kalibrierkorrektur",
          ru: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430, \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u0430\u044F \u0434\u0430\u0442\u0447\u0438\u043A\u043E\u043C \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0438\u044F, \u0441 \u0443\u0447\u0435\u0442\u043E\u043C \u043A\u0430\u043B\u0438\u0431\u0440\u043E\u0432\u043E\u0447\u043D\u043E\u0439 \u043F\u043E\u043F\u0440\u0430\u0432\u043A\u0438",
          pt: "Temperatura medida pelo sensor em graus Celsius, incluindo a corre\xE7\xE3o de calibra\xE7\xE3o",
          nl: "Door de sensor gemeten temperatuur in graden Celsius, inclusief kalibratiecorrectie",
          fr: "Temp\xE9rature mesur\xE9e par le capteur en degr\xE9s Celsius, correction d\u2019\xE9talonnage incluse",
          it: "Temperatura misurata dal sensore in gradi Celsius, inclusa la correzione di calibrazione",
          es: "Temperatura medida por el sensor en grados Celsius, incluida la correcci\xF3n de calibraci\xF3n",
          pl: "Temperatura zmierzona przez czujnik w stopniach Celsjusza, z uwzgl\u0119dnieniem korekty kalibracji",
          uk: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430, \u0432\u0438\u043C\u0456\u0440\u044F\u043D\u0430 \u0434\u0430\u0442\u0447\u0438\u043A\u043E\u043C \u0443 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0456\u044F, \u0437 \u0443\u0440\u0430\u0445\u0443\u0432\u0430\u043D\u043D\u044F\u043C \u043A\u0430\u043B\u0456\u0431\u0440\u0443\u0432\u0430\u043B\u044C\u043D\u043E\u0457 \u043F\u043E\u043F\u0440\u0430\u0432\u043A\u0438",
          "zh-cn": "\u4F20\u611F\u5668\u6D4B\u5F97\u7684\u6444\u6C0F\u6E29\u5EA6\uFF0C\u5305\u542B\u6821\u51C6\u504F\u79FB\u91CF"
        },
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
        name: {
          en: "Indicates whether the device is connected to the cloud",
          de: "Gibt an, ob das Ger\xE4t mit der Cloud verbunden ist",
          ru: "\u0423\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442, \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u043B\u0438 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u043A \u043E\u0431\u043B\u0430\u043A\u0443",
          pt: "Indica se o dispositivo est\xE1 conectado \xE0 nuvem",
          nl: "Geeft aan of het apparaat met de cloud is verbonden",
          fr: "Indique si l\u2019appareil est connect\xE9 au cloud",
          it: "Indica se il dispositivo \xE8 connesso al cloud",
          es: "Indica si el dispositivo est\xE1 conectado a la nube",
          pl: "Informuje, czy urz\u0105dzenie jest po\u0142\u0105czone z chmur\u0105",
          uk: "\u0412\u043A\u0430\u0437\u0443\u0454, \u0447\u0438 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u043F\u0440\u0438\u0441\u0442\u0440\u0456\u0439 \u0434\u043E \u0445\u043C\u0430\u0440\u0438",
          "zh-cn": "\u6307\u793A\u8BBE\u5907\u662F\u5426\u5DF2\u8FDE\u63A5\u5230\u4E91\u7AEF"
        },
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
        name: {
          en: "Control signal of the PID controller (0\u2013100%)",
          de: "Stellsignal des PID-Reglers (0\u2013100 %)",
          ru: "\u0423\u043F\u0440\u0430\u0432\u043B\u044F\u044E\u0449\u0438\u0439 \u0441\u0438\u0433\u043D\u0430\u043B \u041F\u0418\u0414-\u0440\u0435\u0433\u0443\u043B\u044F\u0442\u043E\u0440\u0430 (0\u2013100 %)",
          pt: "Sinal de controlo do regulador PID (0\u2013100%)",
          nl: "Stuursignaal van de PID-regelaar (0\u2013100%)",
          fr: "Signal de commande du r\xE9gulateur PID (0\u2013100 %)",
          it: "Segnale di controllo del regolatore PID (0\u2013100%)",
          es: "Se\xF1al de control del regulador PID (0\u2013100 %)",
          pl: "Sygna\u0142 steruj\u0105cy regulatora PID (0\u2013100%)",
          uk: "\u041A\u0435\u0440\u0443\u044E\u0447\u0438\u0439 \u0441\u0438\u0433\u043D\u0430\u043B \u041F\u0406\u0414-\u0440\u0435\u0433\u0443\u043B\u044F\u0442\u043E\u0440\u0430 (0\u2013100 %)",
          "zh-cn": "PID \u63A7\u5236\u5668\u7684\u63A7\u5236\u4FE1\u53F7\uFF080\u2013100%\uFF09"
        },
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
        name: {
          en: "Current heating power in watts",
          de: "Aktuelle Heizleistung in Watt",
          ru: "\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u043C\u043E\u0449\u043D\u043E\u0441\u0442\u044C \u043D\u0430\u0433\u0440\u0435\u0432\u0430 \u0432 \u0432\u0430\u0442\u0442\u0430\u0445",
          pt: "Pot\xEAncia de aquecimento atual em watts",
          nl: "Huidig verwarmingsvermogen in watt",
          fr: "Puissance de chauffage actuelle en watts",
          it: "Potenza di riscaldamento attuale in watt",
          es: "Potencia de calefacci\xF3n actual en vatios",
          pl: "Aktualna moc grzewcza w watach",
          uk: "\u041F\u043E\u0442\u043E\u0447\u043D\u0430 \u043F\u043E\u0442\u0443\u0436\u043D\u0456\u0441\u0442\u044C \u043D\u0430\u0433\u0440\u0456\u0432\u0430\u043D\u043D\u044F \u0443 \u0432\u0430\u0442\u0430\u0445",
          "zh-cn": "\u5F53\u524D\u52A0\u70ED\u529F\u7387\uFF08\u74E6\uFF09"
        },
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
        name: {
          en: "Lock status (No lock, Child lock, Commercial lock)",
          de: "Sperrstatus (No lock, Child lock, Commercial lock)",
          ru: "\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u043A\u0438 (No lock, Child lock, Commercial lock)",
          pt: "Estado do bloqueio (No lock, Child lock, Commercial lock)",
          nl: "Vergrendelingsstatus (No lock, Child lock, Commercial lock)",
          fr: "\xC9tat du verrouillage (No lock, Child lock, Commercial lock)",
          it: "Stato del blocco (No lock, Child lock, Commercial lock)",
          es: "Estado del bloqueo (No lock, Child lock, Commercial lock)",
          pl: "Stan blokady (No lock, Child lock, Commercial lock)",
          uk: "\u0421\u0442\u0430\u043D \u0431\u043B\u043E\u043A\u0443\u0432\u0430\u043D\u043D\u044F (No lock, Child lock, Commercial lock)",
          "zh-cn": "\u9501\u5B9A\u72B6\u6001\uFF08No lock, Child lock, Commercial lock\uFF09"
        },
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
        name: {
          en: "Open-window status (Disabled not active now, Enabled active now, Enabled not active now)",
          de: "Status der Fenstererkennung (Disabled not active now, Enabled active now, Enabled not active now)",
          ru: "\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u043E\u0431\u043D\u0430\u0440\u0443\u0436\u0435\u043D\u0438\u044F \u043E\u0442\u043A\u0440\u044B\u0442\u043E\u0433\u043E \u043E\u043A\u043D\u0430 (Disabled not active now, Enabled active now, Enabled not active now)",
          pt: "Estado da dete\xE7\xE3o de janela aberta (Disabled not active now, Enabled active now, Enabled not active now)",
          nl: "Status van openraamdetectie (Disabled not active now, Enabled active now, Enabled not active now)",
          fr: "\xC9tat de la d\xE9tection de fen\xEAtre ouverte (Disabled not active now, Enabled active now, Enabled not active now)",
          it: "Stato del rilevamento della finestra aperta (Disabled not active now, Enabled active now, Enabled not active now)",
          es: "Estado de la detecci\xF3n de ventana abierta (Disabled not active now, Enabled active now, Enabled not active now)",
          pl: "Stan wykrywania otwartego okna (Disabled not active now, Enabled active now, Enabled not active now)",
          uk: "\u0421\u0442\u0430\u043D \u0432\u0438\u044F\u0432\u043B\u0435\u043D\u043D\u044F \u0432\u0456\u0434\u043A\u0440\u0438\u0442\u043E\u0433\u043E \u0432\u0456\u043A\u043D\u0430 (Disabled not active now, Enabled active now, Enabled not active now)",
          "zh-cn": "\u5F00\u7A97\u68C0\u6D4B\u72B6\u6001\uFF08Disabled not active now, Enabled active now, Enabled not active now\uFF09"
        },
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
        name: {
          en: "Current mode of operation",
          de: "Aktueller Betriebsmodus",
          ru: "\u0422\u0435\u043A\u0443\u0449\u0438\u0439 \u0440\u0435\u0436\u0438\u043C \u0440\u0430\u0431\u043E\u0442\u044B",
          pt: "Modo de funcionamento atual",
          nl: "Huidige bedrijfsmodus",
          fr: "Mode de fonctionnement actuel",
          it: "Modalit\xE0 operativa corrente",
          es: "Modo de funcionamiento actual",
          pl: "Aktualny tryb pracy",
          uk: "\u041F\u043E\u0442\u043E\u0447\u043D\u0438\u0439 \u0440\u0435\u0436\u0438\u043C \u0440\u043E\u0431\u043E\u0442\u0438",
          "zh-cn": "\u5F53\u524D\u8FD0\u884C\u6A21\u5F0F"
        },
        type: "string",
        role: "state",
        read: true,
        write: true,
        states: {
          Off: "Off",
          "Weekly program": "Weekly program",
          "Independent device": "Independent device",
          "Control individually": "Control individually"
        }
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("control-status.raw_ambient_temperature", {
      type: "state",
      common: {
        name: {
          en: "Temperature measured by the sensor in degrees Celsius, without the calibration offset",
          de: "Vom Sensor gemessene Temperatur in Grad Celsius ohne Kalibrierkorrektur",
          ru: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430, \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u0430\u044F \u0434\u0430\u0442\u0447\u0438\u043A\u043E\u043C \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0438\u044F, \u0431\u0435\u0437 \u043A\u0430\u043B\u0438\u0431\u0440\u043E\u0432\u043E\u0447\u043D\u043E\u0439 \u043F\u043E\u043F\u0440\u0430\u0432\u043A\u0438",
          pt: "Temperatura medida pelo sensor em graus Celsius, sem a corre\xE7\xE3o de calibra\xE7\xE3o",
          nl: "Door de sensor gemeten temperatuur in graden Celsius, zonder kalibratiecorrectie",
          fr: "Temp\xE9rature mesur\xE9e par le capteur en degr\xE9s Celsius, sans correction d\u2019\xE9talonnage",
          it: "Temperatura misurata dal sensore in gradi Celsius, senza correzione di calibrazione",
          es: "Temperatura medida por el sensor en grados Celsius, sin la correcci\xF3n de calibraci\xF3n",
          pl: "Temperatura zmierzona przez czujnik w stopniach Celsjusza, bez korekty kalibracji",
          uk: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430, \u0432\u0438\u043C\u0456\u0440\u044F\u043D\u0430 \u0434\u0430\u0442\u0447\u0438\u043A\u043E\u043C \u0443 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0456\u044F, \u0431\u0435\u0437 \u043A\u0430\u043B\u0456\u0431\u0440\u0443\u0432\u0430\u043B\u044C\u043D\u043E\u0457 \u043F\u043E\u043F\u0440\u0430\u0432\u043A\u0438",
          "zh-cn": "\u4F20\u611F\u5668\u6D4B\u5F97\u7684\u6444\u6C0F\u6E29\u5EA6\uFF0C\u4E0D\u5305\u542B\u6821\u51C6\u504F\u79FB\u91CF"
        },
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
        name: {
          en: "Current set temperature in degrees Celsius",
          de: "Aktuelle Solltemperatur in Grad Celsius",
          ru: "\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0437\u0430\u0434\u0430\u043D\u043D\u0430\u044F \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430 \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0438\u044F",
          pt: "Temperatura definida atual em graus Celsius",
          nl: "Huidige ingestelde temperatuur in graden Celsius",
          fr: "Temp\xE9rature de consigne actuelle en degr\xE9s Celsius",
          it: "Temperatura impostata attuale in gradi Celsius",
          es: "Temperatura de consigna actual en grados Celsius",
          pl: "Aktualna temperatura zadana w stopniach Celsjusza",
          uk: "\u041F\u043E\u0442\u043E\u0447\u043D\u0430 \u0437\u0430\u0434\u0430\u043D\u0430 \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430 \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0456\u044F",
          "zh-cn": "\u5F53\u524D\u8BBE\u5B9A\u6E29\u5EA6\uFF08\u6444\u6C0F\u5EA6\uFF09"
        },
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
        name: {
          en: "Indicates whether the device is switched on and set to operate with heating",
          de: "Gibt an, ob das Ger\xE4t eingeschaltet und zum Heizen aktiviert ist",
          ru: "\u0423\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442, \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u043B\u0438 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u0438 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043E \u043B\u0438 \u043E\u043D\u043E \u043D\u0430 \u0440\u0430\u0431\u043E\u0442\u0443 \u0441 \u043E\u0431\u043E\u0433\u0440\u0435\u0432\u043E\u043C",
          pt: "Indica se o dispositivo est\xE1 ligado e configurado para funcionar com aquecimento",
          nl: "Geeft aan of het apparaat is ingeschakeld en is ingesteld om te verwarmen",
          fr: "Indique si l\u2019appareil est allum\xE9 et r\xE9gl\xE9 pour fonctionner en mode chauffage",
          it: "Indica se il dispositivo \xE8 acceso e impostato per funzionare con il riscaldamento",
          es: "Indica si el dispositivo est\xE1 encendido y configurado para funcionar con calefacci\xF3n",
          pl: "Informuje, czy urz\u0105dzenie jest w\u0142\u0105czone i ustawione do pracy z ogrzewaniem",
          uk: "\u0412\u043A\u0430\u0437\u0443\u0454, \u0447\u0438 \u0443\u0432\u0456\u043C\u043A\u043D\u0435\u043D\u043E \u043F\u0440\u0438\u0441\u0442\u0440\u0456\u0439 \u0456 \u043D\u0430\u043B\u0430\u0448\u0442\u043E\u0432\u0430\u043D\u043E \u0439\u043E\u0433\u043E \u043D\u0430 \u0440\u043E\u0431\u043E\u0442\u0443 \u0437 \u043E\u0431\u0456\u0433\u0440\u0456\u0432\u043E\u043C",
          "zh-cn": "\u6307\u793A\u8BBE\u5907\u662F\u5426\u5DF2\u5F00\u542F\u5E76\u8BBE\u7F6E\u4E3A\u52A0\u70ED\u8FD0\u884C"
        },
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
        name: {
          en: "Heating level in percent",
          de: "Heizstufe in Prozent",
          ru: "\u0423\u0440\u043E\u0432\u0435\u043D\u044C \u043D\u0430\u0433\u0440\u0435\u0432\u0430 \u0432 \u043F\u0440\u043E\u0446\u0435\u043D\u0442\u0430\u0445",
          pt: "N\xEDvel de aquecimento em percentagem",
          nl: "Verwarmingsniveau in procenten",
          fr: "Niveau de chauffage en pourcentage",
          it: "Livello di riscaldamento in percentuale",
          es: "Nivel de calefacci\xF3n en porcentaje",
          pl: "Poziom ogrzewania w procentach",
          uk: "\u0420\u0456\u0432\u0435\u043D\u044C \u043D\u0430\u0433\u0440\u0456\u0432\u0430\u043D\u043D\u044F \u0443 \u0432\u0456\u0434\u0441\u043E\u0442\u043A\u0430\u0445",
          "zh-cn": "\u52A0\u70ED\u7B49\u7EA7\uFF08\u767E\u5206\u6BD4\uFF09"
        },
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
        name: {
          en: "Percentage of maximum power the heater can use (10\u2013100)",
          de: "Prozentsatz der maximalen Leistung, die der Heizk\xF6rper nutzen darf (10\u2013100)",
          ru: "\u041F\u0440\u043E\u0446\u0435\u043D\u0442 \u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u043E\u0439 \u043C\u043E\u0449\u043D\u043E\u0441\u0442\u0438, \u043A\u043E\u0442\u043E\u0440\u0443\u044E \u043C\u043E\u0436\u0435\u0442 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C \u043E\u0431\u043E\u0433\u0440\u0435\u0432\u0430\u0442\u0435\u043B\u044C (10\u2013100)",
          pt: "Percentagem da pot\xEAncia m\xE1xima que o aquecedor pode utilizar (10\u2013100)",
          nl: "Percentage van het maximale vermogen dat de verwarming mag gebruiken (10\u2013100)",
          fr: "Pourcentage de la puissance maximale que le radiateur peut utiliser (10\u2013100)",
          it: "Percentuale della potenza massima che il riscaldatore pu\xF2 utilizzare (10\u2013100)",
          es: "Porcentaje de la potencia m\xE1xima que puede utilizar el calefactor (10\u2013100)",
          pl: "Procent maksymalnej mocy, kt\xF3r\u0105 mo\u017Ce wykorzystywa\u0107 grzejnik (10\u2013100)",
          uk: "\u0412\u0456\u0434\u0441\u043E\u0442\u043E\u043A \u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u043E\u0457 \u043F\u043E\u0442\u0443\u0436\u043D\u043E\u0441\u0442\u0456, \u044F\u043A\u0443 \u043C\u043E\u0436\u0435 \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u043E\u0432\u0443\u0432\u0430\u0442\u0438 \u043E\u0431\u0456\u0433\u0440\u0456\u0432\u0430\u0447 (10\u2013100)",
          "zh-cn": "\u52A0\u70ED\u5668\u53EF\u4F7F\u7528\u7684\u6700\u5927\u529F\u7387\u767E\u5206\u6BD4\uFF0810\u2013100\uFF09"
        },
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
        name: {
          en: "Temperature calibration offset in degrees Celsius",
          de: "Temperatur-Kalibrierkorrektur in Grad Celsius",
          ru: "\u041F\u043E\u043F\u0440\u0430\u0432\u043A\u0430 \u043A\u0430\u043B\u0438\u0431\u0440\u043E\u0432\u043A\u0438 \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u044B \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0438\u044F",
          pt: "Corre\xE7\xE3o de calibra\xE7\xE3o da temperatura em graus Celsius",
          nl: "Temperatuurkalibratiecorrectie in graden Celsius",
          fr: "Correction d\u2019\xE9talonnage de la temp\xE9rature en degr\xE9s Celsius",
          it: "Correzione di calibrazione della temperatura in gradi Celsius",
          es: "Correcci\xF3n de calibraci\xF3n de la temperatura en grados Celsius",
          pl: "Korekta kalibracji temperatury w stopniach Celsjusza",
          uk: "\u041F\u043E\u043F\u0440\u0430\u0432\u043A\u0430 \u043A\u0430\u043B\u0456\u0431\u0440\u0443\u0432\u0430\u043D\u043D\u044F \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0438 \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0456\u044F",
          "zh-cn": "\u6E29\u5EA6\u6821\u51C6\u504F\u79FB\u91CF\uFF08\u6444\u6C0F\u5EA6\uFF09"
        },
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
