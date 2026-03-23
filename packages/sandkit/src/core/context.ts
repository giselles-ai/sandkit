import { createMemoryAdapter } from "../adapters/index.ts";
import { getSandboxDriverFactory } from "../types.ts";
import type { SandkitOptions, SandboxDriverFactory } from "../types.ts";

export interface SandkitContext {
  readonly adapter: NonNullable<SandkitOptions["database"]>;
  readonly driverFactory: SandboxDriverFactory;
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
    throw new Error("SandkitOptions is required. Set sandbox to a Sandkit sandbox provider.");
  }

  resolveDeprecatedNetworkOption(options);
  if (!options.sandbox) {
    throw new Error(
      "SandkitOptions.sandbox is required. Set it to a Sandkit sandbox provider (for example, vercelSandbox(...)).",
    );
  }

  return {
    adapter: options.database ?? createMemoryAdapter(),
    driverFactory: getSandboxDriverFactory(options.sandbox),
    options,
  };
}
