# Older changes

### 0.1.15

- Use `setStateChanged()` for regular state updates to avoid unnecessary database writes and state change events.
- Keep `setState()` for explicit state reset operations.

### 0.1.14

* Improved API connection handling and connection status updates.
* Reduced repeated log messages during connection failures and timeouts.

### 0.1.13

* Fixed handling of the `OFF` operation mode.
* Corrected translations in several languages.

### 0.1.12

* Replaced interval-based polling with timeout-based scheduling.
* Renamed polling timer properties to match their corresponding update methods.
* Pin ESLint to version 9 to avoid dependency conflicts with eslint-plugin-import.
* Dependencies have been updated.

### 0.1.11

* Added automatic detection of heater replacement using the MAC address. Device state values are reset while state objects and the connection status are preserved.
* Dependencies have been updated.

### 0.1.10

* Added support for socket and convection heaters.
* Fixed reading of the limited heating power for panel heaters.### 0.1.9

* Added multilingual translations for state names in all supported languages to improve readability and satisfy ioBroker object validation requirements.

### 0.1.8

* Added maximum values for polling intervals to prevent excessively long intervals. The fast polling interval is limited to a maximum of 1 hour, while the slow polling interval is limited to a maximum of 24 hours.
* Added hostname configuration and made various editorial improvements.

### 0.1.7

* Simplified validation of the configured IPv4 address.
* Made editorial improvements to the documentation and configuration text.

### 0.1.5

* Applied RepoChecker recommendations and made npm-related adjustments.

### 0.1.4

* Updated TypeScript to version 6.

### 0.1.3

* Further adjustments based on RepoChecker recommendations.

### 0.1.2

* Further adjustments based on RepoChecker recommendations.

### 0.1.1

* Adjustments based on RepoChecker recommendations.

### 0.1.0

* First feature-complete development release with improved API handling, validation, polling and object structure.

### 0.0.5

* Improved startup handling if the initial status request fails.

### 0.0.4

* Protected API requests against parallel access.
* Properly handled pending and running API requests when shutting down the adapter.
* Updated `info.connection`.
* Updated support for Node.js 22.
* Updated dependencies and TypeScript configuration for Node.js 22.

### 0.0.3

* Added configurable API request timeout.
* Added validation of the fast and slow polling intervals based on the configured API request timeout.

### 0.0.2

* Improved object structure.
* Removed additional device object for individual heaters.
* Each adapter instance is assigned to a single heater.
* Added `info.connection`.

### 0.0.1

* First version.
* Integrated the local Mill Heater API.
* Added reading of status, control status and settings.