import { allowService } from "./dsl.ts";
import type { PolicyServiceDescriptor, WorkspacePolicy } from "./types.ts";

const NPM_DOMAINS = ["registry.npmjs.org"] as const;

/**
 * Allow outbound access to the public npm package registry.
 *
 * Keep this preset scoped to the actual package source host instead of
 * broadening to unrelated npm web properties.
 */
export function npm(): PolicyServiceDescriptor {
  return {
    id: "npm",
    name: "npm",
    description: "Allow outbound access to the public npm package registry.",
    domains: NPM_DOMAINS,
  };
}

export function allowNpm(): WorkspacePolicy {
  return allowService(npm());
}
