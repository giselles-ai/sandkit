import { MockSandboxDriverFactory } from "../core/mock-driver.ts";
import { createSandboxProvider } from "../types.ts";
import type { SandkitSandboxProvider, SandboxDriverFactory } from "../types.ts";

export { MockSandboxDriverFactory } from "../core/mock-driver.ts";

export function mockSandbox(): SandkitSandboxProvider {
  return createSandboxProvider("mock", new MockSandboxDriverFactory());
}

/**
 * Internal helper for tests and smoke setups that need custom driver factories.
 * Not part of public API usage.
 */
export function internalSandboxProvider(
  driverFactory: SandboxDriverFactory,
  provider = "custom",
): SandkitSandboxProvider {
  return createSandboxProvider(provider, driverFactory);
}
