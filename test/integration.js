const path = require("path");
const http = require("http");
const assert = require("assert");

const { tests } = require("@iobroker/testing");

const INSTANCE = "millheater.0";
const MAC_A = "00:11:22:33:44:55";
const MAC_B = "00:11:22:33:44:66";
const MAC_OLD = "AA:BB:CC:DD:EE:FF";

function deviceId(macAddress) {
    return macAddress.replace(/[:-]/g, "").toLowerCase();
}

function deviceRoot(macAddress) {
    return `${INSTANCE}.${deviceId(macAddress)}`;
}

function deviceState(macAddress, stateId) {
    return `${deviceRoot(macAddress)}.${stateId}`;
}

/**
 * Waits until one ioBroker state fulfills a condition.
 *
 * @param {object} harness ioBroker test harness
 * @param {string} id State ID
 * @param {(state: object) => boolean} predicate State predicate
 * @param {number} timeout Maximum wait time in milliseconds
 * @returns {Promise<object>} Matching state
 */
async function waitForState(harness, id, predicate, timeout = 7000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        const state = await harness.states.getStateAsync(id);
        if (state !== null && state !== undefined && predicate(state)) {
            return state;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    throw new Error(`Timeout waiting for state: ${id}`);
}

/**
 * Waits until all specified states exist.
 *
 * @param {object} harness ioBroker test harness
 * @param {string[]} ids State IDs
 * @param {number} timeout Maximum wait time in milliseconds
 * @returns {Promise<void>}
 */
async function waitForStates(harness, ids, timeout = 7000) {
    await Promise.all(ids.map(id => waitForState(harness, id, state => state !== null, timeout)));
}

/**
 * Starts an HTTP server on an available local port.
 *
 * @param {http.Server} server HTTP server
 * @returns {Promise<number>} Listening port
 */
function startTestServer(server) {
    return new Promise((resolve, reject) => {
        const onError = error => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.off("error", onError);
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("Could not determine the test server port."));
                return;
            }
            resolve(address.port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
    });
}

/**
 * Closes an HTTP server.
 *
 * @param {http.Server | undefined} server HTTP server
 * @returns {Promise<void>}
 */
async function closeTestServer(server) {
    if (!server || !server.listening) {
        return;
    }
    await new Promise(resolve => server.close(resolve));
}

/**
 * Creates a tracked HTTP mock server.
 *
 * @param {(request: object) => object} handler Request handler
 * @returns {object} Server and request inspection helpers
 */
function createTrackedServer(handler) {
    const requests = [];
    const waiters = [];

    const server = http.createServer((request, response) => {
        let rawBody = "";
        request.on("data", chunk => {
            rawBody += chunk;
        });
        request.on("end", () => {
            let body;
            if (rawBody.trim()) {
                try {
                    body = JSON.parse(rawBody);
                } catch {
                    body = rawBody;
                }
            }

            const record = {
                method: request.method || "",
                path: request.url || "",
                body,
                rawBody,
            };
            const requestIndex = requests.push(record) - 1;

            for (let index = waiters.length - 1; index >= 0; index--) {
                const waiter = waiters[index];
                if (
                    requestIndex >= waiter.afterRequestCount &&
                    record.method === waiter.method &&
                    record.path === waiter.path
                ) {
                    clearTimeout(waiter.timeout);
                    waiters.splice(index, 1);
                    waiter.resolve(record);
                    break;
                }
            }

            const result = handler(record) || {};
            const sendResponse = () => {
                if (response.destroyed) {
                    return;
                }
                response.statusCode = result.statusCode ?? 200;
                response.setHeader("Content-Type", "application/json");
                if (result.chunks !== undefined) {
                    let chunkIndex = 0;

                    const sendNextChunk = () => {
                        if (response.destroyed) {
                            return;
                        }

                        if (chunkIndex >= result.chunks.length) {
                            response.end();
                            return;
                        }

                        response.write(result.chunks[chunkIndex++]);
                        setTimeout(sendNextChunk, result.chunkIntervalMs ?? 250);
                    };

                    sendNextChunk();
                    return;
                }
                if (result.rawBody !== undefined) {
                    response.end(result.rawBody);
                } else if (result.body === undefined) {
                    response.end();
                } else {
                    response.end(JSON.stringify(result.body));
                }
            };

            if (result.delayMs !== undefined) {
                setTimeout(sendResponse, result.delayMs);
            } else {
                sendResponse();
            }
        });
    });

    return {
        server,
        requests,
        waitForRequest(method, requestPath, afterRequestCount = requests.length, timeout = 7000) {
            const existing = requests.slice(afterRequestCount).find(
                request => request.method === method && request.path === requestPath,
            );
            if (existing) {
                return Promise.resolve(existing);
            }

            return new Promise((resolve, reject) => {
                const waiter = {
                    method,
                    path: requestPath,
                    afterRequestCount,
                    resolve,
                    timeout: setTimeout(() => {
                        const index = waiters.indexOf(waiter);
                        if (index !== -1) {
                            waiters.splice(index, 1);
                        }
                        reject(new Error(`Timeout waiting for ${method} ${requestPath}.`));
                    }, timeout),
                };
                waiters.push(waiter);
            });
        },
        countRequests(method, requestPath) {
            return requests.filter(
                request => request.method === method && request.path === requestPath,
            ).length;
        },
        async assertNoRequestAfter(action, method, requestPath, timeout = 250) {
            const requestCount = requests.length;
            await action();
            await new Promise(resolve => setTimeout(resolve, timeout));
            const unexpected = requests.slice(requestCount).find(
                request => request.method === method && request.path === requestPath,
            );
            assert.strictEqual(unexpected, undefined, `Unexpected request ${method} ${requestPath}.`);
        },
    };
}

/**
 * Configures one adapter instance with one or more devices.
 *
 * @param {object} harness ioBroker test harness
 * @param {Array<object>} devices Device configurations
 * @param {object} options Timing configuration
 * @returns {Promise<void>}
 */
async function configureHarness(harness, devices, options = {}) {
    await harness.changeAdapterConfig("millheater", {
        native: {
            devices,
            apiTimeout: options.apiTimeout ?? 1,
            pollInterval1: options.pollInterval1 ?? 30,
            pollInterval2: options.pollInterval2 ?? 120,
        },
    });
}

/**
 * Creates one configured device entry.
 *
 * @param {string} name Configured display name
 * @param {number} port Test server port
 * @param {boolean} pollWhenOff Polling option
 * @returns {object} Device configuration
 */
function deviceConfig(name, port, pollWhenOff = true) {
    return {
        userDefinedName: name,
        host: `127.0.0.1:${port}`,
        pollWhenOff,
    };
}

function createStatusResponse(options = {}) {
    const body = {
        status: "ok",
        name: options.modelName ?? "generic",
        custom_name: options.customName ?? "Test Heater",
        version: options.version ?? "1.2.3",
        mac_address: options.macAddress ?? MAC_A,
    };
    if (options.omitOperationKey !== true) {
        body.operation_key = options.operationKey ?? "test-operation";
    }
    return { body };
}

function createControlStatusResponse(overrides = {}) {
    return {
        body: {
            status: "ok",
            ambient_temperature: 21.5,
            connected_to_cloud: true,
            control_signal: 50,
            current_power: 750,
            lock_active: "No lock",
            open_window_active_now: "Disabled not active now",
            operation_mode: "Control individually",
            raw_ambient_temperature: 21.3,
            set_temperature: 22,
            switched_on: true,
            ...overrides,
        },
    };
}

function createCalibrationResponse(value) {
    return { body: { status: "ok", value } };
}

/**
 * Creates a stateful Mill API mock for a specific heater model.
 *
 * @param {object} options Device and initial API values
 * @returns {object} Tracked HTTP server
 */
function createDeviceMock(options = {}) {
    let setTemperature = options.setTemperature ?? 22;
    let operationMode = options.operationMode ?? "Control individually";
    let calibrationOffset = options.calibrationOffset ?? 2;
    let heatingLevelPercentage = options.heatingLevelPercentage ?? 40;
    let limitedHeatingPower = options.limitedHeatingPower ?? 100;
    let additionalMode = options.additionalMode ?? 3;

    return createTrackedServer(request => {
        switch (request.path) {
            case "/status":
                return createStatusResponse(options);
            case "/control-status":
                return createControlStatusResponse({
                    set_temperature: setTemperature,
                    operation_mode: operationMode,
                    ...(options.controlStatusOverrides || {}),
                });
            case "/temperature-calibration-offset":
                if (request.method === "POST" && typeof request.body?.value === "number") {
                    calibrationOffset = request.body.value;
                    return { body: { status: "ok" } };
                }
                return createCalibrationResponse(calibrationOffset);
            case "/set-temperature":
                if (request.method === "POST" && typeof request.body?.value === "number") {
                    setTemperature = request.body.value;
                }
                return { body: { status: "ok" } };
            case "/operation-mode":
                if (request.method === "POST" && typeof request.body?.mode === "string") {
                    operationMode = request.body.mode;
                }
                return { body: { status: "ok" } };
            case "/oil-heater-power":
                if (request.method === "POST" && typeof request.body?.heating_level_percentage === "number") {
                    heatingLevelPercentage = request.body.heating_level_percentage;
                    return { body: { status: "ok" } };
                }
                return { body: { status: "ok", value: heatingLevelPercentage } };
            case "/limited-heating-power":
                if (request.method === "POST" && typeof request.body?.limited_heating_power === "number") {
                    limitedHeatingPower = request.body.limited_heating_power;
                    return { body: { status: "ok" } };
                }
                return { body: { status: "ok", limited_heating_power: limitedHeatingPower } };
            case "/additional-socket-mode":
                if (request.method === "POST" && typeof request.body?.additional_mode === "number") {
                    additionalMode = request.body.additional_mode;
                    return { body: { status: "ok" } };
                }
                return { body: { status: "ok", additional_mode: additionalMode } };
            default:
                return { statusCode: 404, body: { status: "error" } };
        }
    });
}

