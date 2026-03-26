import { allowService } from "./dsl.ts";
import type { PolicyServiceDescriptor, WorkspacePolicy } from "./types.ts";

const BUN_DOMAINS = ["bun.sh", "bun.com"] as const;

/**
 * Allow outbound access to Bun distribution and install endpoints.
 */
export function bun(): PolicyServiceDescriptor {
  return {
    id: "bun",
    name: "Bun",
    description: "Allow outbound access to Bun install and distribution endpoints.",
    domains: BUN_DOMAINS,
  };
}

export function allowBun(): WorkspacePolicy {
  return allowService(bun());
}
