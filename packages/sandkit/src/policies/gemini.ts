import type { NetworkPolicy } from "./types";

const GEMINI_HOSTS = ["generativelanguage.googleapis.com", "ai.google.dev", "googleapis.com"];

export const allowGemini = (): NetworkPolicy => ({
  id: "allow-gemini",
  name: "allow-gemini",
  description: "Allow outbound requests commonly used by Gemini clients",
  records: GEMINI_HOSTS.map((host) => ({
    host,
    includeSubdomains: true,
    ports: [80, 443],
  })),
});