function logSuiteStart(name) {
    console.log(`\n========== SUITE: ${name} ==========`);
}

function logTestStart(name) {
    console.log(`---------- TEST: ${name} ----------`);
}

/**
 * Seeds a persistent MAC-based device tree before adapter startup.
 * This is used to verify that old trees and their values are retained.
 *
 * @param {object} harness ioBroker test harness
 * @param {string} macAddress Device MAC
 * @param {object} options Existing object and state values
 * @returns {Promise<void>}
 */
async function seedDeviceTree(harness, macAddress, options = {}) {
    const root = deviceRoot(macAddress);
    await harness.objects.setObjectAsync(root, {
        type: "device",
        common: { name: options.name ?? "Previously configured heater" },
        native: { host: options.host ?? "127.0.0.1:10000" },
    });
    await harness.objects.setObjectAsync(`${root}.info`, {
        type: "channel",
        common: { name: "Information" },
        native: {},
    });
    await harness.objects.setObjectAsync(`${root}.info.connection`, {
        type: "state",
        common: {
            name: "Connection",
            type: "boolean",
            role: "indicator.reachable",
            read: true,
            write: false,
        },
        native: {},
    });
    await harness.states.setStateAsync(`${root}.info.connection`, {
        val: options.connected ?? true,
        ack: true,
    });

    await harness.objects.setObjectAsync(`${root}.status`, {
        type: "channel",
        common: { name: "Status" },
        native: {},
    });
    await harness.objects.setObjectAsync(`${root}.status.operation_key`, {
        type: "state",
        common: {
            name: "Operation key",
            type: "string",
            role: "text",
            read: true,
            write: false,
        },
        native: {},
    });
    await harness.states.setStateAsync(`${root}.status.operation_key`, {
        val: options.operationKey ?? "historical-operation",
        ack: true,
    });

    const modelSpecificValues = options.seedAllModelStates
        ? {
            "heating_level_percentage": 60,
            "limited_heating_power": 80,
            "additional_mode": 3,
        }
        : options.seedOilState
            ? { "heating_level_percentage": 60 }
            : {};
    if (Object.keys(modelSpecificValues).length > 0) {
        await harness.objects.setObjectAsync(`${root}.settings`, {
            type: "channel",
            common: { name: "Settings" },
            native: {},
        });
        for (const [id, value] of Object.entries(modelSpecificValues)) {
            await harness.objects.setObjectAsync(`${root}.settings.${id}`, {
                type: "state",
                common: {
                    name: id,
                    type: "number",
                    role: "value",
                    read: true,
                    write: true,
                },
                native: {},
            });
            await harness.states.setStateAsync(`${root}.settings.${id}`, { val: value, ack: true });
        }
    }
}

