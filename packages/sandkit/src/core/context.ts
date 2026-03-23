import { createMemoryAdapter } from "../adapters/index.ts";
import type { SandkitOptions } from "../types.ts";

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

export function createSandkitContext(options: SandkitOptions): SandkitContext {
  if (!options) {
    throw new Error(
      "SandkitOptions is required. Set sandbox.driverFactory to a Sandkit sandbox driver factory.",
    );
  }

  resolveDeprecatedNetworkOption(options);
  if (!options.sandbox?.driverFactory) {
    throw new Error(
      "SandkitOptions.sandbox.driverFactory is required. Set it to a Sandkit sandbox driver factory.",
    );
  }

  return {
    adapter: options.database ?? createMemoryAdapter(),
    driverFactory: options.sandbox.driverFactory,
    options,
  };
}
