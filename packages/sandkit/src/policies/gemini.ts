import { allowService } from "./dsl.ts";
import type { PolicyServiceDescriptor, WorkspacePolicy } from "./types.ts";

const GEMINI_DOMAINS = ["ai.google.dev", "*.ai.google.dev", "generativelanguage.googleapis.com"];

export function gemini(): PolicyServiceDescriptor {
  return {
    id: "gemini",
    name: "Gemini",
    description: "Allow outbound access commonly needed by Gemini clients.",
    domains: GEMINI_DOMAINS,
  };
}

export function allowGemini(): WorkspacePolicy {
  return allowService(gemini());
}
