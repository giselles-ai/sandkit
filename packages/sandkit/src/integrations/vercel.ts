import { createVercelSandboxDriverFactory } from "../drivers/vercel-sandbox.ts";
import { createSandboxProvider } from "../types.ts";
import type { SandkitSandboxProvider, VercelSandboxOptions } from "../types.ts";

export type { SandkitSandboxProvider, VercelSandboxOptions } from "../types.ts";

export function vercelSandbox(options: VercelSandboxOptions = {}): SandkitSandboxProvider {
  return createSandboxProvider("vercel", createVercelSandboxDriverFactory(options));
}
