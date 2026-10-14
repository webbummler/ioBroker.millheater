/**
 * ioBroker Mill Heater Adapter
 */

import * as utils from "@iobroker/adapter-core";
import * as http from "node:http";
import { E_ALREADY_LOCKED, E_CANCELED, Mutex, tryAcquire } from "async-mutex";

class Millheater extends utils.Adapter {
	private ipHostname = "";
	private apiTimeout = 0;

	// Must match the limits in admin/jsonConfig.json
	private readonly apiTimeoutMin = 1;
	private readonly apiTimeoutMax = 60;

	private pollInterval1 = 0;

	// Must match the limits in admin/jsonConfig.json
	private readonly pollInterval1Max = 3600;

	private pollInterval2 = 0;

	// Must match the limits in admin/jsonConfig.json
	private readonly pollInterval2Max = 86400;

	private heaterName = "";
	private isUnloading = false;

	private pollTimer1: ioBroker.Interval | undefined;
	private pollTimer2: ioBroker.Interval | undefined;

	private readonly apiMutex = new Mutex();

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: "millheater",
			// Der Core wartet hier explizit auf Promises!
			ready: () => this.onReady(),
		});

		this.on("stateChange", (id, state) => {
			this.onStateChange(id, state);
		});

		this.on("unload", callback => {
			this.onUnload(callback);
		});
	}

	/**
	 * Adapter startup.
	 */
	private async onReady(): Promise<void> {
		this.log.info("Mill Heater Adapter started.");
		// Read and validate configuration once.
		const host = typeof this.config.host === "string" ? this.config.host.trim() : "";
		this.ipHostname = host;
		this.apiTimeout = this.config.apiTimeout;
		this.pollInterval1 = this.config.pollInterval1;
		this.pollInterval2 = this.config.pollInterval2;

		if (!this.ipHostname) {
			this.log.error("No IP address or hostname for the Mill heater is configured.");
			this.terminate(
				"No IP address or hostname for the Mill heater is configured.",
				utils.EXIT_CODES.INVALID_ADAPTER_CONFIG,
			);
			return;
		}

		if (
			!Number.isInteger(this.apiTimeout) ||
			this.apiTimeout < this.apiTimeoutMin ||
			this.apiTimeout > this.apiTimeoutMax
		) {
			this.log.error(`HTTP timeout must be between ${this.apiTimeoutMin} and ${this.apiTimeoutMax} seconds.`);
			this.terminate(
				"HTTP timeout must be between ${this.apiTimeoutMin} and ${this.apiTimeoutMax} seconds.",
				utils.EXIT_CODES.INVALID_ADAPTER_CONFIG,
			);
			return;
		}

		if (
			!Number.isInteger(this.pollInterval1) ||
			this.pollInterval1 < this.apiTimeout + 1 ||
			this.pollInterval1 > this.pollInterval1Max
		) {
			this.log.error(
				`Fast polling interval must be between ${this.apiTimeout + 1} and ${this.pollInterval1Max} seconds.`,
			);
			this.terminate(
				`Fast polling interval must be between ${this.apiTimeout + 1} and ${this.pollInterval1Max} seconds.`,
				utils.EXIT_CODES.INVALID_ADAPTER_CONFIG,
			);
			return;
		}

		if (
			!Number.isInteger(this.pollInterval2) ||
			this.pollInterval2 < this.pollInterval1 + this.apiTimeout ||
			this.pollInterval2 > this.pollInterval2Max
		) {
			this.log.error(
				`Slow polling interval must be between ${this.pollInterval1 + this.apiTimeout} and ${this.pollInterval2Max} seconds.`,
			);
			this.terminate(
				`Slow polling interval must be between ${this.pollInterval1 + this.apiTimeout} and ${this.pollInterval2Max} seconds.`,
				utils.EXIT_CODES.INVALID_ADAPTER_CONFIG,
			);
			return;
		}

		this.log.info("Configuration loaded.");
		this.log.info(`IP address / hostname: ${this.ipHostname}`);
		this.log.info(`HTTP timeout: ${this.apiTimeout}`);
		this.log.info(`Polling interval 1: ${this.pollInterval1} seconds`);
		this.log.info(`Polling interval 2: ${this.pollInterval2} seconds`);

		// Create the complete object tree before any states are updated.
		await this.createObjects();
		this.log.info("Object structure created.");
		this.subscribeStates("*");

		// Read slow data first because the heater name is required to determine the type-specific fast data.
		await this.updateSlowData();
		await this.updateFastData();

		// Use the ioBroker adapter timer functions.
		this.pollTimer1 = this.setInterval(() => {
			void this.updateFastData(true);
		}, this.pollInterval1 * 1000);

		this.pollTimer2 = this.setInterval(() => {
			void this.updateSlowData(true);
		}, this.pollInterval2 * 1000);

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
	private async callApi(
		path: string,
		skipIfBusy = false,
		method: "GET" | "POST" = "GET",
		body?: unknown,
	): Promise<Record<string, unknown> | undefined> {
		if (this.isUnloading) {
			return undefined;
		}

		if (skipIfBusy && method !== "GET") {
			throw new Error("The skip option is only supported for GET requests.");
		}
		try {
			if (skipIfBusy) {
				return await tryAcquire(this.apiMutex).runExclusive(() => this.performApiRequest(path, method, body));
			}

			return await this.apiMutex.runExclusive(() => this.performApiRequest(path, method, body));
		} catch (error) {
			if (error === E_ALREADY_LOCKED) {
				this.log.debug(`Skipping API request ${method} ${path} because another request is already running.`);
				return undefined;
			}

			if (error === E_CANCELED && this.isUnloading) {
				this.log.debug(`Canceled API request ${method} ${path} because of shutdown.`);
				return undefined;
			}

			this.log.error(
				`Error executing API request ${method} ${path}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);

			return undefined;
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
	private async performApiRequest(
		path: string,
		method: "GET" | "POST" = "GET",
		body?: unknown,
	): Promise<Record<string, unknown> | undefined> {
		const url = `http://${this.ipHostname}${path}`;
		const headers: http.OutgoingHttpHeaders = {};
		const jsonBody = body !== undefined ? JSON.stringify(body) : undefined;

		if (jsonBody !== undefined) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = Buffer.byteLength(jsonBody);
		}

		this.log.debug(`Request: ${method} ${url}, Header: ${JSON.stringify(headers)}, Request body: ${jsonBody}`);

		return new Promise(resolve => {
			const request = http.request(
				url,
				{
					method,
					headers,
				},
				response => {
					let data = "";

					response.setEncoding("utf8");

					response.on("data", chunk => {
						data += chunk;
					});

					response.on("end", () => {
						const statusCode = response.statusCode;

						this.log.debug(`HTTP status for ${path}: ${statusCode ?? "undefined"}`);

						// The heater responded, so the connection is available.
						void this.setState("info.connection", true, true);

						// HTTP status must indicate a successful request.
						if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
							this.log.error(`Mill API request failed for ${path}: HTTP ${statusCode ?? "unknown"}.`);

							if (data.trim()) {
								this.log.error(`Mill API response: ${data}`);
							}
							resolve(undefined);
							return;
						}

						// A successful API request must return a response body.
						if (!data.trim()) {
							this.log.error(`Empty response from ${path}.`);
							resolve(undefined);
							return;
						}

						try {
							const parsed = JSON.parse(data);

							if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
								this.log.error(`Invalid API response from ${path}: response is not an object.`);
								resolve(undefined);
								return;
							}

							const dataRecord = parsed as Record<string, unknown>;

							// The Mill API reports successful requests with status "ok".
							if (dataRecord.status !== "ok") {
								this.log.error(
									`Mill API rejected request to ${path}: status=${String(dataRecord.status)}.`,
								);
								resolve(undefined);
								return;
							}

							resolve(dataRecord);
						} catch (error) {
							this.log.error(
								`Invalid JSON response from ${path}: ${
									error instanceof Error ? error.message : String(error)
								}`,
							);
							resolve(undefined);
						}
					});
				},
			);

			request.on("error", error => {
				this.log.error(`Error calling ${path}: ${error.message}`);
				void this.setState("info.connection", false, true);
				resolve(undefined);
			});

			request.setTimeout(this.apiTimeout * 1000, () => {
				this.log.error(`Timeout calling ${path}.`);
				void this.setState("info.connection", false, true);
				request.destroy();
				resolve(undefined);
			});

			if (jsonBody !== undefined) {
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
	private async updateFastData(skipIfBusy = false): Promise<void> {
		// Retry reading the heater status until the heater type is known.
		// This is important when /status was unavailable during adapter startup.
		if (!this.heaterName) {
			await this.getStatus(skipIfBusy);
		}
		await this.getControlStatus(skipIfBusy);

		const heaterName = this.heaterName.toLowerCase();

		// The heater type is determined from the name received from /status.
		if (heaterName.includes("oil")) {
			// Only available for oil heaters.
			await this.getHeatingLevelPercentage(skipIfBusy);
		} else if (heaterName.includes("panel")) {
			// Only available for panel and storage heater, only panel heaters are handled here.
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
	private async updateSlowData(skipIfBusy = false): Promise<void> {
		await this.getStatus(skipIfBusy);
		await this.getTemperatureCalibrationOffset(skipIfBusy);
	}

	/**
	 * Read current control status.
	 *
	 * @param skipIfBusy If API is busy, skip this request.
	 */
	private async getControlStatus(skipIfBusy = false): Promise<void> {
		this.log.debug("getControlStatus started.");

		const data = await this.callApi("/control-status", skipIfBusy);

		if (!data) {
			return;
		}

		// Read API values and verify their expected data types.
		// Only valid API values are written to the states.
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

		if (ambientTemperature !== undefined) {
			void this.setState("control-status.ambient_temperature", ambientTemperature, true);
		}

		if (connectedToCloud !== undefined) {
			void this.setState("control-status.connected_to_cloud", connectedToCloud, true);
		}

		if (controlSignal !== undefined) {
			void this.setState("control-status.control_signal", controlSignal, true);
		}

		if (currentPower !== undefined) {
			void this.setState("control-status.current_power", currentPower, true);
		}

		if (lockActive !== undefined) {
			void this.setState("control-status.lock_active", lockActive, true);
		}

		if (openWindowActiveNow !== undefined) {
			void this.setState("control-status.open_window_active_now", openWindowActiveNow, true);
		}

		if (operationMode !== undefined) {
			void this.setState("control-status.operation_mode", operationMode, true);
		}

		if (rawAmbientTemperature !== undefined) {
			void this.setState("control-status.raw_ambient_temperature", rawAmbientTemperature, true);
		}

		if (setTemperature !== undefined) {
			void this.setState("control-status.set_temperature", setTemperature, true);
		}

		if (switchedOn !== undefined) {
			void this.setState("control-status.switched_on", switchedOn, true);
		}

		this.log.debug("Control status updated.");
	}

	/**
	 * Read basic heater status.
	 *
	 * @param skipIfBusy If API is busy, skip this request.
	 */
	private async getStatus(skipIfBusy = false): Promise<void> {
		this.log.debug("getStatus started.");

		const data = await this.callApi("/status", skipIfBusy);

		if (!data) {
			return;
		}

		// Read API values and verify their expected data types.
		// Only valid API values are written to the states.
		const name = typeof data.name === "string" ? data.name : undefined;
		const customName = typeof data.custom_name === "string" ? data.custom_name : undefined;
		const version = typeof data.version === "string" ? data.version : undefined;
		const operationKey = typeof data.operation_key === "string" ? data.operation_key : undefined;
		const macAddress = typeof data.mac_address === "string" ? data.mac_address : undefined;

		// Store the name for later heater type detection.
		if (name !== undefined) {
			this.heaterName = name;
			void this.setState("status.name", name, true);
		}

		if (customName !== undefined) {
			void this.setState("status.custom_name", customName, true);
		}

		if (version !== undefined) {
			void this.setState("status.version", version, true);
		}

		if (operationKey !== undefined) {
			void this.setState("status.operation_key", operationKey, true);
		}

		if (macAddress !== undefined) {
			void this.setState("status.mac_address", macAddress, true);
		}

		this.log.debug("Status updated.");
	}

	/**
	 * Read temperature calibration offset.
	 *
	 * @param skipIfBusy If API is busy, skip this request.
	 */
	private async getTemperatureCalibrationOffset(skipIfBusy = false): Promise<void> {
		this.log.debug("getTemperatureCalibrationOffset started.");

		const data = await this.callApi("/temperature-calibration-offset", skipIfBusy);

		if (!data) {
			return;
		}
		// Read the API value and verify that it is a number.
		// Invalid or missing values are ignored.
		const temperatureCalibrationOffset = typeof data.value === "number" ? data.value : undefined;

		if (temperatureCalibrationOffset !== undefined) {
			void this.setState("settings.temperature_calibration_offset", temperatureCalibrationOffset, true);
		}

		this.log.debug("Temperature calibration offset updated.");
	}

	/**
	 * Read oil heater power.
	 *
	 * @param skipIfBusy If API is busy, skip this request.
	 */
	private async getHeatingLevelPercentage(skipIfBusy = false): Promise<void> {
		this.log.debug("getHeatingLevelPercentage started.");

		const data = await this.callApi("/oil-heater-power", skipIfBusy);

		if (!data) {
			return;
		}

		// Read API values and verify their expected data types.
		// Only valid API values are written to the states.
		const heatingLevelPercentage = typeof data.value === "number" ? data.value : undefined;

		if (heatingLevelPercentage !== undefined) {
			void this.setState("settings.heating_level_percentage", heatingLevelPercentage, true);
		}

		this.log.debug("Oil heater power updated.");
	}

	/**
	 * Read panel heater power limitation.
	 *
	 * @param skipIfBusy If API is busy, skip this request.
	 */
	private async getLimitedHeatingPower(skipIfBusy = false): Promise<void> {
		this.log.debug("getLimitedHeatingPower started.");

		const data = await this.callApi("/limited-heating-power", skipIfBusy);

		if (!data) {
			return;
		}

		// Read API values and verify their expected data types.
		// Only valid API values are written to the states.
		const limitedHeatingPower = typeof data.value === "number" ? data.value : undefined;

		if (limitedHeatingPower !== undefined) {
			void this.setState("settings.limited_heating_power", limitedHeatingPower, true);
		}

		this.log.debug("Limited heating power updated.");
	}

	/**
	 * @param value the Operation mode of the heater.
	 */
	private async setOperationMode(value: string): Promise<void> {
		// "Invalid" is a possible API state, but must not be sent to the heater.
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

		// A successful API request is acknowledged immediately.
		void this.setState("control-status.operation_mode", value, true);
		this.log.debug(`Operation mode set to "${value}".`);

		// Update the fast data after changing the operation mode.
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
	private async setTemperature(value: number): Promise<void> {
		if (!Number.isFinite(value) || value < 5 || value > 35) {
			this.log.warn(`Invalid temperature: ${value} °C (allowed: 5-35 °C)`);
			return;
		}

		const data = await this.callApi("/set-temperature", false, "POST", { type: "Normal", value });

		if (!data) {
			this.log.error(`Failed to set temperature to ${value} °C.`);
			return;
		}

		// A successful API request is acknowledged immediately.
		void this.setState("control-status.set_temperature", value, true);
		this.log.debug(`Temperature set to ${value} °C.`);

		// Update the fast data after changing the target temperature.
		await this.updateFastData();
	}

	/**
	 * The API accepts the heating level as a percentage of the nominal power.
	 *
	 * @param value Maximum heating level of an oil heater.
	 */
	private async setHeatingLevelPercentage(value: number): Promise<void> {
		// Heating level percentage is only available for oil heaters.
		if (!this.heaterName.toLowerCase().includes("oil")) {
			this.log.warn("Heating level percentage can only be set for oil heaters.");
			return;
		}

		// Oil heaters support only 40%, 60% or 100% of nominal power.
		if (value !== 40 && value !== 60 && value !== 100) {
			this.log.warn(`Invalid heating level percentage: ${value}. Allowed values are 40, 60 or 100.`);
			return;
		}

		const data = await this.callApi("/oil-heater-power", false, "POST", { heating_level_percentage: value });

		if (!data) {
			this.log.error(`Failed to set heating level percentage to ${value}%.`);
			return;
		}

		// A successful API request is acknowledged immediately.
		void this.setState("settings.heating_level_percentage", value, true);
		this.log.debug(`Heating level percentage set to ${value}%.`);

		// Update the fast data after changing the heating level.
		await this.updateFastData();
	}

	/**
	 * The API accepts the heating level as a percentage of maximum power.
	 *
	 * @param value Maximum heating power that the heater may use.
	 */
	private async setLimitedHeatingPower(value: number): Promise<void> {
		// Limited heating power is only available for panel heaters.
		if (!this.heaterName.toLowerCase().includes("panel")) {
			this.log.warn("Limited heating power can only be set for panel heaters.");
			return;
		}

		// Panel heaters support integer values from 10 to 100.
		if (!Number.isInteger(value) || value < 10 || value > 100) {
			this.log.warn(`Invalid limited heating power: ${value}. Allowed values are 10 to 100.`);
			return;
		}

		const data = await this.callApi("/limited-heating-power", false, "POST", { limited_heating_power: value });

		if (!data) {
			this.log.error(`Failed to set limited heating power to ${value}%.`);
			return;
		}

		// A successful API request is acknowledged immediately.
		void this.setState("settings.limited_heating_power", value, true);
		this.log.debug(`Limited heating power set to ${value}%.`);

		// Update the fast data after changing the heating power limit.
		await this.updateFastData();
	}

	/**
	 * @param value Temperature calibration offset.
	 */
	private async setTemperatureCalibrationOffset(value: number): Promise<void> {
		if (!Number.isFinite(value) || value < -30 || value > 30) {
			this.log.warn(`Invalid temperature calibration offset: ${value} °C (allowed: -30 - +30 °C)`);
			return;
		}

		const data = await this.callApi("/temperature-calibration-offset", false, "POST", { value });

		if (!data) {
			this.log.error(`Failed to set temperature calibration offset to ${value} °C.`);
			return;
		}

		// A successful API request is acknowledged immediately.
		void this.setState("settings.temperature_calibration_offset", value, true);
		this.log.debug(`Temperature calibration offset set to ${value} °C.`);

		// A changed calibration offset can affect the heater control.
		await this.updateFastData();
		// Refresh the calibration offset from the API.
		await this.updateSlowData();
	}

	/**
	 * Create the complete object tree.
	 *
	 * setObjectNotExistsAsync() is deliberately used so existing
	 * objects are not overwritten.
	 */
	private async createObjects(): Promise<void> {
		/*
		 * ============================================================
		 * STATUS
		 * ============================================================
		 */

		await this.setObjectNotExistsAsync("status", {
			type: "channel",
			common: {
				name: "Status",
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("status.name", {
			type: "state",
			common: {
				name: {
					en: "Device name/Model",
					de: "Gerätename/Modell",
					ru: "Название/модель устройства",
					pt: "Nome/Modelo do dispositivo",
					nl: "Apparaatnaam/Model",
					fr: "Nom/Modèle de l'appareil",
					it: "Nome/Modello del dispositivo",
					es: "Nombre/modelo del dispositivo",
					pl: "Nazwa/model urządzenia",
					uk: "Назва/модель пристрою",
					"zh-cn": "设备名称/型号",
				},
				type: "string",
				role: "info.model",
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("status.custom_name", {
			type: "state",
			common: {
				name: {
					en: "Custom name",
					de: "Name des Geräts",
					ru: "Пользовательское название",
					pt: "Nome personalizado",
					nl: "Aangepaste naam",
					fr: "Nom personnalisé",
					it: "Nome personalizzato",
					es: "Nombre personalizado",
					pl: "Nazwa własna",
					uk: "Власна назва",
					"zh-cn": "自定义名称",
				},
				type: "string",
				role: "info.name",
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("status.version", {
			type: "state",
			common: {
				name: {
					en: "API/Firmware version number",
					de: "API-/Firmwareversionsnummer",
					ru: "Номер версии API/прошивки",
					pt: "Número da versão da API/firmware",
					nl: "API-/firmwareversienummer",
					fr: "Numéro de version de l’API/du firmware",
					it: "Numero di versione API/firmware",
					es: "Número de versión de la API/firmware",
					pl: "Numer wersji API/oprogramowania układowego",
					uk: "Номер версії API/прошивки",
					"zh-cn": "API/固件版本号",
				},
				type: "string",
				role: "info.firmware",
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("status.operation_key", {
			type: "state",
			common: {
				name: {
					en: "If an operational problem occurs (e.g. a faulty temperature sensor), it may be reported in this field.",
					de: "Wenn ein Betriebsproblem auftritt (z. B. ein defekter Temperatursensor), kann es in diesem Feld gemeldet werden.",
					ru: "При возникновении проблемы в работе (например, неисправности датчика температуры) она может отображаться в этом поле.",
					pt: "Se ocorrer um problema de funcionamento (por exemplo, um sensor de temperatura avariado), ele poderá ser indicado neste campo.",
					nl: "Als er een probleem met de werking optreedt (bijvoorbeeld een defecte temperatuursensor), kan dit in dit veld worden gemeld.",
					fr: "En cas de problème de fonctionnement (par exemple, un capteur de température défectueux), celui-ci peut être signalé dans ce champ.",
					it: "Se si verifica un problema di funzionamento (ad esempio, un sensore di temperatura guasto), può essere segnalato in questo campo.",
					es: "Si se produce un problema de funcionamiento (por ejemplo, un sensor de temperatura averiado), puede indicarse en este campo.",
					pl: "Jeśli wystąpi problem z działaniem (np. uszkodzony czujnik temperatury), może on zostać zgłoszony w tym polu.",
					uk: "Якщо виникає проблема в роботі (наприклад, несправний датчик температури), її можна вказати в цьому полі.",
					"zh-cn": "如果出现运行问题（例如温度传感器损坏），可以在此字段中报告。",
				},
				type: "string",
				role: "state",
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("status.mac_address", {
			type: "state",
			common: {
				name: {
					en: "Device MAC (Media Access Control) address",
					de: "MAC-Adresse (Media Access Control) des Geräts",
					ru: "MAC-адрес устройства (Media Access Control)",
					pt: "Endereço MAC (Media Access Control) do dispositivo",
					nl: "MAC-adres (Media Access Control) van het apparaat",
					fr: "Adresse MAC (Media Access Control) de l’appareil",
					it: "Indirizzo MAC (Media Access Control) del dispositivo",
					es: "Dirección MAC (Media Access Control) del dispositivo",
					pl: "Adres MAC (Media Access Control) urządzenia",
					uk: "MAC-адреса пристрою (Media Access Control)",
					"zh-cn": "设备的 MAC 地址（媒体访问控制）",
				},
				type: "string",
				role: "info.mac",
				read: true,
				write: false,
			},
			native: {},
		});

		/*
		 * ============================================================
		 * CONTROL STATUS
		 * ============================================================
		 */

		await this.setObjectNotExistsAsync("control-status", {
			type: "channel",
			common: {
				name: "Control status",
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("control-status.ambient_temperature", {
			type: "state",
			common: {
				name: {
					en: "Temperature measured by the sensor in degrees Celsius, including the calibration offset",
					de: "Vom Sensor gemessene Temperatur in Grad Celsius einschließlich Kalibrierkorrektur",
					ru: "Температура, измеренная датчиком в градусах Цельсия, с учетом калибровочной поправки",
					pt: "Temperatura medida pelo sensor em graus Celsius, incluindo a correção de calibração",
					nl: "Door de sensor gemeten temperatuur in graden Celsius, inclusief kalibratiecorrectie",
					fr: "Température mesurée par le capteur en degrés Celsius, correction d’étalonnage incluse",
					it: "Temperatura misurata dal sensore in gradi Celsius, inclusa la correzione di calibrazione",
					es: "Temperatura medida por el sensor en grados Celsius, incluida la corrección de calibración",
					pl: "Temperatura zmierzona przez czujnik w stopniach Celsjusza, z uwzględnieniem korekty kalibracji",
					uk: "Температура, виміряна датчиком у градусах Цельсія, з урахуванням калібрувальної поправки",
					"zh-cn": "传感器测得的摄氏温度，包含校准偏移量",
				},
				type: "number",
				role: "value.temperature",
				read: true,
				write: false,
				unit: "°C",
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("control-status.connected_to_cloud", {
			type: "state",
			common: {
				name: {
					en: "Indicates whether the device is connected to the cloud",
					de: "Gibt an, ob das Gerät mit der Cloud verbunden ist",
					ru: "Указывает, подключено ли устройство к облаку",
					pt: "Indica se o dispositivo está conectado à nuvem",
					nl: "Geeft aan of het apparaat met de cloud is verbonden",
					fr: "Indique si l’appareil est connecté au cloud",
					it: "Indica se il dispositivo è connesso al cloud",
					es: "Indica si el dispositivo está conectado a la nube",
					pl: "Informuje, czy urządzenie jest połączone z chmurą",
					uk: "Вказує, чи підключено пристрій до хмари",
					"zh-cn": "指示设备是否已连接到云端",
				},
				type: "boolean",
				role: "sensor",
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("control-status.control_signal", {
			type: "state",
			common: {
				name: {
					en: "Control signal of the PID controller (0–100%)",
					de: "Stellsignal des PID-Reglers (0–100 %)",
					ru: "Управляющий сигнал ПИД-регулятора (0–100 %)",
					pt: "Sinal de controlo do regulador PID (0–100%)",
					nl: "Stuursignaal van de PID-regelaar (0–100%)",
					fr: "Signal de commande du régulateur PID (0–100 %)",
					it: "Segnale di controllo del regolatore PID (0–100%)",
					es: "Señal de control del regulador PID (0–100 %)",
					pl: "Sygnał sterujący regulatora PID (0–100%)",
					uk: "Керуючий сигнал ПІД-регулятора (0–100 %)",
					"zh-cn": "PID 控制器的控制信号（0–100%）",
				},
				type: "number",
				role: "value",
				read: true,
				write: false,
				unit: "%",
				min: 0,
				max: 100,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("control-status.current_power", {
			type: "state",
			common: {
				name: {
					en: "Current heating power in watts",
					de: "Aktuelle Heizleistung in Watt",
					ru: "Текущая мощность нагрева в ваттах",
					pt: "Potência de aquecimento atual em watts",
					nl: "Huidig verwarmingsvermogen in watt",
					fr: "Puissance de chauffage actuelle en watts",
					it: "Potenza di riscaldamento attuale in watt",
					es: "Potencia de calefacción actual en vatios",
					pl: "Aktualna moc grzewcza w watach",
					uk: "Поточна потужність нагрівання у ватах",
					"zh-cn": "当前加热功率（瓦）",
				},
				type: "number",
				role: "value.power",
				read: true,
				write: false,
				unit: "W",
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("control-status.lock_active", {
			type: "state",
			common: {
				name: {
					en: "Lock status (No lock, Child lock, Commercial lock)",
					de: "Sperrstatus (No lock, Child lock, Commercial lock)",
					ru: "Состояние блокировки (No lock, Child lock, Commercial lock)",
					pt: "Estado do bloqueio (No lock, Child lock, Commercial lock)",
					nl: "Vergrendelingsstatus (No lock, Child lock, Commercial lock)",
					fr: "État du verrouillage (No lock, Child lock, Commercial lock)",
					it: "Stato del blocco (No lock, Child lock, Commercial lock)",
					es: "Estado del bloqueo (No lock, Child lock, Commercial lock)",
					pl: "Stan blokady (No lock, Child lock, Commercial lock)",
					uk: "Стан блокування (No lock, Child lock, Commercial lock)",
					"zh-cn": "锁定状态（No lock, Child lock, Commercial lock）",
				},
				type: "string",
				role: "state",
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("control-status.open_window_active_now", {
			type: "state",
			common: {
				name: {
					en: "Open-window status (Disabled not active now, Enabled active now, Enabled not active now)",
					de: "Status der Fenstererkennung (Disabled not active now, Enabled active now, Enabled not active now)",
					ru: "Состояние обнаружения открытого окна (Disabled not active now, Enabled active now, Enabled not active now)",
					pt: "Estado da deteção de janela aberta (Disabled not active now, Enabled active now, Enabled not active now)",
					nl: "Status van openraamdetectie (Disabled not active now, Enabled active now, Enabled not active now)",
					fr: "État de la détection de fenêtre ouverte (Disabled not active now, Enabled active now, Enabled not active now)",
					it: "Stato del rilevamento della finestra aperta (Disabled not active now, Enabled active now, Enabled not active now)",
					es: "Estado de la detección de ventana abierta (Disabled not active now, Enabled active now, Enabled not active now)",
					pl: "Stan wykrywania otwartego okna (Disabled not active now, Enabled active now, Enabled not active now)",
					uk: "Стан виявлення відкритого вікна (Disabled not active now, Enabled active now, Enabled not active now)",
					"zh-cn": "开窗检测状态（Disabled not active now, Enabled active now, Enabled not active now）",
				},
				type: "string",
				role: "state",
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("control-status.operation_mode", {
			type: "state",
			common: {
				name: {
					en: "Current mode of operation",
					de: "Aktueller Betriebsmodus",
					ru: "Текущий режим работы",
					pt: "Modo de funcionamento atual",
					nl: "Huidige bedrijfsmodus",
					fr: "Mode de fonctionnement actuel",
					it: "Modalità operativa corrente",
					es: "Modo de funcionamiento actual",
					pl: "Aktualny tryb pracy",
					uk: "Поточний режим роботи",
					"zh-cn": "当前运行模式",
				},
				type: "string",
				role: "state",
				read: true,
				write: true,
				states: {
					Off: "Off",
					"Weekly program": "Weekly program",
					"Independent device": "Independent device",
					"Control individually": "Control individually",
				},
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("control-status.raw_ambient_temperature", {
			type: "state",
			common: {
				name: {
					en: "Temperature measured by the sensor in degrees Celsius, without the calibration offset",
					de: "Vom Sensor gemessene Temperatur in Grad Celsius ohne Kalibrierkorrektur",
					ru: "Температура, измеренная датчиком в градусах Цельсия, без калибровочной поправки",
					pt: "Temperatura medida pelo sensor em graus Celsius, sem a correção de calibração",
					nl: "Door de sensor gemeten temperatuur in graden Celsius, zonder kalibratiecorrectie",
					fr: "Température mesurée par le capteur en degrés Celsius, sans correction d’étalonnage",
					it: "Temperatura misurata dal sensore in gradi Celsius, senza correzione di calibrazione",
					es: "Temperatura medida por el sensor en grados Celsius, sin la corrección de calibración",
					pl: "Temperatura zmierzona przez czujnik w stopniach Celsjusza, bez korekty kalibracji",
					uk: "Температура, виміряна датчиком у градусах Цельсія, без калібрувальної поправки",
					"zh-cn": "传感器测得的摄氏温度，不包含校准偏移量",
				},
				type: "number",
				role: "value.temperature",
				read: true,
				write: false,
				unit: "°C",
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("control-status.set_temperature", {
			type: "state",
			common: {
				name: {
					en: "Current set temperature in degrees Celsius",
					de: "Aktuelle Solltemperatur in Grad Celsius",
					ru: "Текущая заданная температура в градусах Цельсия",
					pt: "Temperatura definida atual em graus Celsius",
					nl: "Huidige ingestelde temperatuur in graden Celsius",
					fr: "Température de consigne actuelle en degrés Celsius",
					it: "Temperatura impostata attuale in gradi Celsius",
					es: "Temperatura de consigna actual en grados Celsius",
					pl: "Aktualna temperatura zadana w stopniach Celsjusza",
					uk: "Поточна задана температура в градусах Цельсія",
					"zh-cn": "当前设定温度（摄氏度）",
				},
				type: "number",
				role: "level.temperature",
				read: true,
				write: true,
				min: 5,
				max: 35,
				unit: "°C",
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("control-status.switched_on", {
			type: "state",
			common: {
				name: {
					en: "Indicates whether the device is switched on and set to operate with heating",
					de: "Gibt an, ob das Gerät eingeschaltet und zum Heizen aktiviert ist",
					ru: "Указывает, включено ли устройство и настроено ли оно на работу с обогревом",
					pt: "Indica se o dispositivo está ligado e configurado para funcionar com aquecimento",
					nl: "Geeft aan of het apparaat is ingeschakeld en is ingesteld om te verwarmen",
					fr: "Indique si l’appareil est allumé et réglé pour fonctionner en mode chauffage",
					it: "Indica se il dispositivo è acceso e impostato per funzionare con il riscaldamento",
					es: "Indica si el dispositivo está encendido y configurado para funcionar con calefacción",
					pl: "Informuje, czy urządzenie jest włączone i ustawione do pracy z ogrzewaniem",
					uk: "Вказує, чи увімкнено пристрій і налаштовано його на роботу з обігрівом",
					"zh-cn": "指示设备是否已开启并设置为加热运行",
				},
				type: "boolean",
				role: "sensor.switch",
				read: true,
				write: false,
			},
			native: {},
		});

		/*
		 * ============================================================
		 * SETTINGS
		 * ============================================================
		 */

		await this.setObjectNotExistsAsync("settings", {
			type: "channel",
			common: {
				name: "Settings",
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("settings.heating_level_percentage", {
			type: "state",
			common: {
				name: {
					en: "Heating level in percent",
					de: "Heizstufe in Prozent",
					ru: "Уровень нагрева в процентах",
					pt: "Nível de aquecimento em percentagem",
					nl: "Verwarmingsniveau in procenten",
					fr: "Niveau de chauffage en pourcentage",
					it: "Livello di riscaldamento in percentuale",
					es: "Nivel de calefacción en porcentaje",
					pl: "Poziom ogrzewania w procentach",
					uk: "Рівень нагрівання у відсотках",
					"zh-cn": "加热等级（百分比）",
				},
				type: "number",
				role: "level",
				read: true,
				write: true,
				states: {
					40: "40",
					60: "60",
					100: "100",
				},
				unit: "%",
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("settings.limited_heating_power", {
			type: "state",
			common: {
				name: {
					en: "Percentage of maximum power the heater can use (10–100)",
					de: "Prozentsatz der maximalen Leistung, die der Heizkörper nutzen darf (10–100)",
					ru: "Процент максимальной мощности, которую может использовать обогреватель (10–100)",
					pt: "Percentagem da potência máxima que o aquecedor pode utilizar (10–100)",
					nl: "Percentage van het maximale vermogen dat de verwarming mag gebruiken (10–100)",
					fr: "Pourcentage de la puissance maximale que le radiateur peut utiliser (10–100)",
					it: "Percentuale della potenza massima che il riscaldatore può utilizzare (10–100)",
					es: "Porcentaje de la potencia máxima que puede utilizar el calefactor (10–100)",
					pl: "Procent maksymalnej mocy, którą może wykorzystywać grzejnik (10–100)",
					uk: "Відсоток максимальної потужності, яку може використовувати обігрівач (10–100)",
					"zh-cn": "加热器可使用的最大功率百分比（10–100）",
				},
				type: "number",
				role: "level",
				read: true,
				write: true,
				unit: "%",
				min: 10,
				max: 100,
			},
			native: {},
		});

		await this.setObjectNotExistsAsync("settings.temperature_calibration_offset", {
			type: "state",
			common: {
				name: {
					en: "Temperature calibration offset in degrees Celsius",
					de: "Temperatur-Kalibrierkorrektur in Grad Celsius",
					ru: "Поправка калибровки температуры в градусах Цельсия",
					pt: "Correção de calibração da temperatura em graus Celsius",
					nl: "Temperatuurkalibratiecorrectie in graden Celsius",
					fr: "Correction d’étalonnage de la température en degrés Celsius",
					it: "Correzione di calibrazione della temperatura in gradi Celsius",
					es: "Corrección de calibración de la temperatura en grados Celsius",
					pl: "Korekta kalibracji temperatury w stopniach Celsjusza",
					uk: "Поправка калібрування температури в градусах Цельсія",
					"zh-cn": "温度校准偏移量（摄氏度）",
				},
				type: "number",
				role: "level",
				read: true,
				write: true,
				min: -30,
				max: 30,
				unit: "°C",
			},
			native: {},
		});
	}

	/**
	 * Handle state changes.
	 *
	 * @param id id state ID
	 * @param state state New state.
	 */
	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
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
	private onUnload(callback: () => void): void {
		this.isUnloading = true;
		try {
			this.log.info("Mill Heater Adapter is shutting down.");

			if (this.pollTimer1 !== undefined) {
				this.clearInterval(this.pollTimer1);
				this.pollTimer1 = undefined;
			}

			if (this.pollTimer2 !== undefined) {
				this.clearInterval(this.pollTimer2);
				this.pollTimer2 = undefined;
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
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Millheater(options);
} else {
	(() => new Millheater())();
}
