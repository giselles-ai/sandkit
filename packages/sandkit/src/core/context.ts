import { createMemoryAdapter } from "../adapters/index.ts";
import type { SandkitOptions } from "../types.ts";
import { MockSandboxDriverFactory } from "./mock-driver.ts";

export interface SandkitContext {
  readonly adapter: NonNullable<SandkitOptions["database"]>;
  readonly driverFactory: NonNullable<NonNullable<SandkitOptions["sandbox"]>["driverFactory"]>;
  readonly options: SandkitOptions;
}

function resolveDeprecatedNetworkOption(options: SandkitOptions): void {
  if (options.network !== undefined) {
    throw new Error(
      "SandkitOptions.network has been removed. Use createWorkspace({ policy }), workspace.setPolicy(...), or per-run policy overrides instead.",
    );
  }
}

export function createSandkitContext(options: SandkitOptions = {}): SandkitContext {
  resolveDeprecatedNetworkOption(options);

  return {
    adapter: options.database ?? createMemoryAdapter(),
    driverFactory: options.sandbox?.driverFactory ?? new MockSandboxDriverFactory(),
    options,
  };
}
