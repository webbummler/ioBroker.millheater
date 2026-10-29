const path = require("path");
const http = require("http");
const assert = require("assert");

const { tests } = require("@iobroker/testing");

/**
 * Waits until all expected ioBroker states exist.
 *
 * The adapter may update states in any order. The test therefore
 * does not depend on the order of API calls or state updates.
 *
 * @param {object} harness ioBroker test harness
 * @param {object} expectedStates States that must exist
 * @param {number} timeout Maximum wait time in milliseconds
 * @returns {Promise<object>} The available ioBroker states
 */
async function waitForStates(harness, expectedStates, timeout = 5000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        const states = {};
        let allAvailable = true;

        for (const id of Object.keys(expectedStates)) {
            const state = await harness.states.getStateAsync(id);

            if (state === null) {
                allAvailable = false;
                break;
            }

            states[id] = state;
        }

        if (allAvailable) {
            return states;
        }

        await new Promise(resolve => setTimeout(resolve, 50));
    }

    const missingStates = [];

    for (const id of Object.keys(expectedStates)) {
        const state = await harness.states.getStateAsync(id);

        if (state === null) {
            missingStates.push(id);
        }
    }

    throw new Error(
        `Timeout waiting for states: ${missingStates.join(", ")}`,
    );
}

/**
 * Waits until one ioBroker state fulfills a condition.
 *
 * @param {object} harness ioBroker test harness
 * @param {string} id State ID
 * @param {(state: object) => boolean} predicate Condition to fulfill
 * @param {number} timeout Maximum wait time in milliseconds
 * @returns {Promise<object>} The matching state
 */
async function waitForState(
    harness,
    id,
    predicate,
    timeout = 5000,
) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        const state = await harness.states.getStateAsync(id);

        if (state !== null && predicate(state)) {
            return state;
        }

        await new Promise(resolve => setTimeout(resolve, 50));
    }

    throw new Error(`Timeout waiting for state: ${id}`);
}

/**
 * Starts the HTTP test server and returns its port.
 *
 * @param {import("http").Server} server HTTP test server
 * @returns {Promise<number>} Server port
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

            if (address === null || typeof address === "string") {
                reject(
                    new Error(
                        "Could not determine the test server port",
                    ),
                );
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
 * Closes the HTTP test server.
 *
 * @param {import("http").Server} server HTTP test server
 * @returns {Promise<void>} Resolves after the server has closed
 */
async function closeTestServer(server) {
    if (!server.listening) {
        return;
    }

    await new Promise(resolve => {
        server.close(resolve);
    });
}

/**
 * Checks whether a value is a request body object.
 *
 * @param {unknown} value Value to check
 * @returns {value is Record<string, unknown>} True if value is an object
 */
function isRequestBody(value) {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value);
}

/**
 * Creates a tracked HTTP mock server.
 *
 * Requests are stored so tests can wait for and inspect real
 * HTTP requests made by the running adapter.
 *
 * A handler may return:
 * - body: object -> JSON response
 * - rawBody: string -> response body sent unchanged
 * - body undefined and no rawBody -> empty response
 * - delayMs: number -> response is delayed by the given milliseconds
 *
 * @param {(request: {
 *     method: string,
 *     path: string,
 *     body: unknown,
 *     rawBody: string
 * }) => {
 *     statusCode?: number,
 *     body?: unknown,
 *     rawBody?: string,
 *     delayMs?: number
 * }} handler HTTP response handler
 * @returns {{
 *     server: import("http").Server,
 *     requests: Array<object>,
 *     waitForRequest: function,
 *     countRequests: function,
 *     assertNoRequestAfter: function
 * }}
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

            requests.push(record);

            for (let i = waiters.length - 1; i >= 0; i--) {
                const waiter = waiters[i];

                if (
                    requests.length - 1 >= waiter.afterRequestCount &&
                    record.method === waiter.method &&
                    record.path === waiter.path
                ) {
                    clearTimeout(waiter.timeout);
                    waiters.splice(i, 1);
                    waiter.resolve(record);
                    break;
                }
            }

            const result = handler(record);

            const sendResponse = () => {
                if (response.destroyed) {
                    return;
                }

                response.statusCode = result.statusCode ?? 200;
                response.setHeader(
                    "Content-Type",
                    "application/json",
                );

                if (result.rawBody !== undefined) {
                    response.end(result.rawBody);
                    return;
                }

                if (result.body === undefined) {
                    response.end();
                    return;
                }

                response.end(JSON.stringify(result.body));
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

        waitForRequest(
            method,
            path,
            afterRequestCount = requests.length,
            timeout = 5000,
        ) {
            const existingRequest = requests
                .slice(afterRequestCount)
                .find(
                    request =>
                        request.method === method &&
                        request.path === path,
                );

            if (existingRequest) {
                return Promise.resolve(existingRequest);
            }

            return new Promise((resolve, reject) => {
                const waiter = {
                    method,
                    path,
                    afterRequestCount,
                    resolve,
                    timeout: setTimeout(() => {
                        const index = waiters.indexOf(waiter);

                        if (index !== -1) {
                            waiters.splice(index, 1);
                        }

                        reject(
                            new Error(
                                `Timeout waiting for ${method} ${path}`,
                            ),
                        );
                    }, timeout),
                };

                waiters.push(waiter);
            });
        },

        countRequests(method, path) {
            return requests.filter(
                request =>
                    request.method === method &&
                    request.path === path,
            ).length;
        },

        async assertNoRequestAfter(
            action,
            method,
            path,
            timeout = 300,
        ) {
            const requestCount = requests.length;

            await action();

            await new Promise(resolve =>
                setTimeout(resolve, timeout),
            );

            const unexpectedRequest = requests
                .slice(requestCount)
                .find(
                    request =>
                        request.method === method &&
                        request.path === path,
                );

            assert.strictEqual(
                unexpectedRequest,
                undefined,
                `Unexpected request ${method} ${path}`,
            );
        },
    };
}

/**
 * Changes the adapter configuration to use the given test server.
 *
 * @param {object} harness ioBroker test harness
 * @param {number} port Test server port
 * @param {number} apiTimeout HTTP timeout in seconds
 * @param {number} pollInterval1 First polling interval in seconds
 * @param {number} pollInterval2 Second polling interval in seconds
 * @returns {Promise<void>} Resolves after configuration was changed
 */