// The normal ioBroker integration bootstrap intentionally starts without a
// valid device configuration. Exit code 2 is expected for this validation test.
tests.integration(path.join(__dirname, ".."), {
    allowedExitCodes: [2],
    defineAdditionalTests: ({ suite }) => {
        suite("02 - Multiple devices and independent data", getHarness => {
            let serverA;
            let serverB;
            let mockA;
            let mockB;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("02 - Multiple devices and independent data");
                const harness = getHarness();
                mockA = createDeviceMock({
                    macAddress: MAC_A,
                    modelName: "generic",
                    customName: "Living room",
                    controlStatusOverrides: { current_power: 410, ambient_temperature: 20.1 },
                });
                mockB = createDeviceMock({
                    macAddress: MAC_B,
                    modelName: "Mill Panel Heater",
                    customName: "Bedroom",
                    limitedHeatingPower: 80,
                    controlStatusOverrides: { current_power: 820, ambient_temperature: 19.4 },
                });
                serverA = mockA.server;
                serverB = mockB.server;
                const [portA, portB] = await Promise.all([
                    startTestServer(serverA),
                    startTestServer(serverB),
                ]);
                await configureHarness(harness, [
                    deviceConfig("Living room", portA),
                    deviceConfig("Bedroom", portB),
                ]);
                await harness.startAdapterAndWait();
                await waitForStates(harness, [
                    deviceState(MAC_A, "status.name"),
                    deviceState(MAC_A, "status.custom_name"),
                    deviceState(MAC_A, "status.version"),
                    deviceState(MAC_A, "status.operation_key"),
                    deviceState(MAC_A, "status.mac_address"),
                    deviceState(MAC_A, "control-status.ambient_temperature"),
                    deviceState(MAC_A, "control-status.connected_to_cloud"),
                    deviceState(MAC_A, "control-status.control_signal"),
                    deviceState(MAC_A, "control-status.current_power"),
                    deviceState(MAC_A, "control-status.lock_active"),
                    deviceState(MAC_A, "control-status.open_window_active_now"),
                    deviceState(MAC_A, "control-status.operation_mode"),
                    deviceState(MAC_A, "control-status.raw_ambient_temperature"),
                    deviceState(MAC_A, "control-status.set_temperature"),
                    deviceState(MAC_A, "control-status.switched_on"),
                    deviceState(MAC_A, "settings.temperature_calibration_offset"),
                    deviceState(MAC_B, "status.name"),
                    deviceState(MAC_B, "status.custom_name"),
                    deviceState(MAC_B, "status.version"),
                    deviceState(MAC_B, "status.operation_key"),
                    deviceState(MAC_B, "status.mac_address"),
                    deviceState(MAC_B, "control-status.ambient_temperature"),
                    deviceState(MAC_B, "control-status.current_power"),
                    deviceState(MAC_B, "settings.temperature_calibration_offset"),
                    deviceState(MAC_B, "settings.limited_heating_power"),
                ]);
                await waitForState(harness, deviceState(MAC_A, "info.connection"), state => state.val === true);
                await waitForState(harness, deviceState(MAC_B, "info.connection"), state => state.val === true);
                await waitForState(harness, `${INSTANCE}.info.connection`, state => state.val === true);
            });

            after(async () => {
                await Promise.all([closeTestServer(serverA), closeTestServer(serverB)]);
            });

            it("creates independent MAC-based trees and routes writes to the correct device", async function () {
                this.timeout(15000);
                logTestStart("creates separate MAC-based device trees");
                const harness = getHarness();

                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "control-status.current_power"))).val,
                    410,
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_B, "control-status.current_power"))).val,
                    820,
                );

                const expectedDeviceA = {
                    "status.name": "generic",
                    "status.custom_name": "Living room",
                    "status.version": "1.2.3",
                    "status.operation_key": "test-operation",
                    "status.mac_address": MAC_A,
                    "info.deviceType": "Unknown",
                    "info.connection": true,
                    "info.name": "Living room",
                    ["info.host"]: `127.0.0.1:${serverA.address().port}`,
                    "control-status.ambient_temperature": 20.1,
                    "control-status.connected_to_cloud": true,
                    "control-status.control_signal": 50,
                    "control-status.current_power": 410,
                    "control-status.lock_active": "No lock",
                    "control-status.open_window_active_now": "Disabled not active now",
                    "control-status.operation_mode": "Control individually",
                    "control-status.raw_ambient_temperature": 21.3,
                    "control-status.set_temperature": 22,
                    "control-status.switched_on": true,
                    "settings.temperature_calibration_offset": 2,
                };
                const expectedDeviceB = {
                    "status.name": "Mill Panel Heater",
                    "status.custom_name": "Bedroom",
                    "status.version": "1.2.3",
                    "status.operation_key": "test-operation",
                    "status.mac_address": MAC_B,
                    "info.deviceType": "Panel",
                    "info.connection": true,
                    "info.name": "Bedroom",
                    ["info.host"]: `127.0.0.1:${serverB.address().port}`,
                    "control-status.ambient_temperature": 19.4,
                    "control-status.current_power": 820,
                    "settings.temperature_calibration_offset": 2,
                    "settings.limited_heating_power": 80,
                };
                for (const [stateId, expectedValue] of Object.entries(expectedDeviceA)) {
                    assert.strictEqual(
                        (await harness.states.getStateAsync(deviceState(MAC_A, stateId))).val,
                        expectedValue,
                        `Unexpected value for device A state ${stateId}.`,
                    );
                }
                for (const [stateId, expectedValue] of Object.entries(expectedDeviceB)) {
                    assert.strictEqual(
                        (await harness.states.getStateAsync(deviceState(MAC_B, stateId))).val,
                        expectedValue,
                        `Unexpected value for device B state ${stateId}.`,
                    );
                }

                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "info.name"))).val,
                    "Living room",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_B, "info.name"))).val,
                    "Bedroom",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "info.host"))).val,
                    `127.0.0.1:${serverA.address().port}`,
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_B, "info.host"))).val,
                    `127.0.0.1:${serverB.address().port}`,
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(`${INSTANCE}.info.connection`)).val,
                    true,
                );

                assert.ok(await harness.objects.getObjectAsync(deviceRoot(MAC_A)));
                assert.ok(await harness.objects.getObjectAsync(deviceRoot(MAC_B)));
                assert.ok(await harness.objects.getObjectAsync(deviceState(MAC_B, "settings.limited_heating_power")));
                for (const stateId of [
                    "settings.additional_mode",
                    "settings.heating_level_percentage",
                    "settings.limited_heating_power",
                ]) {
                    assert.strictEqual(
                        await harness.objects.getObjectAsync(deviceState(MAC_A, stateId)),
                        null,
                        `Generic device A must not create ${stateId}.`,
                    );
                }
                for (const stateId of ["settings.additional_mode", "settings.heating_level_percentage"]) {
                    assert.strictEqual(
                        await harness.objects.getObjectAsync(deviceState(MAC_B, stateId)),
                        null,
                        `Panel device B must not create ${stateId}.`,
                    );
                }
                assert.ok(mockA.countRequests("GET", "/control-status") > 0);
                assert.ok(mockB.countRequests("GET", "/control-status") > 0);
                const writesBeforeA = mockA.countRequests("POST", "/set-temperature");
                const writesBeforeB = mockB.countRequests("POST", "/set-temperature");

                const writeA = mockA.waitForRequest("POST", "/set-temperature", mockA.requests.length);
                await harness.states.setStateAsync(deviceState(MAC_A, "control-status.set_temperature"), {
                    val: 23,
                    ack: false,
                });
                assert.deepStrictEqual((await writeA).body, { type: "Normal", value: 23 });
                await waitForState(
                    harness,
                    deviceState(MAC_A, "control-status.set_temperature"),
                    state => state.ack === true && state.val === 23,
                );
                assert.strictEqual(mockA.countRequests("POST", "/set-temperature"), writesBeforeA + 1);
                assert.strictEqual(mockB.countRequests("POST", "/set-temperature"), writesBeforeB);

                const writeB = mockB.waitForRequest("POST", "/set-temperature", mockB.requests.length);
                await harness.states.setStateAsync(deviceState(MAC_B, "control-status.set_temperature"), {
                    val: 24,
                    ack: false,
                });
                assert.deepStrictEqual((await writeB).body, { type: "Normal", value: 24 });
                await waitForState(
                    harness,
                    deviceState(MAC_B, "control-status.set_temperature"),
                    state => state.ack === true && state.val === 24,
                );
                assert.strictEqual(mockA.countRequests("POST", "/set-temperature"), writesBeforeA + 1);
                assert.strictEqual(mockB.countRequests("POST", "/set-temperature"), writesBeforeB + 1);

                assert.strictEqual(mockA.countRequests("GET", "/oil-heater-power"), 0);
                assert.strictEqual(mockA.countRequests("GET", "/limited-heating-power"), 0);
                assert.strictEqual(mockA.countRequests("GET", "/additional-socket-mode"), 0);
                assert.strictEqual(mockB.countRequests("GET", "/oil-heater-power"), 0);
                assert.ok(mockB.countRequests("GET", "/limited-heating-power") > 0);
                assert.strictEqual(mockB.countRequests("GET", "/additional-socket-mode"), 0);
            });
        });

        suite("03 - One unavailable device does not block the others", getHarness => {
            let healthyServer;
            let unavailablePort;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("03 - One unavailable device does not block the others");
                const harness = getHarness();
                await seedDeviceTree(harness, MAC_OLD, {
                    host: "127.0.0.1:10001",
                    connected: true,
                    operationKey: "keep-this-value",
                });
                const healthyMock = createDeviceMock({
                    macAddress: MAC_A,
                    modelName: "generic",
                    controlStatusOverrides: { current_power: 530 },
                });
                healthyServer = healthyMock.server;
                const healthyPort = await startTestServer(healthyServer);

                // Reserve the healthy port first so the closed port cannot be reused for it.
                const closedServer = http.createServer();
                unavailablePort = await startTestServer(closedServer);
                await closeTestServer(closedServer);
                await configureHarness(harness, [
                    deviceConfig("Reachable device", healthyPort),
                    deviceConfig("Unavailable device", unavailablePort),
                ], { apiTimeout: 1, pollInterval1: 5, pollInterval2: 60 });
                await harness.startAdapterAndWait();
                await waitForState(
                    harness,
                    deviceState(MAC_A, "control-status.current_power"),
                    state => state.val === 530,
                );
                await waitForState(harness, deviceState(MAC_A, "info.connection"), state => state.val === true);
                await waitForState(harness, `${INSTANCE}.info.connection`, state => state.val === true);
                await waitForState(harness, deviceState(MAC_OLD, "info.connection"), state => state.val === false);
            });

            after(async () => closeTestServer(healthyServer));

            it("keeps the reachable device online and old unconfigured trees offline", async function () {
                const harness = getHarness();
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "info.connection"))).val,
                    true,
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(`${INSTANCE}.info.connection`)).val,
                    true,
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_OLD, "info.connection"))).val,
                    false,
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_OLD, "status.operation_key"))).val,
                    "keep-this-value",
                );
                assert.ok(await harness.objects.getObjectAsync(deviceRoot(MAC_OLD)));
            });
        });

        suite("04 - API response validation", getHarness => {
            let server;
            let mock;
            let responseMode = "valid";
            let currentPower = 750;
            const timeoutResponseDelay = 1500;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("04 - API response validation");
                const harness = getHarness();
                mock = createTrackedServer(request => {
                    if (request.path === "/status") {
                        return createStatusResponse({ macAddress: MAC_A });
                    }
                    if (request.path === "/temperature-calibration-offset") {
                        return createCalibrationResponse(2);
                    }
                    if (request.path === "/control-status") {
                        switch (responseMode) {
                            case "invalid-json":
                                return { rawBody: "{invalid json" };
                            case "empty":
                                return { rawBody: "" };
                            case "api-error":
                                return { body: { status: "error" } };
                            case "http-error":
                                return { statusCode: 500, body: { status: "error" } };
                            case "timeout":
                                return {
                                    delayMs: timeoutResponseDelay,
                                    body: createControlStatusResponse({ current_power: currentPower }).body,
                                };
                            case "http-error-injection":
                                return {
                                    statusCode: 500,
                                    rawBody: "Heater failure\r\nINFO: forged log entry",
                                };

                            case "oversized":
                                return {
                                    rawBody: JSON.stringify({
                                        status: "ok",
                                        current_power: 999,
                                        padding: "x".repeat(1024 * 1024),
                                    }),
                                };

                            case "slow-stream": {
                                const rawBody = JSON.stringify(
                                    createControlStatusResponse({ current_power: 900 }).body,
                                );
                                const chunkSize = Math.ceil(rawBody.length / 8);

                                return {
                                    chunks: Array.from({ length: 8 }, (_, index) =>
                                        rawBody.slice(index * chunkSize, (index + 1) * chunkSize),
                                    ).filter(Boolean),
                                    chunkIntervalMs: 250,
                                };
                            }
                            default:
                                return createControlStatusResponse({ current_power: currentPower });
                        }
                    }
                    return { statusCode: 404, body: { status: "error" } };
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Response test", port)], {
                    apiTimeout: 1,
                    pollInterval1: 2,
                    pollInterval2: 60,
                });
                await harness.startAdapterAndWait();
                await waitForState(
                    harness,
                    deviceState(MAC_A, "control-status.current_power"),
                    state => state.val === 750,
                );
            });

            after(async () => closeTestServer(server));

            it("keeps the last valid value after malformed and unsuccessful responses", async function () {
                this.timeout(30000);
                logTestStart("keeps valid data after invalid API responses");
                const harness = getHarness();
                const stateId = deviceState(MAC_A, "control-status.current_power");

                for (const mode of ["invalid-json", "empty", "api-error", "http-error"]) {
                    responseMode = mode;
                    const requestPromise = mock.waitForRequest("GET", "/control-status", mock.requests.length);
                    await requestPromise;
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const state = await harness.states.getStateAsync(stateId);
                    assert.strictEqual(state.val, 750, `State changed after ${mode}.`);
                    assert.strictEqual(state.ack, true);
                    const alive = await harness.states.getStateAsync("system.adapter.millheater.0.alive");
                    assert.strictEqual(alive?.val, true, `Adapter did not survive ${mode}.`);
                }

                currentPower = 900;
                responseMode = "timeout";
                await mock.waitForRequest("GET", "/control-status", mock.requests.length);
                await new Promise(resolve => setTimeout(resolve, timeoutResponseDelay + 200));
                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === false,
                );
                assert.strictEqual((await harness.states.getStateAsync(stateId)).val, 750);

                currentPower = 800;
                responseMode = "valid";
                await waitForState(harness, stateId, state => state.val === 800, 8000);
                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === true,
                );

                // CWE-117: External line breaks must not create forged log entries.
                responseMode = "http-error-injection";
                await mock.waitForRequest("GET", "/control-status", mock.requests.length);
                await new Promise(resolve => setTimeout(resolve, 100));

                assert.ok(
                    harness.hasLog(
                        /Mill API response from .*: Heater failure\\r\\nINFO: forged log entry/,
                        "error",
                    ),
                    "Line breaks in external API responses must be escaped.",
                );
                assert.strictEqual(
                    harness.hasLog(/^INFO: forged log entry$/, "error"),
                    false,
                    "The forged log entry must not appear as a separate log line.",
                );

                // CWE-770: Oversized responses must be aborted.
                responseMode = "oversized";
                await mock.waitForRequest("GET", "/control-status", mock.requests.length);

                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === false,
                );

                assert.strictEqual(
                    (await harness.states.getStateAsync(stateId)).val,
                    800,
                    "An oversized response must not overwrite the last valid value.",
                );

                // Recover the connection before testing the absolute timeout.
                currentPower = 810;
                responseMode = "valid";

                await waitForState(harness, stateId, state => state.val === 810, 8000);
                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === true,
                );

                // CWE-770: Continuous data must not prevent the absolute timeout.
                responseMode = "slow-stream";

                await mock.waitForRequest("GET", "/control-status", mock.requests.length);

                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === false,
                    5000,
                );

                assert.strictEqual(
                    (await harness.states.getStateAsync(stateId)).val,
                    810,
                    "A continuously streaming response must be aborted by the absolute timeout.",
                );

                assert.ok(
                    harness.hasLog(/Total timeout calling \/control-status/, "warn"),
                    "The absolute request timeout must be logged.",
                );

                // Verify that API communication recovers after the timeout.
                currentPower = 850;
                responseMode = "valid";

                await waitForState(harness, stateId, state => state.val === 850, 8000);
                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === true,
                );
            });
        });

        suite("05 - Type-independent write operations", getHarness => {
            let server;
            let mock;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("05 - Type-independent write operations");
                const harness = getHarness();
                mock = createDeviceMock({ macAddress: MAC_A, modelName: "generic" });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Write test", port)]);
                await harness.startAdapterAndWait();
                await waitForStates(harness, [
                    deviceState(MAC_A, "control-status.set_temperature"),
                    deviceState(MAC_A, "control-status.operation_mode"),
                    deviceState(MAC_A, "settings.temperature_calibration_offset"),
                ]);
            });

            after(async () => closeTestServer(server));

            it("writes temperature, operation mode and calibration offset with validation", async function () {
                this.timeout(20000);
                const harness = getHarness();
                const testsToRun = [
                    {
                        id: "control-status.set_temperature",
                        endpoint: "/set-temperature",
                        value: 35,
                        body: { type: "Normal", value: 35 },
                    },
                    {
                        id: "control-status.operation_mode",
                        endpoint: "/operation-mode",
                        value: "Weekly program",
                        body: { mode: "Weekly program" },
                    },
                    {
                        id: "control-status.operation_mode",
                        endpoint: "/operation-mode",
                        value: "Off",
                        body: { mode: "Off" },
                    },
                    {
                        id: "settings.temperature_calibration_offset",
                        endpoint: "/temperature-calibration-offset",
                        value: -30,
                        body: { value: -30 },
                    },
                ];

                for (const test of testsToRun) {
                    const requestPromise = mock.waitForRequest("POST", test.endpoint, mock.requests.length);
                    await harness.states.setStateAsync(deviceState(MAC_A, test.id), {
                        val: test.value,
                        ack: false,
                    });
                    const request = await requestPromise;
                    assert.deepStrictEqual(request.body, test.body);
                    await waitForState(
                        harness,
                        deviceState(MAC_A, test.id),
                        state => state.ack === true && state.val === test.value,
                    );
                }

                for (const invalidTemperature of [4, 36]) {
                    await mock.assertNoRequestAfter(async () => {
                        await harness.states.setStateAsync(deviceState(MAC_A, "control-status.set_temperature"), {
                            val: invalidTemperature,
                            ack: false,
                        });
                    }, "POST", "/set-temperature");
                }
                await mock.assertNoRequestAfter(async () => {
                    await harness.states.setStateAsync(deviceState(MAC_A, "control-status.operation_mode"), {
                        val: "not-a-valid-mode",
                        ack: false,
                    });
                }, "POST", "/operation-mode");
                for (const invalidOffset of [-31, 31]) {
                    await mock.assertNoRequestAfter(async () => {
                        await harness.states.setStateAsync(deviceState(MAC_A, "settings.temperature_calibration_offset"), {
                            val: invalidOffset,
                            ack: false,
                        });
                    }, "POST", "/temperature-calibration-offset");
                }
            });
        });

        suite("06 - Oil heater", getHarness => {
            let server;
            let mock;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("06 - Oil heater");
                const harness = getHarness();
                mock = createDeviceMock({
                    macAddress: MAC_A,
                    modelName: "Mill Oil Heater",
                    heatingLevelPercentage: 40,
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Oil heater", port)]);
                await harness.startAdapterAndWait();
                await waitForState(
                    harness,
                    deviceState(MAC_A, "settings.heating_level_percentage"),
                    state => state.val === 40,
                );
            });

            after(async () => closeTestServer(server));

            it("creates and uses only oil-specific data points", async function () {
                this.timeout(15000);
                const harness = getHarness();
                assert.ok(await harness.objects.getObjectAsync(deviceState(MAC_A, "settings.heating_level_percentage")));
                assert.strictEqual(await harness.objects.getObjectAsync(deviceState(MAC_A, "settings.limited_heating_power")), null);
                assert.strictEqual(await harness.objects.getObjectAsync(deviceState(MAC_A, "settings.additional_mode")), null);
                assert.ok(mock.countRequests("GET", "/oil-heater-power") > 0);
                assert.strictEqual(mock.countRequests("GET", "/limited-heating-power"), 0);
                assert.strictEqual(mock.countRequests("GET", "/additional-socket-mode"), 0);

                for (const value of [40, 60, 100]) {
                    const requestPromise = mock.waitForRequest("POST", "/oil-heater-power", mock.requests.length);
                    await harness.states.setStateAsync(deviceState(MAC_A, "settings.heating_level_percentage"), {
                        val: value,
                        ack: false,
                    });
                    assert.deepStrictEqual((await requestPromise).body, { heating_level_percentage: value });
                    await waitForState(
                        harness,
                        deviceState(MAC_A, "settings.heating_level_percentage"),
                        state => state.ack === true && state.val === value,
                    );
                }

                for (const value of [20, 80]) {
                    await mock.assertNoRequestAfter(async () => {
                        await harness.states.setStateAsync(deviceState(MAC_A, "settings.heating_level_percentage"), {
                            val: value,
                            ack: false,
                        });
                    }, "POST", "/oil-heater-power");
                }
            });
        });

        suite("07 - Panel heater", getHarness => {
            let server;
            let mock;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("07 - Panel heater");
                const harness = getHarness();
                mock = createDeviceMock({
                    macAddress: MAC_A,
                    modelName: "Mill Panel Heater",
                    limitedHeatingPower: 100,
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Panel heater", port)]);
                await harness.startAdapterAndWait();
                await waitForState(
                    harness,
                    deviceState(MAC_A, "settings.limited_heating_power"),
                    state => state.val === 100,
                );
            });

            after(async () => closeTestServer(server));

            it("creates and uses only panel-specific data points", async function () {
                const harness = getHarness();
                assert.ok(await harness.objects.getObjectAsync(deviceState(MAC_A, "settings.limited_heating_power")));
                assert.strictEqual(await harness.objects.getObjectAsync(deviceState(MAC_A, "settings.heating_level_percentage")), null);
                assert.strictEqual(await harness.objects.getObjectAsync(deviceState(MAC_A, "settings.additional_mode")), null);
                assert.ok(mock.countRequests("GET", "/limited-heating-power") > 0);
                assert.strictEqual(mock.countRequests("GET", "/oil-heater-power"), 0);
                assert.strictEqual(mock.countRequests("GET", "/additional-socket-mode"), 0);

                for (const value of [10, 80, 100]) {
                    const requestPromise = mock.waitForRequest("POST", "/limited-heating-power", mock.requests.length);
                    await harness.states.setStateAsync(deviceState(MAC_A, "settings.limited_heating_power"), {
                        val: value,
                        ack: false,
                    });
                    assert.deepStrictEqual((await requestPromise).body, { limited_heating_power: value });
                    await waitForState(
                        harness,
                        deviceState(MAC_A, "settings.limited_heating_power"),
                        state => state.ack === true && state.val === value,
                    );
                }

                for (const value of [9, 101, 50.5]) {
                    await mock.assertNoRequestAfter(async () => {
                        await harness.states.setStateAsync(deviceState(MAC_A, "settings.limited_heating_power"), {
                            val: value,
                            ack: false,
                        });
                    }, "POST", "/limited-heating-power");
                }
            });
        });

        suite("08 - Wi-Fi socket", getHarness => {
            let server;
            let mock;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("08 - Wi-Fi socket");
                const harness = getHarness();
                mock = createDeviceMock({
                    macAddress: MAC_A,
                    modelName: "Mill HeaterGen3Socket",
                    additionalMode: 3,
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Socket", port)]);
                await harness.startAdapterAndWait();
                await waitForState(
                    harness,
                    deviceState(MAC_A, "settings.additional_mode"),
                    state => state.val === 3,
                );
            });

            after(async () => closeTestServer(server));

            it("creates and uses only socket-specific data points", async function () {
                const harness = getHarness();
                assert.ok(await harness.objects.getObjectAsync(deviceState(MAC_A, "settings.additional_mode")));
                assert.strictEqual(await harness.objects.getObjectAsync(deviceState(MAC_A, "settings.heating_level_percentage")), null);
                assert.strictEqual(await harness.objects.getObjectAsync(deviceState(MAC_A, "settings.limited_heating_power")), null);
                assert.ok(mock.countRequests("GET", "/additional-socket-mode") > 0);
                assert.strictEqual(mock.countRequests("GET", "/oil-heater-power"), 0);
                assert.strictEqual(mock.countRequests("GET", "/limited-heating-power"), 0);

                for (const value of [0, 2, 4]) {
                    const requestPromise = mock.waitForRequest("POST", "/additional-socket-mode", mock.requests.length);
                    await harness.states.setStateAsync(deviceState(MAC_A, "settings.additional_mode"), {
                        val: value,
                        ack: false,
                    });
                    assert.deepStrictEqual((await requestPromise).body, { additional_mode: value });
                    await waitForState(
                        harness,
                        deviceState(MAC_A, "settings.additional_mode"),
                        state => state.ack === true && state.val === value,
                    );
                }

                for (const value of [-1, 5, 2.5]) {
                    await mock.assertNoRequestAfter(async () => {
                        await harness.states.setStateAsync(deviceState(MAC_A, "settings.additional_mode"), {
                            val: value,
                            ack: false,
                        });
                    }, "POST", "/additional-socket-mode");
                }
            });
        });

        suite("09 - Model-specific write protection, acknowledges unsupported writes without API requests", getHarness => {
            let server;
            let mock;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("09 - Model-specific write protection");
                const harness = getHarness();
                await seedDeviceTree(harness, MAC_A, {
                    name: "Previously an oil heater",
                    host: "127.0.0.1:12002",
                    seedAllModelStates: true,
                });
                mock = createDeviceMock({ macAddress: MAC_A, modelName: "Mill Convection Heater" });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Generic heater", port)]);
                await harness.startAdapterAndWait();
                await waitForState(harness, deviceState(MAC_A, "status.mac_address"), state => state.val === MAC_A);
                await waitForState(
                    harness,
                    deviceState(MAC_A, "control-status.current_power"),
                    state => state.val === 750,
                );
            });

            after(async () => closeTestServer(server));

            it("keeps legacy model datapoints but does not send unsupported writes", async function () {
                const harness = getHarness();
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "status.name"))).val,
                    "Mill Convection Heater",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "info.deviceType"))).val,
                    "Convection",
                );
                const unsupportedWrites = [
                    { id: "settings.heating_level_percentage", value: 60, attemptedValue: 100, endpoint: "/oil-heater-power" },
                    { id: "settings.limited_heating_power", value: 80, attemptedValue: 90, endpoint: "/limited-heating-power" },
                    { id: "settings.additional_mode", value: 3, attemptedValue: 4, endpoint: "/additional-socket-mode" },
                ];

                for (const test of unsupportedWrites) {
                    const stateId = deviceState(MAC_A, test.id);
                    assert.ok(await harness.objects.getObjectAsync(stateId), `${test.id} must be preserved.`);
                    assert.strictEqual((await harness.states.getStateAsync(stateId)).val, test.value);
                    assert.strictEqual(mock.countRequests("GET", test.endpoint), 0);
                    await mock.assertNoRequestAfter(async () => {
                        await harness.states.setStateAsync(stateId, { val: test.attemptedValue, ack: false });
                        // Wait until the unsupported write is reset and acknowledged.
                        await waitForState(
                            harness,
                            stateId,
                            state => state.ack === true && state.val === null,
                        );
                    }, "POST", test.endpoint);
                    assert.strictEqual(mock.countRequests("POST", test.endpoint), 0);
                    assert.ok(await harness.objects.getObjectAsync(stateId), `${test.id} must not be deleted.`);
                }
            });
        });

        suite("10 - API request serialization", getHarness => {
            let server;
            let mock;
            let delayNextControlStatus = false;
            let delayNextSetTemperature = false;
            let reportedSetTemperature = 22;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("10 - API request serialization");
                const harness = getHarness();
                mock = createTrackedServer(request => {
                    if (request.path === "/status") {
                        return createStatusResponse({ macAddress: MAC_A });
                    }
                    if (request.path === "/temperature-calibration-offset") {
                        return createCalibrationResponse(2);
                    }
                    if (request.path === "/control-status") {
                        if (delayNextControlStatus) {
                            delayNextControlStatus = false;
                            return {
                                ...createControlStatusResponse({
                                    set_temperature: reportedSetTemperature,
                                }),
                                delayMs: 900,
                            };
                        }

                        return createControlStatusResponse({
                            set_temperature: reportedSetTemperature,
                        });
                    }
                    if (request.path === "/set-temperature") {
                        reportedSetTemperature = request.body.value;

                        if (delayNextSetTemperature) {
                            delayNextSetTemperature = false;
                            return { body: { status: "ok" }, delayMs: 2500 };
                        }

                        return { body: { status: "ok" } };
                    }
                    return { statusCode: 404, body: { status: "error" } };
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Mutex test", port)], {
                    apiTimeout: 3,
                    pollInterval1: 4,
                    pollInterval2: 60,
                });
                await harness.startAdapterAndWait();
                await waitForState(harness, deviceState(MAC_A, "control-status.set_temperature"), state => state.val === 22);
            });

            after(async () => closeTestServer(server));

            it("queues a normal write behind an already running API request", async function () {
                this.timeout(12000);
                const harness = getHarness();
                delayNextControlStatus = true;
                const controlPromise = mock.waitForRequest("GET", "/control-status");
                await controlPromise;

                const writeCount = mock.countRequests("POST", "/set-temperature");
                const writePromise = mock.waitForRequest("POST", "/set-temperature", mock.requests.length);
                await harness.states.setStateAsync(deviceState(MAC_A, "control-status.set_temperature"), {
                    val: 23,
                    ack: false,
                });
                await new Promise(resolve => setTimeout(resolve, 150));
                assert.strictEqual(
                    mock.countRequests("POST", "/set-temperature"),
                    writeCount,
                    "Write request started while the previous API request was still running.",
                );
                const writeRequest = await writePromise;
                assert.deepStrictEqual(writeRequest.body, { type: "Normal", value: 23 });
                await waitForState(
                    harness,
                    deviceState(MAC_A, "control-status.set_temperature"),
                    state => state.ack === true && state.val === 23,
                );
            });
            it("limits the number of pending state changes per device", async function () {
                this.timeout(25000);
                const harness = getHarness();
                const stateId = deviceState(MAC_A, "control-status.set_temperature");
                const writeCount = mock.countRequests("POST", "/set-temperature");

                // Hold the first write request to build up the pending queue.
                delayNextSetTemperature = true;

                const firstWritePromise = mock.waitForRequest("POST", "/set-temperature", mock.requests.length);
                await harness.states.setStateAsync(stateId, { val: 24, ack: false });

                const firstWrite = await firstWritePromise;
                assert.deepStrictEqual(firstWrite.body, { type: "Normal", value: 24 });

                // Queue nine additional writes: ten handlers in total.
                for (let value = 25; value <= 33; value++) {
                    await harness.states.setStateAsync(stateId, { val: value, ack: false });
                }

                // The eleventh write must be rejected.
                await harness.states.setStateAsync(stateId, { val: 34, ack: false });

                const overflowWarning = /Rejecting write to .*: too many pending state changes/;
                const warningDeadline = Date.now() + 2000;

                while (!harness.hasLog(overflowWarning, "warn") && Date.now() < warningDeadline) {
                    await new Promise(resolve => setTimeout(resolve, 25));
                }

                assert.ok(
                    harness.hasLog(overflowWarning, "warn"),
                    "Exceeding the pending state-change limit must generate a warning.",
                );

                // All ten accepted writes must complete.
                await waitForState(harness, stateId, state => state.ack === true && state.val === 33, 15000);

                assert.strictEqual(
                    mock.countRequests("POST", "/set-temperature"),
                    writeCount + 10,
                    "Exactly ten writes must reach the Mill API; the eleventh must be rejected.",
                );

                // Allow the remaining post-write API updates to finish.
                await new Promise(resolve => setTimeout(resolve, 250));

                // The queue must accept new writes again after draining.
                const recoveryWritePromise = mock.waitForRequest("POST", "/set-temperature", mock.requests.length);

                await harness.states.setStateAsync(stateId, { val: 35, ack: false });

                const recoveryWrite = await recoveryWritePromise;
                assert.deepStrictEqual(recoveryWrite.body, { type: "Normal", value: 35 });

                await waitForState(harness, stateId, state => state.ack === true && state.val === 35);
            });
        });

        suite("11 - Polling is skipped while a write request is running", getHarness => {
            let server;
            let mock;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("11 - Polling is skipped while a write request is running");
                const harness = getHarness();
                mock = createTrackedServer(request => {
                    if (request.path === "/status") {
                        return createStatusResponse({ macAddress: MAC_A });
                    }
                    if (request.path === "/temperature-calibration-offset") {
                        return createCalibrationResponse(2);
                    }
                    if (request.path === "/control-status") {
                        return createControlStatusResponse();
                    }
                    if (request.path === "/set-temperature") {
                        return { delayMs: 7000, body: { status: "ok" } };
                    }
                    return { statusCode: 404, body: { status: "error" } };
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Polling priority", port)], {
                    apiTimeout: 5,
                    pollInterval1: 6,
                    pollInterval2: 60,
                });
                await harness.startAdapterAndWait();
                await waitForState(harness, deviceState(MAC_A, "control-status.set_temperature"), state => state.val === 22);
            });

            after(async () => closeTestServer(server));

            it("does not start a skippable poll while a POST owns the API mutex", async function () {
                this.timeout(15000);
                const harness = getHarness();
                await new Promise(resolve => setTimeout(resolve, 2000));
                const controlCount = mock.countRequests("GET", "/control-status");
                const writePromise = mock.waitForRequest("POST", "/set-temperature", mock.requests.length);
                await harness.states.setStateAsync(deviceState(MAC_A, "control-status.set_temperature"), {
                    val: 23,
                    ack: false,
                });
                await writePromise;

                // The next fast poll is due while the delayed write still holds the mutex.
                await new Promise(resolve => setTimeout(resolve, 4500));
                assert.strictEqual(
                    mock.countRequests("GET", "/control-status"),
                    controlCount,
                    "Fast polling was not skipped while the write request was running.",
                );
                await new Promise(resolve => setTimeout(resolve, 700));
                assert.strictEqual(mock.countRequests("POST", "/set-temperature"), 1);
            });
        });

        suite("12 - MAC replacement preserves the old tree", getHarness => {
            let server;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("12 - MAC replacement preserves the old tree");
                const harness = getHarness();
                const mock = createDeviceMock({ macAddress: MAC_A, modelName: "generic" });
                server = mock.server;
                const port = await startTestServer(server);
                await seedDeviceTree(harness, MAC_OLD, {
                    host: `127.0.0.1:${port}`,
                    name: "Replaced heater",
                    connected: true,
                    operationKey: "old-device-history",
                });
                await configureHarness(harness, [deviceConfig("Replacement device", port)]);
                await harness.startAdapterAndWait();
                await waitForState(harness, deviceState(MAC_A, "status.mac_address"), state => state.val === MAC_A);
                await waitForState(harness, deviceState(MAC_A, "info.connection"), state => state.val === true);
            });

            after(async () => closeTestServer(server));

            it("creates the new tree and keeps the previous tree offline with its values", async function () {
                const harness = getHarness();
                assert.ok(await harness.objects.getObjectAsync(deviceRoot(MAC_A)));
                assert.ok(await harness.objects.getObjectAsync(deviceRoot(MAC_OLD)));
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_OLD, "info.connection"))).val,
                    false,
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_OLD, "status.operation_key"))).val,
                    "old-device-history",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "status.operation_key"))).val,
                    "test-operation",
                    "The new MAC tree must receive its own API values.",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "info.connection"))).val,
                    true,
                );
            });
        });

        suite("13 - Known MAC with changed IP and name", getHarness => {
            let server;
            let port;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("13 - Known MAC with changed IP and name");
                const harness = getHarness();
                await seedDeviceTree(harness, MAC_A, {
                    host: "127.0.0.1:12001",
                    name: "Old room name",
                    operationKey: "keep-existing-operation-key",
                });
                const mock = createDeviceMock({
                    // MAC normalization must reuse the existing lowercase tree.
                    macAddress: MAC_A.toUpperCase(),
                    modelName: "generic",
                    omitOperationKey: true,
                });
                server = mock.server;
                port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("New room name", port)]);
                await harness.startAdapterAndWait();
                await waitForState(harness, deviceState(MAC_A, "info.host"), state => state.val === `127.0.0.1:${port}`);
                await waitForState(harness, deviceState(MAC_A, "info.name"), state => state.val === "New room name");
                await waitForState(harness, deviceState(MAC_A, "info.connection"), state => state.val === true);
            });

            after(async () => closeTestServer(server));

            it("reuses the same tree, updates host/name and preserves existing values", async function () {
                const harness = getHarness();
                const object = await harness.objects.getObjectAsync(deviceRoot(MAC_A));
                assert.strictEqual(object.common.name, "New room name");
                assert.strictEqual(object.native.host, `127.0.0.1:${port}`);
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "status.operation_key"))).val,
                    "keep-existing-operation-key",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "info.name"))).val,
                    "New room name",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "info.connection"))).val,
                    true,
                );
            });
        });

        suite("14 - Duplicate MAC on two configured IP addresses", getHarness => {
            let serverA;
            let serverB;
            let mockA;
            let mockB;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("14 - Duplicate MAC on two configured IP addresses");
                const harness = getHarness();
                mockA = createDeviceMock({ macAddress: MAC_A, modelName: "generic", customName: "First host" });
                mockB = createDeviceMock({ macAddress: MAC_A.toUpperCase(), modelName: "generic", customName: "Second host" });
                serverA = mockA.server;
                serverB = mockB.server;
                const [portA, portB] = await Promise.all([
                    startTestServer(serverA),
                    startTestServer(serverB),
                ]);
                await configureHarness(harness, [
                    deviceConfig("First configured device", portA),
                    deviceConfig("Second configured device", portB),
                ]);
                await harness.startAdapterAndWait();
                await mockA.waitForRequest("GET", "/status", 0);
                await mockB.waitForRequest("GET", "/status", 0);
                await waitForState(harness, deviceState(MAC_A, "status.mac_address"), state => state.val === MAC_A);
                await waitForState(harness, `${INSTANCE}.info.connection`, state => state.val === true);
            });

            after(async () => Promise.all([closeTestServer(serverA), closeTestServer(serverB)]));

            it("keeps one owner for the MAC and does not let the second IP overwrite it", async function () {
                const harness = getHarness();
                const root = await harness.objects.getObjectAsync(deviceRoot(MAC_A));
                assert.ok(root, "The first identified device tree must exist.");
                const configuredHost = root.native.host;
                assert.ok(
                    configuredHost === `127.0.0.1:${serverA.address().port}` ||
                    configuredHost === `127.0.0.1:${serverB.address().port}`,
                    "The MAC tree must retain exactly one of the configured hosts.",
                );
                assert.strictEqual(
                    root.common.name,
                    configuredHost === `127.0.0.1:${serverA.address().port}`
                        ? "First configured device"
                        : "Second configured device",
                    "The duplicate IP must not overwrite the name of the MAC tree owner.",
                );
                assert.strictEqual(
                    await harness.objects.getObjectAsync(deviceRoot(MAC_B)),
                    null,
                    "No second tree may be created for the duplicate MAC.",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(`${INSTANCE}.info.connection`)).val,
                    true,
                    "The aggregate instance connection must be true while at least one configured device is connected.",
                );
                assert.ok(mockA.countRequests("GET", "/status") > 0);
                assert.ok(mockB.countRequests("GET", "/status") > 0);
                assert.ok(
                    harness.hasLog(/MAC address .*already assigned/, "error"),
                    "The duplicate MAC must be recorded as an error.",
                );
                assert.strictEqual(
                    mockA.countRequests("GET", "/control-status") + mockB.countRequests("GET", "/control-status"),
                    1,
                    "Only the device instance owning the MAC may continue polling.",
                );
            });
        });

        suite("15 - Duplicate configured host is ignored", getHarness => {
            let server;
            let mock;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("15 - Duplicate configured host is ignored");
                const harness = getHarness();
                mock = createDeviceMock({ macAddress: MAC_A, modelName: "generic" });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [
                    deviceConfig("First entry", port),
                    deviceConfig("Duplicate entry", port),
                ]);
                await harness.startAdapterAndWait();
                await waitForState(harness, deviceState(MAC_A, "status.mac_address"), state => state.val === MAC_A);
                await waitForState(harness, `${INSTANCE}.info.connection`, state => state.val === true);
            });

            after(async () => closeTestServer(server));

            it("creates only one device instance for the same configured host", async function () {
                assert.strictEqual(mock.countRequests("GET", "/status"), 1);
                const harness = getHarness();
                assert.ok(await harness.objects.getObjectAsync(deviceRoot(MAC_A)));
                assert.strictEqual(
                    (await harness.states.getStateAsync(`${INSTANCE}.info.connection`)).val,
                    true,
                );
            });
        });

        suite("16 - Missing or invalid MAC address", getHarness => {
            let server;
            let mock;
            let reportedMac;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("16 - Missing or invalid MAC address");
                const harness = getHarness();
                reportedMac = undefined;
                mock = createTrackedServer(request => {
                    if (request.path === "/status") {
                        const body = {
                            status: "ok",
                            name: "generic",
                            custom_name: "Recovering heater",
                            version: "1.2.3",
                        };
                        if (reportedMac !== undefined) {
                            body.mac_address = reportedMac;
                        }
                        return { body };
                    }
                    if (request.path === "/temperature-calibration-offset") {
                        return createCalibrationResponse(2);
                    }
                    if (request.path === "/control-status") {
                        return createControlStatusResponse();
                    }
                    return { statusCode: 404, body: { status: "error" } };
                });
                server = mock.server;
                const port = await startTestServer(server);
                await seedDeviceTree(harness, MAC_OLD, {
                    host: `127.0.0.1:${port}`,
                    connected: true,
                    operationKey: "preserve-without-mac",
                });
                await configureHarness(harness, [deviceConfig("MAC recovery", port)], {
                    apiTimeout: 1,
                    pollInterval1: 2,
                    pollInterval2: 60,
                });
                await harness.startAdapterAndWait();
                await waitForState(
                    harness,
                    deviceState(MAC_OLD, "info.connection"),
                    state => state.val === false,
                );
            });

            after(async () => closeTestServer(server));

            it("does not identify a device without a valid MAC and recovers when one is reported", async function () {
                this.timeout(15000);
                const harness = getHarness();

                assert.strictEqual(await harness.objects.getObjectAsync(deviceRoot(MAC_A)), null);
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_OLD, "info.connection"))).val,
                    false,
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_OLD, "status.operation_key"))).val,
                    "preserve-without-mac",
                );

                // An invalid MAC must be rejected just like a missing MAC.
                reportedMac = "not-a-valid-mac";
                const invalidRequestCount = mock.countRequests("GET", "/status");
                await mock.waitForRequest("GET", "/status", invalidRequestCount);

                // Wait for the next status poll to ensure the invalid response was processed.
                await mock.waitForRequest("GET", "/status", invalidRequestCount + 1);

                assert.strictEqual(await harness.objects.getObjectAsync(deviceRoot(MAC_A)), null);

                // A later valid response must allow normal identification and initialization.
                reportedMac = MAC_A;
                const validRequest = mock.waitForRequest("GET", "/status", mock.requests.length);
                await validRequest;
                await waitForState(
                    harness,
                    deviceState(MAC_A, "status.mac_address"),
                    state => state.val === MAC_A,
                );
                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === true,
                );
                assert.ok(await harness.objects.getObjectAsync(deviceRoot(MAC_A)));
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "info.connection"))).val,
                    true,
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_OLD, "info.connection"))).val,
                    false,
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_OLD, "status.operation_key"))).val,
                    "preserve-without-mac",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync("system.adapter.millheater.0.alive")).val,
                    true,
                );
            });
        });

        suite("17 - API shutdown", getHarness => {
            let server;
            let mock;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("17 - API shutdown");
                const harness = getHarness();
                mock = createTrackedServer(request => {
                    if (request.path === "/status") {
                        return createStatusResponse({ macAddress: MAC_A });
                    }
                    if (request.path === "/temperature-calibration-offset") {
                        return createCalibrationResponse(2);
                    }
                    if (request.path === "/control-status") {
                        return { ...createControlStatusResponse(), delayMs: 1200 };
                    }
                    if (request.path === "/set-temperature") {
                        return { body: { status: "ok" } };
                    }
                    return { statusCode: 404, body: { status: "error" } };
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Shutdown test", port)], {
                    apiTimeout: 3,
                    pollInterval1: 4,
                    pollInterval2: 60,
                });
                await harness.startAdapterAndWait();
                await waitForState(harness, deviceState(MAC_A, "control-status.current_power"), state => state.val === 750);
            });

            after(async () => closeTestServer(server));

            it("cancels API requests waiting for the mutex during shutdown", async function () {
                this.timeout(10000);
                const harness = getHarness();
                await mock.waitForRequest("GET", "/control-status");
                const postCount = mock.countRequests("POST", "/set-temperature");
                await harness.states.setStateAsync(deviceState(MAC_A, "control-status.set_temperature"), {
                    val: 23,
                    ack: false,
                });
                await new Promise(resolve => setTimeout(resolve, 100));
                assert.strictEqual(mock.countRequests("POST", "/set-temperature"), postCount);

                await harness.stopAdapter();
                assert.strictEqual(
                    mock.countRequests("POST", "/set-temperature"),
                    postCount,
                    "The queued write must not run during shutdown.",
                );
            });
        });

        suite("18 - Fast update aborts when operation mode changes to Off", getHarness => {
            let server;
            let mock;
            let operationMode = "Control individually";

            before(async function () {
                this.timeout(15000);
                logSuiteStart("18 - Fast update aborts when operation mode changes to Off");
                const harness = getHarness();
                mock = createTrackedServer(request => {
                    switch (request.path) {
                        case "/status":
                            return createStatusResponse({
                                macAddress: MAC_A,
                                modelName: "Mill Oil Heater",
                            });
                        case "/temperature-calibration-offset":
                            return createCalibrationResponse(2);
                        case "/control-status":
                            return createControlStatusResponse({ operation_mode: operationMode });
                        case "/oil-heater-power":
                            return { body: { status: "ok", value: 40 } };
                        default:
                            return { statusCode: 404, body: { status: "error" } };
                    }
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Oil heater", port, false)], {
                    apiTimeout: 1,
                    pollInterval1: 2,
                    pollInterval2: 60,
                });
                await harness.startAdapterAndWait();
                await mock.waitForRequest("GET", "/oil-heater-power", 0);
                assert.strictEqual(mock.countRequests("GET", "/oil-heater-power"), 1);
            });

            after(async () => closeTestServer(server));

            it("aborts the current fast update and suspends polling when operation mode is Off", async function () {
                this.timeout(10000);
                const harness = getHarness();
                const nextControlStatusRequest = mock.waitForRequest("GET", "/control-status");
                operationMode = "Off";
                await nextControlStatusRequest;
                await waitForState(
                    harness,
                    deviceState(MAC_A, "control-status.operation_mode"),
                    state => state.val === "Off",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "control-status.switched_on"))).val,
                    true,
                    "The test deliberately keeps switched_on true to verify that operation_mode controls polling.",
                );
                // The in-flight fast update must stop before requesting oil-specific data.
                await new Promise(resolve => setTimeout(resolve, 300));
                assert.strictEqual(
                    mock.countRequests("GET", "/oil-heater-power"),
                    1,
                    "No additional model-specific request may run after operation mode Off was detected.",
                );
                // Polling is suspended as well; no further fast update should be scheduled.
                const stoppedControlStatusCount = mock.countRequests("GET", "/control-status");
                await new Promise(resolve => setTimeout(resolve, 2300));
                assert.strictEqual(
                    mock.countRequests("GET", "/control-status"),
                    stoppedControlStatusCount,
                    "Fast polling must remain suspended while operation mode is Off.",
                );
            });
        });

        suite("19 - Polling continues when enabled while operation mode is Off", getHarness => {
            let server;
            let mock;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("19 - Polling continues when enabled while operation mode is Off");
                const harness = getHarness();
                mock = createDeviceMock({
                    macAddress: MAC_A,
                    modelName: "Mill Oil Heater",
                    operationMode: "Off",
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Oil heater", port, true)], {
                    apiTimeout: 1,
                    pollInterval1: 2,
                    pollInterval2: 60,
                });
                await harness.startAdapterAndWait();
                await waitForState(
                    harness,
                    deviceState(MAC_A, "settings.heating_level_percentage"),
                    state => state.val === 40,
                );
            });

            after(async () => closeTestServer(server));

            it("continues model-specific polling when pollWhenOff is enabled", async function () {
                this.timeout(10000);
                const initialControlStatusCount = mock.countRequests("GET", "/control-status");
                const initialOilPowerCount = mock.countRequests("GET", "/oil-heater-power");
                assert.ok(initialControlStatusCount >= 1);
                assert.strictEqual(initialOilPowerCount, 1);

                await mock.waitForRequest("GET", "/control-status", mock.requests.length);
                await waitForState(
                    getHarness(),
                    deviceState(MAC_A, "control-status.operation_mode"),
                    state => state.val === "Off",
                );
                await mock.waitForRequest("GET", "/oil-heater-power", mock.requests.length);
                assert.ok(
                    mock.countRequests("GET", "/oil-heater-power") >= 2,
                    "The model-specific endpoint must continue to be polled when pollWhenOff is enabled.",
                );
            });
        });

        suite("20 - Polling resumes when operation mode is switched on", getHarness => {
            let server;
            let mock;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("20 - Polling resumes when operation mode is switched on");
                const harness = getHarness();
                mock = createDeviceMock({
                    macAddress: MAC_A,
                    modelName: "Mill Oil Heater",
                    operationMode: "Off",
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Oil heater", port, false)], {
                    apiTimeout: 1,
                    pollInterval1: 2,
                    pollInterval2: 60,
                });
                await harness.startAdapterAndWait();
                await waitForState(
                    harness,
                    deviceState(MAC_A, "control-status.operation_mode"),
                    state => state.val === "Off",
                );
                await mock.assertNoRequestAfter(async () => {
                    await waitForState(
                        harness,
                        deviceState(MAC_A, "control-status.operation_mode"),
                        state => state.val === "Off",
                    );
                }, "GET", "/oil-heater-power", 300);
            });

            after(async () => closeTestServer(server));

            it("restarts fast and model-specific polling after an ioBroker switch-on", async function () {
                this.timeout(12000);
                const harness = getHarness();
                const controlStatusCount = mock.countRequests("GET", "/control-status");
                const operationModeWrite = mock.waitForRequest("POST", "/operation-mode", mock.requests.length);

                await harness.states.setStateAsync(deviceState(MAC_A, "control-status.operation_mode"), {
                    val: "Control individually",
                    ack: false,
                });

                assert.deepStrictEqual((await operationModeWrite).body, { mode: "Control individually" });
                await waitForState(
                    harness,
                    deviceState(MAC_A, "control-status.operation_mode"),
                    state => state.ack === true && state.val === "Control individually",
                );

                const firstControlStatus = await mock.waitForRequest(
                    "GET",
                    "/control-status",
                    controlStatusCount,
                );
                const firstOilPower = await mock.waitForRequest("GET", "/oil-heater-power", 0);
                const firstOilPowerIndex = mock.requests.indexOf(firstOilPower);
                await mock.waitForRequest("GET", "/oil-heater-power", firstOilPowerIndex + 1);

                assert.ok(
                    mock.countRequests("GET", "/control-status") >= controlStatusCount + 2,
                    "Fast polling must resume after operation mode leaves Off.",
                );
                assert.ok(firstControlStatus, "The immediate control-status update must run after switch-on.");
            });
        });

        suite("21 - MAC changes while the device is running", getHarness => {
            let server;
            let mock;
            let reportedMac = MAC_A;
            let reportedOperationKey = "initial-device-a";
            let reportedSetTemperature = 22;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("21 - MAC changes while the device is running");
                const harness = getHarness();
                mock = createTrackedServer(request => {
                    switch (request.path) {
                        case "/status":
                            return createStatusResponse({
                                macAddress: reportedMac,
                                modelName: "generic",
                                operationKey: reportedOperationKey,
                            });
                        case "/control-status": {
                            const response = createControlStatusResponse();
                            response.body.set_temperature = reportedSetTemperature;
                            return response;
                        }
                        case "/temperature-calibration-offset":
                            return createCalibrationResponse(2);
                        case "/set-temperature":
                            reportedSetTemperature = request.body.value;
                            return { body: { status: "ok" } };
                        default:
                            return { statusCode: 404, body: { status: "error" } };
                    }
                });
                server = mock.server;
                const port = await startTestServer(server);
                await configureHarness(harness, [deviceConfig("Changing MAC device", port)], {
                    apiTimeout: 1,
                    pollInterval1: 2,
                    pollInterval2: 4,
                });
                await harness.startAdapterAndWait();
                await waitForState(
                    harness,
                    deviceState(MAC_A, "status.operation_key"),
                    state => state.val === "initial-device-a",
                );
                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === true,
                );
            });

            after(async () => closeTestServer(server));

            it("creates a new tree, retires the old tree, and reuses a known tree on a later MAC change", async function () {
                this.timeout(25000);
                const harness = getHarness();

                let statusCount = mock.countRequests("GET", "/status");
                reportedMac = MAC_B;
                reportedOperationKey = "device-b";
                await mock.waitForRequest("GET", "/status", statusCount);
                await waitForState(
                    harness,
                    deviceState(MAC_B, "status.operation_key"),
                    state => state.val === "device-b",
                );
                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === false,
                );

                await waitForState(
                    harness,
                    deviceState(MAC_B, "info.connection"),
                    state => state.val === true,
                );

                assert.ok(await harness.objects.getObjectAsync(deviceRoot(MAC_A)));
                assert.ok(await harness.objects.getObjectAsync(deviceRoot(MAC_B)));
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "info.connection"))).val,
                    false,
                    "The previous MAC tree must be marked offline.",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "status.operation_key"))).val,
                    "initial-device-a",
                    "The previous MAC tree must retain its historical values.",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_B, "info.connection"))).val,
                    true,
                );

                await mock.assertNoRequestAfter(async () => {
                    await harness.states.setStateAsync(deviceState(MAC_A, "control-status.set_temperature"), {
                        val: 23,
                        ack: false,
                    });
                }, "POST", "/set-temperature");

                const writeToB = mock.waitForRequest("POST", "/set-temperature", mock.requests.length);
                await harness.states.setStateAsync(deviceState(MAC_B, "control-status.set_temperature"), {
                    val: 24,
                    ack: false,
                });
                assert.deepStrictEqual((await writeToB).body, { type: "Normal", value: 24 });
                await waitForState(
                    harness,
                    deviceState(MAC_B, "control-status.set_temperature"),
                    state => state.ack === true && state.val === 24,
                );

                statusCount = mock.countRequests("GET", "/status");
                reportedMac = MAC_A;
                reportedOperationKey = "returned-device-a";
                await mock.waitForRequest("GET", "/status", statusCount);
                await waitForState(
                    harness,
                    deviceState(MAC_A, "status.operation_key"),
                    state => state.val === "returned-device-a",
                );
                await waitForState(
                    harness,
                    deviceState(MAC_B, "info.connection"),
                    state => state.val === false,
                );

                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === true,
                );

                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_B, "info.connection"))).val,
                    false,
                    "The MAC_B tree must be marked offline after the device returns to MAC_A.",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "info.connection"))).val,
                    true,
                    "The previously known MAC_A tree must become active again.",
                );
                assert.strictEqual(await harness.objects.getObjectAsync(deviceRoot(MAC_A)) !== null, true);
                assert.strictEqual(await harness.objects.getObjectAsync(deviceRoot(MAC_B)) !== null, true);

                const writesBeforeRetiredB = mock.countRequests("POST", "/set-temperature");
                await mock.assertNoRequestAfter(async () => {
                    await harness.states.setStateAsync(deviceState(MAC_B, "control-status.set_temperature"), {
                        val: 25,
                        ack: false,
                    });
                }, "POST", "/set-temperature");
                assert.strictEqual(mock.countRequests("POST", "/set-temperature"), writesBeforeRetiredB);

                const writeToA = mock.waitForRequest("POST", "/set-temperature", mock.requests.length);
                await harness.states.setStateAsync(deviceState(MAC_A, "control-status.set_temperature"), {
                    val: 26,
                    ack: false,
                });
                assert.deepStrictEqual((await writeToA).body, { type: "Normal", value: 26 });
            });
        });

        suite("22 - MAC changes to an address owned by another configured device", getHarness => {
            let serverA;
            let serverB;
            let mockA;
            let mockB;
            let reportedMacA = MAC_A;

            before(async function () {
                this.timeout(15000);
                logSuiteStart("22 - MAC changes to an address owned by another configured device");
                const harness = getHarness();
                mockA = createTrackedServer(request => {
                    if (request.path === "/status") {
                        return createStatusResponse({
                            macAddress: reportedMacA,
                            modelName: "generic",
                            operationKey: "device-a",
                        });
                    }
                    if (request.path === "/control-status") {
                        return createControlStatusResponse({ current_power: 410 });
                    }
                    if (request.path === "/temperature-calibration-offset") {
                        return createCalibrationResponse(2);
                    }
                    if (request.path === "/set-temperature") {
                        return { body: { status: "ok" } };
                    }
                    return { statusCode: 404, body: { status: "error" } };
                });
                mockB = createTrackedServer(request => {
                    if (request.path === "/status") {
                        return createStatusResponse({
                            macAddress: MAC_B,
                            modelName: "generic",
                            operationKey: "device-b",
                        });
                    }
                    if (request.path === "/control-status") {
                        return createControlStatusResponse({ current_power: 820 });
                    }
                    if (request.path === "/temperature-calibration-offset") {
                        return createCalibrationResponse(2);
                    }
                    if (request.path === "/set-temperature") {
                        return { body: { status: "ok" } };
                    }
                    return { statusCode: 404, body: { status: "error" } };
                });
                serverA = mockA.server;
                serverB = mockB.server;
                const [portA, portB] = await Promise.all([
                    startTestServer(serverA),
                    startTestServer(serverB),
                ]);
                await configureHarness(harness, [
                    deviceConfig("Device A", portA),
                    deviceConfig("Device B", portB),
                ], {
                    apiTimeout: 1,
                    pollInterval1: 2,
                    pollInterval2: 4,
                });
                await harness.startAdapterAndWait();
                await waitForState(
                    harness,
                    deviceState(MAC_A, "status.operation_key"),
                    state => state.val === "device-a",
                );
                await waitForState(
                    harness,
                    deviceState(MAC_B, "status.operation_key"),
                    state => state.val === "device-b",
                );
                await waitForState(harness, deviceState(MAC_A, "info.connection"), state => state.val === true);
                await waitForState(harness, deviceState(MAC_B, "info.connection"), state => state.val === true);
            });

            after(async () => Promise.all([closeTestServer(serverA), closeTestServer(serverB)]));

            it("disables the changing device without taking the existing MAC owner offline", async function () {
                this.timeout(20000);
                const harness = getHarness();
                const statusCountA = mockA.countRequests("GET", "/status");
                reportedMacA = MAC_B;
                await mockA.waitForRequest("GET", "/status", statusCountA);

                await waitForState(
                    harness,
                    deviceState(MAC_A, "info.connection"),
                    state => state.val === false,
                );
                await waitForState(
                    harness,
                    `${INSTANCE}.info.connection`,
                    state => state.val === true,
                );

                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_B, "info.connection"))).val,
                    true,
                    "The device that already owns MAC_B must remain connected.",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_A, "status.operation_key"))).val,
                    "device-a",
                    "The rejected MAC response must not overwrite the old device tree.",
                );
                assert.strictEqual(
                    (await harness.states.getStateAsync(deviceState(MAC_B, "status.operation_key"))).val,
                    "device-b",
                    "The existing MAC_B owner must retain its own API data.",
                );
                assert.ok(
                    harness.hasLog(/MAC address .*already assigned/, "error"),
                    "The duplicate MAC must be reported as an error.",
                );

                await mockA.assertNoRequestAfter(async () => {
                    await harness.states.setStateAsync(deviceState(MAC_A, "control-status.set_temperature"), {
                        val: 23,
                        ack: false,
                    });
                }, "POST", "/set-temperature");

                const writeToB = mockB.waitForRequest("POST", "/set-temperature", mockB.requests.length);
                await harness.states.setStateAsync(deviceState(MAC_B, "control-status.set_temperature"), {
                    val: 24,
                    ack: false,
                });
                assert.deepStrictEqual((await writeToB).body, { type: "Normal", value: 24 });

                const controlStatusCountA = mockA.countRequests("GET", "/control-status");
                const controlStatusCountB = mockB.countRequests("GET", "/control-status");
                await new Promise(resolve => setTimeout(resolve, 2300));
                assert.strictEqual(
                    mockA.countRequests("GET", "/control-status"),
                    controlStatusCountA,
                    "The device that reported a duplicate MAC must stop polling.",
                );
                assert.ok(
                    mockB.countRequests("GET", "/control-status") > controlStatusCountB,
                    "The device that already owns MAC_B must continue polling.",
                );
            });
        });

    },
});