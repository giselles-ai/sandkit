import { createMemoryAdapter } from "../adapters/index.ts";
import { allowAll } from "../policies/dsl.ts";
import type { WorkspacePolicy } from "../policies/types.ts";
import type { SandkitOptions } from "../types.ts";
import { MockSandboxDriverFactory } from "./mock-driver.ts";

export interface SandkitContext {
  readonly adapter: NonNullable<SandkitOptions["database"]>;
  readonly driverFactory: NonNullable<NonNullable<SandkitOptions["sandbox"]>["driverFactory"]>;
  readonly defaultPolicy: WorkspacePolicy;
  readonly options: SandkitOptions;
}

function resolveDefaultPolicy(options: SandkitOptions): WorkspacePolicy {
  if (options.network !== undefined) {
    throw new Error(
      'SandkitOptions.network has been removed. Use "policy" with allowAll(), denyAll(), allowService(...), or allowServices(...) instead.',
    );
  }

  return options.policy ?? allowAll();
}

export function createSandkitContext(options: SandkitOptions = {}): SandkitContext {
  return {
    adapter: options.database ?? createMemoryAdapter(),
    driverFactory: options.sandbox?.driverFactory ?? new MockSandboxDriverFactory(),
    defaultPolicy: resolveDefaultPolicy(options),
    options,
  };
}
