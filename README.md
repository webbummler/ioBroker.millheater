![Logo](admin/millheater.png)

# ioBroker.millheater

[![NPM version](https://img.shields.io/npm/v/iobroker.millheater.svg)](https://www.npmjs.com/package/iobroker.millheater)
[![Downloads](https://img.shields.io/npm/dm/iobroker.millheater.svg)](https://www.npmjs.com/package/iobroker.millheater)
![Number of Installations](https://iobroker.live/badges/millheater-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/millheater-stable.svg)
[![Test and Release](https://github.com/webbummler/ioBroker.millheater/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/webbummler/ioBroker.millheater/actions/workflows/test-and-release.yml)

## About

The `millheater` adapter integrates Mill heaters into ioBroker using the local API of the heater.

The adapter is designed to integrate Mill heaters into a smart heating control system. This allows the heater to be controlled by external automation systems in ioBroker, for example based on available photovoltaic (PV) surplus power.

For this type of use, the operating mode **`Control individually`** should be selected on the heater. In this mode, the heater follows the individual target temperature without using timers or the weekly program. The target temperature and heater-specific power levels can then be controlled by ioBroker.

This makes it possible, for example, to use available PV surplus power for heating by automatically adjusting the heating level according to the available surplus.

The adapter communicates directly with the heater over the local network. No cloud connection is required for the communication between ioBroker and the heater.

The adapter currently supports:

* Oil heaters
* Panel heaters

Storage heaters are currently not supported.

## Features

* Local communication with the Mill heater
* Automatic polling of heater status
* Reading current temperature and heating power
* Reading and changing the target temperature
* Reading and changing the operating mode
* Reading and changing temperature calibration
* Reading and changing heater-specific power settings
* Immediate acknowledgement of successfully processed write commands
* Automatic verification through the regular polling cycle
* Suitable as a building block for smart heating automation, such as PV surplus control

## Requirements

* ioBroker
* A supported Mill heater with an available local API
* The heater and ioBroker must be reachable within the same network
* Node.js version compatible with the installed ioBroker version

## Installation

### Stable repository

The adapter can be installed through the ioBroker administration interface.

Open:

**Adapters → Available → millheater → Install**

### Manual installation

The adapter can also be installed from npm:

```bash
cd /opt/iobroker
npm install iobroker.millheater
```

After installation, create an instance of the adapter in the ioBroker administration interface.

## Configuration

The adapter requires the IP address of the Mill heater.

### Configuration parameters

| Parameter             | Description                                         | Default |
| --------------------- | --------------------------------------------------- | ------: |
| IP address            | IP address of the Mill heater                       |   empty |
| Fast polling interval | Interval for frequently changing values, in seconds |      30 |
| Slow polling interval | Interval for slowly changing values, in seconds     |   86400 |

The fast polling interval is used for values such as the current temperature, heating power and operating state.

The slow polling interval is used for values that normally change less frequently, such as the temperature calibration offset.

The IP address should preferably be assigned as a fixed DHCP lease or static address so that the adapter can reliably reach the heater.

## Supported heater types

The adapter currently supports:

* **Oil heaters**
* **Panel heaters**

**Storage heaters are currently not supported.**

The adapter determines the heater type from the name reported by the Mill API.

### Oil heaters

Oil heaters support the following additional setting:

`settings.heating_level_percentage`

Allowed values:

* `40 %`
* `60 %`
* `100 %`

These values represent the selected percentage of the heater's maximum power.

This makes the setting particularly useful for smart energy management. For example, an ioBroker automation can select the appropriate heating level based on the currently available PV surplus.

### Panel heaters

Panel heaters support:

`settings.limited_heating_power`

The value can be set between `10 %` and `100 %`.

This setting can also be used by external automation to adapt the available heating power to the current energy situation.

## Operating modes

The `operation_mode` state supports the following values:

| Value                  | Description                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `Off`                  | Heater switched off                                                                 |
| `Weekly program`       | Weekly schedule                                                                     |
| `Independent device`   | Independent device operation                                                        |
| `Control individually` | Follow the individual target temperature without using timers or the weekly program |

For smart external control through ioBroker, **`Control individually`** should be used.

In this mode, the heater follows the individual target temperature but does not use timers or the weekly program. This allows ioBroker to control the heater based on external conditions.

For example, a PV surplus control can use the available surplus power to select an appropriate heating level:

* Low PV surplus → lower heating level
* Higher PV surplus → higher heating level
* No relevant PV surplus → heating level can be reduced again

This allows surplus photovoltaic energy to be used for heating instead of being fed into the grid.

The value `Invalid` may be reported by the API but is not sent to the heater as a write command.

## Data points

The adapter creates the following object structure:

```text
millheater.0
├── status
│   ├── name
│   ├── custom_name
│   ├── version
│   ├── operation_key
│   └── mac_address
│
├── control-status
│   ├── ambient_temperature
│   ├── connected_to_cloud
│   ├── control_signal
│   ├── current_power
│   ├── lock_active
│   ├── open_window_active_now
│   ├── operation_mode
│   ├── raw_ambient_temperature
│   ├── set_temperature
│   └── switched_on
│
└── settings
    ├── heating_level_percentage
    ├── limited_heating_power
    └── temperature_calibration_offset
```

### `status`

| State           | Description                     | Read | Write |
| --------------- | ------------------------------- | :--: | :---: |
| `name`          | Heater name reported by the API |   ✓  |       |
| `custom_name`   | Custom name of the heater       |   ✓  |       |
| `version`       | Heater/API version information  |   ✓  |       |
| `operation_key` | Operation key                   |   ✓  |       |
| `mac_address`   | MAC address of the heater       |   ✓  |       |

### `control-status`

| State                     | Description                          | Unit | Read | Write |
| ------------------------- | ------------------------------------ | ---- | :--: | :---: |
| `ambient_temperature`     | Current ambient temperature          | °C   |   ✓  |       |
| `connected_to_cloud`      | Cloud connection status              |      |   ✓  |       |
| `control_signal`          | Current control signal               | %    |   ✓  |       |
| `current_power`           | Current heating power                | W    |   ✓  |       |
| `lock_active`             | Lock status                          |      |   ✓  |       |
| `open_window_active_now`  | Open-window detection status         |      |   ✓  |       |
| `operation_mode`          | Current operating mode               |      |   ✓  |   ✓   |
| `raw_ambient_temperature` | Raw ambient temperature from the API | °C   |   ✓  |       |
| `set_temperature`         | Target temperature                   | °C   |   ✓  |   ✓   |
| `switched_on`             | Current switched-on status           |      |   ✓  |       |

### `settings`

| State                            | Description                             | Unit | Read | Write |
| -------------------------------- | --------------------------------------- | ---- | :--: | :---: |
| `heating_level_percentage`       | Maximum heating level for oil heaters   | %    |   ✓  |   ✓   |
| `limited_heating_power`          | Limited heating power for panel heaters | %    |   ✓  |   ✓   |
| `temperature_calibration_offset` | Temperature calibration offset          | °C   |   ✓  |   ✓   |

## Local API

The adapter communicates directly with the Mill heater using its local HTTP API.

The adapter does not require a Mill cloud account for the local communication.

The local API used by this adapter is documented by Mill International AS in their
[Generation 3 REST API documentation](https://github.com/Mill-International-AS/Generation_3_REST_API).

The following API functions are used by the adapter:

* `/status`
* `/control-status`
* `/set-temperature`
* `/oil-heater-power`
* `/limited-heating-power`

The exact availability of individual functions depends on the heater type.

## Polling

The adapter uses two independent polling intervals.

### Fast polling

The fast polling interval is used for frequently changing values, including:

* Current temperature
* Current heating power
* Control signal
* Operating mode
* Target temperature
* Heater-specific power settings

### Slow polling

The slow polling interval is used for values that normally change less frequently, currently including the temperature calibration offset.

If a polling request fails, the adapter keeps the existing state value instead of replacing it with an invalid or missing value.

## Writing values

Writable states are processed only when ioBroker sends a state change with `ack = false`.

After a successful API request, the command is immediately acknowledged by the adapter.

If the API request fails, the command is not acknowledged as successful. The next polling cycle can then verify the actual state of the heater.

## Development

The source code is written in TypeScript.

### Install dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

### Type check

```bash
npm run check
```

### Lint

```bash
npm run lint
```

### Run tests

```bash
npm test
```

### Development with dev-server

The adapter can be developed and tested using `dev-server`.

For details, see the [ioBroker dev-server documentation](https://github.com/ioBroker/dev-server).

## Development guidelines

The adapter follows the ioBroker development and coding guidelines.

For state objects, the adapter uses the official ioBroker state roles.

* [ioBroker development and coding best practices](https://github.com/ioBroker/ioBroker.repositories#development-and-coding-best-practices)
* [ioBroker state roles](https://github.com/ioBroker/ioBroker/blob/master/doc/STATE_ROLES.md)

## Changelog

### 0.0.1

* Initial release

## License

MIT License

Copyright (c) 2026 webbummler [moin@webbummler.de](mailto:moin@webbummler.de)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.