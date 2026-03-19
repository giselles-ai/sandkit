import type { NetworkPolicy } from "./types";

const CODEX_HOSTS = ["api.openai.com", "openrouter.ai", "api.openrouter.ai"];

export const allowCodex = (): NetworkPolicy => ({
  id: "allow-codex",
  name: "allow-codex",
  description: "Allow outbound requests commonly used by Codex-style clients",
  records: CODEX_HOSTS.map((host) => ({
    host,
    includeSubdomains: true,
    ports: [80, 443],
  })),
});