async function configureHarness(
    harness,
    port,
    apiTimeout = 5,
    pollInterval1 = 60,
    pollInterval2 = 120,
) {
    await harness.changeAdapterConfig("millheater", {
        native: {
            host: `127.0.0.1:${port}`,
            apiTimeout,
            pollInterval1,
            pollInterval2,
        },
    });
}

/**
 * Logs the beginning of a suite clearly in the test output.
 *
 * @param {string} name Suite name
 */
function logSuiteStart(name) {
    console.log(`\n========== SUITE: ${name} ==========`);
}

/**
 * Logs the beginning of a test clearly in the test output.
 *
 * @param {string} name Test name
 */
function logTestStart(name) {
    console.log(`---------- TEST: ${name} ----------`);
}

function createStatusResponse(name, customName) {
    return {
        body: {
            status: "ok",
            name,
            custom_name: customName,
            version: "1.2.3",
            operation_key: "test-operation",
            mac_address: "00:11:22:33:44:55",
        },
    };
}

function createCalibrationResponse(value) {
    return {
        body: {
            status: "ok",
            value,
        },
    };
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

tests.integration(path.join(__dirname, ".."), {
    /*
     * Test 1:
     * The adapter must terminate because the IP address is missing.
     */
    allowedExitCodes: [2],

    defineAdditionalTests: ({ suite }) => {
        /**
         * Test 2:
         * Read all API data that is independent of the heater type.
         *
         * A generic heater name is used deliberately. Panel/Oil-specific
         * API calls are tested only in their dedicated suites.
         */
        suite(
            "02 - Mill Heater API data",
            getHarness => {
                let server;

                before(async function () {
                    this.timeout(10000);

                    logSuiteStart("02 - Mill Heater API data");

                    const harness = getHarness();

                    const mock = createTrackedServer(request => {
                        switch (request.path) {
                            case "/status":
                                return createStatusResponse(
                                    "generic",
                                    "Generic Test Heater",
                                );

                            case "/temperature-calibration-offset":
                                return createCalibrationResponse(2);

                            case "/control-status":
                                return createControlStatusResponse();

                            default:
                                return {
                                    statusCode: 404,
                                    body: {
                                        status: "error",
                                    },
                                };
                        }
                    });

                    server = mock.server;

                    const port =
                        await startTestServer(server);

                    await configureHarness(
                        harness,
                        port,
                    );

                    await harness.startAdapterAndWait();
                });

                after(async () => {
                    if (server) {
                        await closeTestServer(server);
                    }
                });

                it(
                    "reads all type-independent data from the Mill API",
                    async function () {
                        this.timeout(10000);

                        logTestStart(
                            "reads all type-independent data",
                        );

                        const harness = getHarness();

                        const expectedStates = {
                            "millheater.0.status.name":
                                "generic",
                            "millheater.0.status.custom_name":
                                "Generic Test Heater",
                            "millheater.0.status.version":
                                "1.2.3",
                            "millheater.0.status.operation_key":
                                "test-operation",
                            "millheater.0.status.mac_address":
                                "00:11:22:33:44:55",

                            "millheater.0.control-status.ambient_temperature":
                                21.5,
                            "millheater.0.control-status.connected_to_cloud":
                                true,
                            "millheater.0.control-status.control_signal":
                                50,
                            "millheater.0.control-status.current_power":
                                750,
                            "millheater.0.control-status.lock_active":
                                "No lock",
                            "millheater.0.control-status.open_window_active_now":
                                "Disabled not active now",
                            "millheater.0.control-status.operation_mode":
                                "Control individually",
                            "millheater.0.control-status.raw_ambient_temperature":
                                21.3,
                            "millheater.0.control-status.set_temperature":
                                22,
                            "millheater.0.control-status.switched_on":
                                true,

                            "millheater.0.settings.temperature_calibration_offset":
                                2,
                        };

                        const states = await waitForStates(
                            harness,
                            expectedStates,
                        );

                        for (const [
                            id,
                            expectedValue,
                        ] of Object.entries(expectedStates)) {
                            assert.strictEqual(
                                states[id].val,
                                expectedValue,
                                `Unexpected value for ${id}`,
                            );
                        }
                    },
                );
            },
        );

        /**
         * Test 3:
         * Verify that invalid API responses do not overwrite an
         * already valid state and that the adapter continues working.
         *
         * Polling is used deliberately so this suite is completely
         * independent of all adapter write operations.
         */
        suite(
            "03 - Mill Heater API response handling",
            getHarness => {
                let server;
                let responseMode = "valid";
                let validCurrentPower = 750;
                let mock;

                const apiTimeout = 1;
                const timeoutResponseDelay = 1500;

                before(async function () {
                    this.timeout(10000);

                    logSuiteStart(
                        "03 - Mill Heater API response handling",
                    );

                    const harness = getHarness();

                    mock = createTrackedServer(
                        request => {
                            switch (request.path) {
                                case "/status":
                                    return createStatusResponse(
                                        "generic",
                                        "Generic Test Heater",
                                    );

                                case "/temperature-calibration-offset":
                                    return createCalibrationResponse(
                                        2,
                                    );

                                case "/control-status":
                                    switch (responseMode) {
                                        case "invalid-json":
                                            return {
                                                rawBody:
                                                    "{invalid json",
                                            };

                                        case "empty":
                                            return {
                                                rawBody: "",
                                            };

                                        case "api-error":
                                            return {
                                                body: {
                                                    status: "error",
                                                },
                                            };

                                        case "http-error":
                                            return {
                                                statusCode: 500,
                                                body: {
                                                    status: "error",
                                                },
                                            };
                                        case "timeout":
                                            return {
                                                delayMs: timeoutResponseDelay,
                                                body: createControlStatusResponse({
                                                    current_power: validCurrentPower,
                                                }).body,
                                            };
                                        case "valid":
                                        default:
                                            return createControlStatusResponse(
                                                {
                                                    current_power:
                                                        validCurrentPower,
                                                },
                                            );
                                    }

                                default:
                                    return {
                                        statusCode: 404,
                                        body: {
                                            status: "error",
                                        },
                                    };
                            }
                        },
                    );

                    server = mock.server;

                    const port =
                        await startTestServer(server);

                    await configureHarness(
                        harness,
                        port,
                        apiTimeout,
                        apiTimeout + 1,
                        60,
                    );

                    await harness.startAdapterAndWait();

                    await waitForStates(harness, {
                        "millheater.0.control-status.current_power":
                            750,
                    });
                });

                after(async () => {
                    if (server) {
                        await closeTestServer(server);
                    }
                });

                it(
                    "keeps the last valid state after invalid API responses",
                    async function () {
                        this.timeout(20000);

                        logTestStart(
                            "keeps the last valid state after invalid responses",
                        );

                        const harness = getHarness();

                        const stateId =
                            "millheater.0.control-status.current_power";

                        assert.ok(
                            mock.countRequests(
                                "GET",
                                "/control-status",
                            ) > 0,
                            "The initial /control-status request was not received",
                        );

                        const invalidResponses = [
                            "invalid-json",
                            "empty",
                            "api-error",
                            "http-error",
                        ];

                        for (const mode of invalidResponses) {
                            responseMode = mode;

                            const requestCount = mock.requests.length;

                            const requestPromise =
                                mock.waitForRequest(
                                    "GET",
                                    "/control-status",
                                    requestCount,
                                );

                            await requestPromise;

                            /*
                             * Give the adapter time to finish processing
                             * the HTTP response in its own process.
                             */
                            await new Promise(resolve =>
                                setTimeout(resolve, 100),
                            );

                            const state =
                                await harness.states.getStateAsync(
                                    stateId,
                                );

                            assert.notStrictEqual(
                                state,
                                null,
                                `State disappeared after ${mode}`,
                            );

                            assert.strictEqual(
                                state.val,
                                750,
                                `State was changed after ${mode}`,
                            );

                            assert.strictEqual(
                                state.ack,
                                true,
                                `State was not acknowledged after ${mode}`,
                            );

                            const aliveState =
                                await harness.states.getStateAsync(
                                    "system.adapter.millheater.0.alive",
                                );

                            assert.notStrictEqual(
                                aliveState,
                                null,
                                "Alive state disappeared after API timeout",
                            );

                            assert.strictEqual(
                                aliveState.val,
                                true,
                                `Adapter did not survive ${mode}`,
                            );
                        }

                        /*
                         * Finally restore a valid response and return
                         * a different value. This proves that the
                         * adapter continues processing API responses.
                         */
                        responseMode = "valid";
                        validCurrentPower = 800;

                        const requestCount = mock.requests.length;

                        const requestPromise =
                            mock.waitForRequest(
                                "GET",
                                "/control-status",
                                requestCount,
                            );

                        await requestPromise;

                        await waitForState(
                            harness,
                            stateId,
                            state => state.val === 800,
                        );
                    },
                );
                it(
                    "keeps the last valid state after an API timeout",
                    async function () {
                        this.timeout(15000);

                        logTestStart(
                            "keeps the last valid state after an API timeout",
                        );

                        const harness = getHarness();

                        const stateId =
                            "millheater.0.control-status.current_power";

                        /*
                        * First restore a known valid state.
                        */
                        validCurrentPower = 750;
                        responseMode = "valid";

                        const initialRequestCount = mock.requests.length;

                        const initialRequestPromise =
                            mock.waitForRequest(
                                "GET",
                                "/control-status",
                                initialRequestCount,
                            );

                        await initialRequestPromise;

                        await waitForState(
                            harness,
                            stateId,
                            state =>
                                state.val === 750 &&
                                state.ack === true,
                        );

                        /*
                        * Use a different value for the delayed response.
                        * If the adapter processed the response after the timeout,
                        * the state would incorrectly change to 900.
                        */
                        validCurrentPower = 900;
                        responseMode = "timeout";

                        const requestCount = mock.requests.length;

                        const requestPromise =
                            mock.waitForRequest(
                                "GET",
                                "/control-status",
                                requestCount,
                            );

                        await requestPromise;

                        /*
                        * The adapter timeout is 1000 ms.
                        * The mock response arrives after 1500 ms.
                        *
                        * Waiting 1700 ms ensures that the delayed response
                        * would already have arrived if the adapter had not timed out.
                        */
                        await new Promise(resolve =>
                            setTimeout(resolve, timeoutResponseDelay + 200),
                        );

                        const state =
                            await harness.states.getStateAsync(stateId);

                        assert.notStrictEqual(
                            state,
                            null,
                            "State disappeared after API timeout",
                        );
                        assert.strictEqual(
                            state.val,
                            750,
                            "State was changed after timeout",
                        );

                        assert.strictEqual(
                            state.ack,
                            true,
                            "State was not acknowledged after timeout",
                        );

                        const aliveState =
                            await harness.states.getStateAsync(
                                "system.adapter.millheater.0.alive",
                            );

                        assert.notStrictEqual(
                            aliveState,
                            null,
                            "Alive state disappeared after API timeout",
                        );

                        assert.strictEqual(
                            aliveState.val,
                            true,
                            "Adapter did not survive timeout",
                        );

                        /*
                        * Restore valid responses and verify that the adapter
                        * continues processing API responses afterwards.
                        */
                        responseMode = "valid";
                        validCurrentPower = 800;

                        const nextRequestCount = mock.requests.length;

                        const nextRequestPromise =
                            mock.waitForRequest(
                                "GET",
                                "/control-status",
                                nextRequestCount,
                            );

                        await nextRequestPromise;

                        await waitForState(
                            harness,
                            stateId,
                            state =>
                                state.val === 800 &&
                                state.ack === true,
                        );
                    },
                );
            },
        );

        /**
         * Test 4:
         * Verify all write operations that are independent of
         * the heater type.
         */
        suite(
            "04 - Type-independent write operations",
            getHarness => {
                let server;
                let mock;
                let deviceTemperature = 22;
                let deviceOperationMode =
                    "Control individually";
                let deviceCalibrationOffset = 2;

                before(async function () {
                    this.timeout(10000);

                    logSuiteStart(
                        "04 - Type-independent write operations",
                    );

                    const harness = getHarness();

                    mock = createTrackedServer(
                        request => {
                            switch (request.path) {
                                case "/status":
                                    return createStatusResponse(
                                        "generic",
                                        "Generic Test Heater",
                                    );

                                case "/control-status":
                                    return createControlStatusResponse(
                                        {
                                            operation_mode:
                                                deviceOperationMode,
                                            set_temperature:
                                                deviceTemperature,
                                        },
                                    );

                                case "/set-temperature": {
                                    if (isRequestBody(request.body)) {
                                        const body = request.body;

                                        if (typeof body.value === "number") {
                                            deviceTemperature = body.value;
                                        }
                                    }
                                    return {
                                        body: {
                                            status: "ok",
                                        },
                                    };
                                }

                                case "/operation-mode": {
                                    if (isRequestBody(request.body)) {
                                        const body = request.body;

                                        if (typeof body.mode === "string") {
                                            deviceOperationMode = body.mode;
                                        }
                                    }
                                    return {
                                        body: {
                                            status: "ok",
                                        },
                                    };
                                }

                                case "/temperature-calibration-offset":
                                    if (request.method === "POST") {
                                        if (isRequestBody(request.body)) {
                                        const body = request.body;

                                        if (typeof body.value === "number") {
                                            deviceCalibrationOffset = body.value;
                                        }
                                    }
                                    return {
                                        body: {
                                            status: "ok",
                                        },
                                    };
                                }

                                    return createCalibrationResponse(
                                        deviceCalibrationOffset,
                                    );

                                default:
                                    return {
                                        statusCode: 404,
                                        body: {
                                            status: "error",
                                        },
                                    };
                            }
                        },
                    );

                    server = mock.server;

                    const port =
                        await startTestServer(server);

                    await configureHarness(
                        harness,
                        port,
                    );

                    await harness.startAdapterAndWait();

                    await waitForStates(harness, {
                        "millheater.0.control-status.set_temperature":
                            22,
                        "millheater.0.control-status.operation_mode":
                            "Control individually",
                        "millheater.0.settings.temperature_calibration_offset":
                            2,
                    });
                });

                after(async () => {
                    if (server) {
                        await closeTestServer(server);
                    }
                });

                it(
                    "writes all type-independent settings",
                    async function () {
                        this.timeout(30000);

                        logTestStart(
                            "writes temperature, operation mode and calibration offset",
                        );

                        const harness = getHarness();

                        /*
                         * -------------------------------------------------
                         * setTemperature
                         * -------------------------------------------------
                         */
                        for (const value of [5, 35]) {
                            const requestCount =
                                mock.countRequests(
                                    "POST",
                                    "/set-temperature",
                                );

                            const requestPromise =
                                mock.waitForRequest(
                                    "POST",
                                    "/set-temperature",
                                    mock.requests.length,
                                );

                            await harness.states.setStateAsync(
                                "millheater.0.control-status.set_temperature",
                                {
                                    val: value,
                                    ack: false,
                                },
                            );

                            const request =
                                await requestPromise;

                            const body =
                                /** @type {Record<string, unknown>} */ (
                                    request.body
                                );

                            assert.deepStrictEqual(
                                body,
                                {
                                    type: "Normal",
                                    value,
                                },
                            );

                            assert.strictEqual(
                                mock.countRequests(
                                    "POST",
                                    "/set-temperature",
                                ),
                                requestCount + 1,
                            );

                            await waitForState(
                                harness,
                                "millheater.0.control-status.set_temperature",
                                state =>
                                    state.val === value &&
                                    state.ack === true,
                            );
                        }

                        for (const value of [4, 36]) {
                            await mock.assertNoRequestAfter(
                                async () => {
                                    await harness.states.setStateAsync(
                                        "millheater.0.control-status.set_temperature",
                                        {
                                            val: value,
                                            ack: false,
                                        },
                                    );
                                },
                                "POST",
                                "/set-temperature",
                            );
                        }

                        /*
                         * -------------------------------------------------
                         * setOperationMode
                         * -------------------------------------------------
                         */
                        const operationModes = [
                            "Off",
                            "Weekly program",
                            "Independent device",
                            "Control individually",
                        ];

                        for (const mode of operationModes) {
                            const requestPromise =
                                mock.waitForRequest(
                                    "POST",
                                    "/operation-mode",
                                    mock.requests.length,
                                );

                            await harness.states.setStateAsync(
                                "millheater.0.control-status.operation_mode",
                                {
                                    val: mode,
                                    ack: false,
                                },
                            );

                            const request =
                                await requestPromise;

                            const body =
                                /** @type {Record<string, unknown>} */ (
                                    request.body
                                );

                            assert.deepStrictEqual(
                                body,
                                {
                                    mode,
                                },
                            );

                            await waitForState(
                                harness,
                                "millheater.0.control-status.operation_mode",
                                state =>
                                    state.val === mode &&
                                    state.ack === true,
                            );
                        }

                        await mock.assertNoRequestAfter(
                            async () => {
                                await harness.states.setStateAsync(
                                    "millheater.0.control-status.operation_mode",
                                    {
                                        val: "Invalid",
                                        ack: false,
                                    },
                                );
                            },
                            "POST",
                            "/operation-mode",
                        );

                        /*
                         * -------------------------------------------------
                         * setTemperatureCalibrationOffset
                         * -------------------------------------------------
                         */
                        for (const value of [-30, 30]) {
                            const requestPromise =
                                mock.waitForRequest(
                                    "POST",
                                    "/temperature-calibration-offset",
                                    mock.requests.length,
                                );

                            await harness.states.setStateAsync(
                                "millheater.0.settings.temperature_calibration_offset",
                                {
                                    val: value,
                                    ack: false,
                                },
                            );

                            const request =
                                await requestPromise;

                            const body =
                                /** @type {Record<string, unknown>} */ (
                                    request.body
                                );

                            assert.deepStrictEqual(
                                body,
                                {
                                    value,
                                },
                            );

                            await waitForState(
                                harness,
                                "millheater.0.settings.temperature_calibration_offset",
                                state =>
                                    state.val === value &&
                                    state.ack === true,
                            );
                        }

                        for (const value of [-31, 31]) {
                            await mock.assertNoRequestAfter(
                                async () => {
                                    await harness.states.setStateAsync(
                                        "millheater.0.settings.temperature_calibration_offset",
                                        {
                                            val: value,
                                            ack: false,
                                        },
                                    );
                                },
                                "POST",
                                "/temperature-calibration-offset",
                            );
                        }
                    },
                );
            },
        );

        /**
         * Test 5:
         * Verify all panel-heater-specific operations.
         */
        suite(
            "05 - Panel Heater",
            getHarness => {
                let server;
                let mock;
                let deviceLimitedHeatingPower = 100;

                before(async function () {
                    this.timeout(10000);

                    logSuiteStart("05 - Panel Heater");

                    const harness = getHarness();

                    mock = createTrackedServer(
                        request => {
                            switch (request.path) {
                                case "/status":
                                    return createStatusResponse(
                                        "panel",
                                        "Panel Test Heater",
                                    );

                                case "/temperature-calibration-offset":
                                    return createCalibrationResponse(
                                        2,
                                    );

                                case "/control-status":
                                    return createControlStatusResponse();

                                case "/limited-heating-power":
                                    if (request.method === "POST") {
                                        if (isRequestBody(request.body)) {
                                            const body = request.body;

                                            if (typeof body.limited_heating_power === "number") {
                                                deviceLimitedHeatingPower =
                                                    body.limited_heating_power;
                                            }
                                        }

                                        return {
                                            body: {
                                                status: "ok",
                                            },
                                        };
                                    }

                                    return {
                                        body: {
                                            status: "ok",
                                            limited_heating_power: deviceLimitedHeatingPower,
                                        },
                                    };

                                case "/oil-heater-power":
                                    return createCalibrationResponse(
                                        40,
                                    );

                                default:
                                    return {
                                        statusCode: 404,
                                        body: {
                                            status: "error",
                                        },
                                    };
                            }
                        },
                    );

                    server = mock.server;

                    const port =
                        await startTestServer(server);

                    await configureHarness(
                        harness,
                        port,
                    );

                    await harness.startAdapterAndWait();

                    await waitForState(
                        harness,
                        "millheater.0.status.name",
                        state => state.val === "panel",
                    );

                    await waitForState(
                        harness,
                        "millheater.0.settings.limited_heating_power",
                        state =>
                            state.val === 100 &&
                            state.ack === true,
                    );
                });

                after(async () => {
                    if (server) {
                        await closeTestServer(server);
                    }
                });

                it(
                    "reads and writes limited heating power",
                    async function () {
                        this.timeout(20000);

                        logTestStart(
                            "reads and writes limited heating power",
                        );

                        const harness = getHarness();

                        assert.ok(
                            server,
                            "Test server was not initialized",
                        );

                        const limitedHeatingPowerReads =
                            [...mock.requests].filter(
                                request =>
                                    request.method === "GET" &&
                                    request.path ===
                                        "/limited-heating-power",
                            );

                        assert.ok(
                            limitedHeatingPowerReads.length > 0,
                            "Panel heater must read limited-heating-power",
                        );

                        assert.strictEqual(
                            mock.countRequests(
                                "GET",
                                "/oil-heater-power",
                            ),
                            0,
                            "Panel heater must not read oil-heater-power",
                        );

                        for (const value of [10, 100]) {
                            const requestPromise =
                                mock.waitForRequest(
                                    "POST",
                                    "/limited-heating-power",
                                    mock.requests.length,
                                );

                            await harness.states.setStateAsync(
                                "millheater.0.settings.limited_heating_power",
                                {
                                    val: value,
                                    ack: false,
                                },
                            );

                            const request =
                                await requestPromise;

                            const body =
                                /** @type {Record<string, unknown>} */ (
                                    request.body
                                );

                            assert.deepStrictEqual(
                                body,
                                {
                                    limited_heating_power:
                                        value,
                                },
                            );

                            await waitForState(
                                harness,
                                "millheater.0.settings.limited_heating_power",
                                state =>
                                    state.val === value &&
                                    state.ack === true,
                            );
                        }

                        for (const value of [9, 101, 50.5]) {
                            await mock.assertNoRequestAfter(
                                async () => {
                                    await harness.states.setStateAsync(
                                        "millheater.0.settings.limited_heating_power",
                                        {
                                            val: value,
                                            ack: false,
                                        },
                                    );
                                },
                                "POST",
                                "/limited-heating-power",
                            );
                        }

                        await mock.assertNoRequestAfter(
                            async () => {
                                await harness.states.setStateAsync(
                                    "millheater.0.settings.heating_level_percentage",
                                    {
                                        val: 60,
                                        ack: false,
                                    },
                                );
                            },
                            "POST",
                            "/oil-heater-power",
                        );
                    },
                );
            },
        );

        /**
         * Test 6:
         * Verify all oil-heater-specific operations.
         */
        suite(
            "06 - Oil Heater",
            getHarness => {
                let server;
                let mock;
                let deviceHeatingLevelPercentage = 40;

                before(async function () {
                    this.timeout(10000);

                    logSuiteStart("06 - Oil Heater");

                    const harness = getHarness();

                    mock = createTrackedServer(
                        request => {
                            switch (request.path) {
                                case "/status":
                                    return createStatusResponse(
                                        "oil",
                                        "Oil Test Heater",
                                    );

                                case "/temperature-calibration-offset":
                                    return createCalibrationResponse(
                                        2,
                                    );

                                case "/control-status":
                                    return createControlStatusResponse();

                                case "/oil-heater-power":
                                    if (request.method === "POST") {
                                        if (isRequestBody(request.body)) {
                                            const body = request.body;

                                            if (
                                                typeof body.heating_level_percentage === "number"
                                            ) {
                                                deviceHeatingLevelPercentage =
                                                    body.heating_level_percentage;
                                            }
                                        }

                                        return {
                                            body: {
                                                status: "ok",
                                            },
                                        };
                                    }

                                    return createCalibrationResponse(
                                        deviceHeatingLevelPercentage,
                                    );

                                case "/limited-heating-power":
                                    return createCalibrationResponse(
                                        100,
                                    );

                                default:
                                    return {
                                        statusCode: 404,
                                        body: {
                                            status: "error",
                                        },
                                    };
                            }
                        },
                    );

                    server = mock.server;

                    const port =
                        await startTestServer(server);

                    await configureHarness(
                        harness,
                        port,
                    );

                    await harness.startAdapterAndWait();

                    await waitForState(
                        harness,
                        "millheater.0.status.name",
                        state => state.val === "oil",
                    );

                    await waitForState(
                        harness,
                        "millheater.0.settings.heating_level_percentage",
                        state =>
                            state.val === 40 &&
                            state.ack === true,
                    );
                });

                after(async () => {
                    if (server) {
                        await closeTestServer(server);
                    }
                });

                it(
                    "reads and writes heating level percentage",
                    async function () {
                        this.timeout(20000);

                        logTestStart(
                            "reads and writes heating level percentage",
                        );

                        const harness = getHarness();

                        assert.ok(
                            server,
                            "Test server was not initialized",
                        );

                        const heatingLevelReads =
                            [...mock.requests].filter(
                                request =>
                                    request.method === "GET" &&
                                    request.path ===
                                        "/oil-heater-power",
                            );

                        assert.ok(
                            heatingLevelReads.length > 0,
                            "Oil heater must read oil-heater-power",
                        );

                        assert.strictEqual(
                            mock.countRequests(
                                "GET",
                                "/limited-heating-power",
                            ),
                            0,
                            "Oil heater must not read limited-heating-power",
                        );

                        for (const value of [40, 60, 100]) {
                            const requestPromise =
                                mock.waitForRequest(
                                    "POST",
                                    "/oil-heater-power",
                                    mock.requests.length,
                                );

                            await harness.states.setStateAsync(
                                "millheater.0.settings.heating_level_percentage",
                                {
                                    val: value,
                                    ack: false,
                                },
                            );

                            const request =
                                await requestPromise;

                            const body =
                                /** @type {Record<string, unknown>} */ (
                                    request.body
                                );

                            assert.deepStrictEqual(
                                body,
                                {
                                    heating_level_percentage:
                                        value,
                                },
                            );

                            await waitForState(
                                harness,
                                "millheater.0.settings.heating_level_percentage",
                                state =>
                                    state.val === value &&
                                    state.ack === true,
                            );
                        }

                        for (const value of [50, 101]) {
                            await mock.assertNoRequestAfter(
                                async () => {
                                    await harness.states.setStateAsync(
                                        "millheater.0.settings.heating_level_percentage",
                                        {
                                            val: value,
                                            ack: false,
                                        },
                                    );
                                },
                                "POST",
                                "/oil-heater-power",
                            );
                        }

                        await mock.assertNoRequestAfter(
                            async () => {
                                await harness.states.setStateAsync(
                                    "millheater.0.settings.limited_heating_power",
                                    {
                                        val: 80,
                                        ack: false,
                                    },
                                );
                            },
                            "POST",
                            "/limited-heating-power",
                        );
                    },
                );
            },
        );
        /**
         * Test 7:
         * API request synchronization.
         */
        suite(
            "07 - API request synchronization",
            getHarness => {
                let server;
                let mock;
                let responseMode = "valid";
                let validCurrentPower = 750;
                const pollDelay = 1500;

                before(async function () {
                    this.timeout(10000);

                    logSuiteStart("07 - API request synchronization");

                    const harness = getHarness();

                    mock = createTrackedServer(
                        request => {
                            switch (request.path) {
                                case "/status":
                                    return createStatusResponse(
                                        "generic",
                                        "Generic Test Heater",
                                    );

                                case "/temperature-calibration-offset":
                                    return createCalibrationResponse(2);

                                case "/control-status":
                                    if (responseMode === "slow") {
                                        return {
                                            delayMs: pollDelay,
                                            body: createControlStatusResponse({
                                                current_power:
                                                    validCurrentPower,
                                            }).body,
                                        };
                                    }

                                    return createControlStatusResponse({
                                        current_power:
                                            validCurrentPower,
                                    });

                                case "/set-temperature":
                                    return {
                                        body: {
                                            status: "ok",
                                        },
                                    };

                                default:
                                    return {
                                        statusCode: 404,
                                        body: {
                                            status: "error",
                                        },
                                    };
                            }
                        },
                    );

                    server = mock.server;

                    const port =
                        await startTestServer(server);

                    await configureHarness(
                        harness,
                        port,
                        2,
                        3,
                        60,
                    );

                    await harness.startAdapterAndWait();

                    await waitForStates(harness, {
                        "millheater.0.control-status.current_power":
                            750,
                        "millheater.0.control-status.set_temperature":
                            22,
                    });
                });

                after(async () => {
                    if (server) {
                        await closeTestServer(server);
                    }
                });

                it(
                    "waits for a running poll before sending a write request",
                    async function () {
                        this.timeout(10000);

                        logTestStart(
                            "waits for a running poll before sending a write request",
                        );

                        const harness = getHarness();

                        responseMode = "slow";

                        const pollRequestCount =
                            mock.requests.length;

                        const pollRequestPromise =
                            mock.waitForRequest(
                                "GET",
                                "/control-status",
                                pollRequestCount,
                            );

                        await pollRequestPromise;

                        const pollStartedAt = Date.now();

                        const writeRequestPromise =
                            mock.waitForRequest(
                                "POST",
                                "/set-temperature",
                                mock.requests.length,
                            );

                        await harness.states.setStateAsync(
                            "millheater.0.control-status.set_temperature",
                            {
                                val: 23,
                                ack: false,
                            },
                        );

                        /*
                        * The poll is still running. The write request must
                        * therefore not reach the Mill heater yet.
                        */
                        await new Promise(resolve =>
                            setTimeout(resolve, 300),
                        );

                        assert.strictEqual(
                            mock.countRequests(
                                "POST",
                                "/set-temperature",
                            ),
                            0,
                            "Write request was sent while another API request was running",
                        );

                        responseMode = "valid";

                        const writeRequest =
                            await writeRequestPromise;

                        assert.ok(
                            mock.requests.indexOf(writeRequest) >= 0,
                        );

                        const writeDelay =
                            Date.now() - pollStartedAt;

                        assert.ok(
                            writeDelay >= pollDelay - 300,
                            `Write request started too early: ${writeDelay} ms`,
                        );
                    },
                );
            },
        ),

            suite(
                "08 - API request priority",
                getHarness => {
                    let server;
                    let mock;

                    before(async function () {
                        this.timeout(10000);

                        logSuiteStart("08 - API request priority");

                        const harness = getHarness();

                        mock = createTrackedServer(
                            request => {
                                switch (request.path) {
                                    case "/status":
                                        return createStatusResponse(
                                            "generic",
                                            "Generic Test Heater",
                                        );

                                    case "/temperature-calibration-offset":
                                        return createCalibrationResponse(2);

                                    case "/control-status":
                                        return createControlStatusResponse();

                                    case "/set-temperature":
                                        return {
                                            delayMs: 7000,
                                            body: {
                                                status: "ok",
                                            },
                                        };

                                    default:
                                        return {
                                            statusCode: 404,
                                            body: {
                                                status: "error",
                                            },
                                        };
                                }
                            },
                        );

                        server = mock.server;

                        const port =
                            await startTestServer(server);

                        await configureHarness(
                            harness,
                            port,
                            5,
                            6,
                            60,
                        );

                        await harness.startAdapterAndWait();

                        await waitForStates(harness, {
                            "millheater.0.control-status.set_temperature":
                                22,
                        });
                    });

                    after(async () => {
                        if (server) {
                            await closeTestServer(server);
                        }
                    });

                    it(
                        "skips polling while a write request is running",
                        async function () {
                            this.timeout(15000);

                            logTestStart(
                                "skips polling while a write request is running",
                            );

                            const harness = getHarness();

                            /*
                            * Wait for the initial Fast poll.
                            * The next Fast poll is scheduled 6 seconds after startup.
                            */
                            const initialRequestCount =
                                mock.requests.length;

                            const initialPollPromise =
                                mock.waitForRequest(
                                    "GET",
                                    "/control-status",
                                    initialRequestCount,
                                    8000,
                                );

                            await initialPollPromise;

                            /*
                            * Start the write 2 seconds after the initial poll.
                            * The next Fast poll will therefore occur about 4 seconds
                            * after the write has started.
                            */
                            await new Promise(resolve =>
                                setTimeout(resolve, 2000),
                            );

                            const controlStatusCount =
                                mock.countRequests(
                                    "GET",
                                    "/control-status",
                                );

                            const writeRequestPromise =
                                mock.waitForRequest(
                                    "POST",
                                    "/set-temperature",
                                    mock.requests.length,
                                );

                            await harness.states.setStateAsync(
                                "millheater.0.control-status.set_temperature",
                                {
                                    val: 23,
                                    ack: false,
                                },
                            );

                            await writeRequestPromise;

                            /*
                            * The write is still running.
                            * The next Fast poll should occur after about 4 seconds,
                            * but must be skipped because the API mutex is occupied.
                            */
                            await new Promise(resolve =>
                                setTimeout(resolve, 4500),
                            );

                            assert.strictEqual(
                                mock.countRequests(
                                    "GET",
                                    "/control-status",
                                ),
                                controlStatusCount,
                                "Fast poll was sent while a write request was running",
                            );

                            /*
                            * The write request has a 7-second response delay,
                            * so the adapter timeout occurs after 5 seconds.
                            */
                            await new Promise(resolve =>
                                setTimeout(resolve, 1000),
                            );

                            assert.strictEqual(
                                mock.countRequests(
                                    "POST",
                                    "/set-temperature",
                                ),
                                1,
                                "Expected exactly one write request",
                            );
                        },
                    );
                },
            );

            suite(
            "09 - API shutdown",
            getHarness => {
                let server;
                let mock;

                before(async function () {
                    this.timeout(10000);

                    logSuiteStart("09 - API shutdown");

                    const harness = getHarness();

                    mock = createTrackedServer(
                        request => {
                            switch (request.path) {
                                case "/status":
                                    return createStatusResponse(
                                        "generic",
                                        "Generic Test Heater",
                                    );

                                case "/temperature-calibration-offset":
                                    return createCalibrationResponse(2);

                                case "/control-status":
                                    return {
                                        delayMs: 1500,
                                        body:
                                            createControlStatusResponse({
                                                current_power: 750,
                                            }).body,
                                    };

                                case "/set-temperature":
                                    return {
                                        body: {
                                            status: "ok",
                                        },
                                    };

                                default:
                                    return {
                                        statusCode: 404,
                                        body: {
                                            status: "error",
                                        },
                                    };
                            }
                        },
                    );

                    server = mock.server;

                    const port =
                        await startTestServer(server);

                    await configureHarness(
                        harness,
                        port,
                        2,
                        3,
                        60,
                    );

                    await harness.startAdapterAndWait();

                    await waitForState(
                        harness,
                        "millheater.0.control-status.current_power",
                        state => state.val === 750,
                    );
                });

                after(async () => {
                    if (server) {
                        await closeTestServer(server);
                    }
                });

                it(
                    "cancels waiting API requests during shutdown",
                    async function () {
                        this.timeout(10000);

                        logTestStart(
                            "cancels waiting API requests during shutdown",
                        );

                        const harness = getHarness();

                        const controlStatusCount =
                            mock.countRequests(
                                "GET",
                                "/control-status",
                            );

                        const controlStatusRequestPromise =
                            mock.waitForRequest(
                                "GET",
                                "/control-status",
                                mock.requests.length,
                            );

                        await controlStatusRequestPromise;

                        const postRequestCount =
                            mock.countRequests(
                                "POST",
                                "/set-temperature",
                            );

                        await harness.states.setStateAsync(
                            "millheater.0.control-status.set_temperature",
                            {
                                val: 23,
                                ack: false,
                            },
                        );

                        /*
                        * The POST must be waiting behind the running GET.
                        */
                        await new Promise(resolve =>
                            setTimeout(resolve, 100),
                        );

                        assert.strictEqual(
                            mock.countRequests(
                                "POST",
                                "/set-temperature",
                            ),
                            postRequestCount,
                            "Write request was sent before the running API request finished",
                        );

                        const stopStartedAt = Date.now();

                        await harness.stopAdapter();

                        const stopDuration =
                            Date.now() - stopStartedAt;

                        /*
                        * The running request takes 1500 ms and must be
                        * allowed to finish before the adapter shuts down.
                        */
                        assert.ok(
                            stopDuration >= 1000,
                            `Adapter stopped too early: ${stopDuration} ms`,
                        );

                        /*
                        * The waiting write must have been cancelled and
                        * must therefore never reach the API.
                        */
                        assert.strictEqual(
                            mock.countRequests(
                                "POST",
                                "/set-temperature",
                            ),
                            postRequestCount,
                            "Waiting write request was executed during shutdown",
                        );

                        assert.ok(
                            controlStatusCount <
                                mock.countRequests(
                                    "GET",
                                    "/control-status",
                                ),
                            "Expected the running control-status request",
                        );
                    },
                );
            },
        );
         /**
         * Test 10:
         * Verify all socket-heater-specific operations.
         */
        suite(
            "10 - Socket Heater",
            getHarness => {
                let server;
                let mock;
                let deviceAdditionalMode = 3;

                before(async function () {
                    this.timeout(10000);

                    logSuiteStart("10 - Socket Heater");

                    const harness = getHarness();
                    mock = createTrackedServer(request => {
                        switch (request.path) {
                            case "/status":
                                return createStatusResponse(
                                    "Mill HeaterGen3Socket",
                                    "Socket Test Heater",
                                );

                            case "/temperature-calibration-offset":
                                return createCalibrationResponse(2);

                            case "/control-status":
                                return createControlStatusResponse();

                            case "/additional-socket-mode":
                                if (request.method === "POST") {
                                    if (isRequestBody(request.body)) {
                                        const body = request.body;

                                        if (
                                            typeof body.additional_mode === "number"
                                        ) {
                                            deviceAdditionalMode =
                                                body.additional_mode;
                                        }
                                    }

                                    return {
                                        body: {
                                            status: "ok",
                                        },
                                    };
                                }

                                return {
                                    body: {
                                        status: "ok",
                                        additional_mode: deviceAdditionalMode,
                                    },
                                };

                            default:
                                return {
                                    statusCode: 404,
                                    body: {
                                        status: "error",
                                    },
                                };
                        }
                    });

                    server = mock.server;
                    const port = await startTestServer(server);

                    await configureHarness(harness, port);

                    await harness.startAdapterAndWait();

                    await waitForState(
                        harness,
                        "millheater.0.status.name",
                        state => state.val === "Mill HeaterGen3Socket",
                    );

                    await waitForState(
                        harness,
                        "millheater.0.settings.additional_mode",
                        state =>
                            state.val === 3 &&
                            state.ack === true,
                    );
                });

                after(async () => {
                    if (server) {
                        await closeTestServer(server);
                    }
                });

                it(
                    "reads and writes additional socket mode",
                    async function () {
                        this.timeout(20000);

                        logTestStart(
                            "reads and writes additional socket mode",
                        );

                        const harness = getHarness();

                        assert.ok(
                            server,
                            "Test server was not initialized",
                        );

                        /*
                         * Verify that the socket-specific endpoint is read
                         * and that oil/panel endpoints are not called.
                         */
                        assert.ok(
                            mock.countRequests(
                                "GET",
                                "/additional-socket-mode",
                            ) > 0,
                            "Socket heater must read additional-socket-mode",
                        );

                        assert.strictEqual(
                            mock.countRequests(
                                "GET",
                                "/oil-heater-power",
                            ),
                            0,
                            "Socket heater must not read oil-heater-power",
                        );

                        assert.strictEqual(
                            mock.countRequests(
                                "GET",
                                "/limited-heating-power",
                            ),
                            0,
                            "Socket heater must not read limited-heating-power",
                        );

                        /*
                         * Verify valid additional modes and the POST body.
                         */
                        for (const value of [0, 2, 4]) {
                            const requestPromise =
                                mock.waitForRequest(
                                    "POST",
                                    "/additional-socket-mode",
                                    mock.requests.length,
                                );

                            await harness.states.setStateAsync(
                                "millheater.0.settings.additional_mode",
                                {
                                    val: value,
                                    ack: false,
                                },
                            );

                            const request = await requestPromise;

                            const body =
                                /** @type {Record<string, unknown>} */ (
                                    request.body
                                );

                            assert.deepStrictEqual(
                                body,
                                {
                                    additional_mode: value,
                                },
                            );

                            await waitForState(
                                harness,
                                "millheater.0.settings.additional_mode",
                                state =>
                                    state.val === value &&
                                    state.ack === true,
                            );
                        }

                        /*
                         * Invalid values must not be sent to the API.
                         */
                        for (const value of [-1, 5, 2.5]) {
                            await mock.assertNoRequestAfter(
                                async () => {
                                    await harness.states.setStateAsync(
                                        "millheater.0.settings.additional_mode",
                                        {
                                            val: value,
                                            ack: false,
                                        },
                                    );
                                },
                                "POST",
                                "/additional-socket-mode",
                            );
                        }

                        /*
                         * Socket heaters must not use oil/panel-specific
                         * write endpoints.
                         */
                        await mock.assertNoRequestAfter(
                            async () => {
                                await harness.states.setStateAsync(
                                    "millheater.0.settings.heating_level_percentage",
                                    {
                                        val: 60,
                                        ack: false,
                                    },
                                );
                            },
                            "POST",
                            "/oil-heater-power",
                        );

                        await mock.assertNoRequestAfter(
                            async () => {
                                await harness.states.setStateAsync(
                                    "millheater.0.settings.limited_heating_power",
                                    {
                                        val: 80,
                                        ack: false,
                                    },
                                );
                            },
                            "POST",
                            "/limited-heating-power",
                        );
                    },
                );
            },
        );
    },
});