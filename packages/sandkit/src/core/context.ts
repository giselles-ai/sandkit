import { createMemoryAdapter } from "../adapters/index.ts";
import type { SandkitOptions } from "../types.ts";
import { MockSandboxDriverFactory } from "./mock-driver.ts";

export interface SandkitContext {
  readonly adapter: NonNullable<SandkitOptions["database"]>;
  readonly driverFactory: NonNullable<NonNullable<SandkitOptions["sandbox"]>["driverFactory"]>;
  readonly networkPolicies: NonNullable<SandkitOptions["network"]>;
  readonly options: SandkitOptions;
}

export function createSandkitContext(options: SandkitOptions = {}): SandkitContext {
  return {
    adapter: options.database ?? createMemoryAdapter(),
    driverFactory: options.sandbox?.driverFactory ?? new MockSandboxDriverFactory(),
    networkPolicies: options.network ?? [],
    options,
  };
}
