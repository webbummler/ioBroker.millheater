// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			devices: {
				userDefinedName?: string;
				host: string;
				pollWhenOff: boolean;
			}[];
			apiTimeout: number;
			pollInterval1: number;
			pollInterval2: number;
		}
	}
}

// This is required so the above AdapterConfig is found by TypeScript / type checking
export {};