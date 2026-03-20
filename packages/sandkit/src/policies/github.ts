import type { PolicyServiceDescriptor } from "./types.ts";

const GITHUB_DOMAINS = ["github.com", "*.github.com", "api.github.com", "*.githubusercontent.com"];

export function github(): PolicyServiceDescriptor {
  return {
    id: "github",
    name: "GitHub",
    description: "Allow outbound access commonly needed for GitHub APIs and assets.",
    domains: GITHUB_DOMAINS,
  };
}
