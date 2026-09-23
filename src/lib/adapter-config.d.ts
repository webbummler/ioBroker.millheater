// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			ip: string;
			pollInterval1: number;
      pollInterval2: number;
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};