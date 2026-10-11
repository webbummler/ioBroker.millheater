# Older changes
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