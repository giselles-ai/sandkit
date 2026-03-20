import { allowService } from "./dsl.ts";
import type { PolicyServiceDescriptor, WorkspacePolicy } from "./types.ts";

const CODEX_DOMAINS = ["api.openai.com", "*.openai.com", "openrouter.ai", "*.openrouter.ai"];

export function codex(): PolicyServiceDescriptor {
  return {
    id: "codex",
    name: "Codex",
    description: "Allow outbound access commonly needed by Codex-style clients.",
    domains: CODEX_DOMAINS,
  };
}

export function allowCodex(): WorkspacePolicy {
  return allowService(codex());
}
