import { allowService } from "./dsl.ts";
import type { PolicyServiceDescriptor, WorkspacePolicy } from "./types.ts";

const GEMINI_DOMAINS = ["ai.google.dev", "*.ai.google.dev", "generativelanguage.googleapis.com"];

export interface GeminiOptions {
  readonly apiKey?: string;
}

function resolveGeminiCredential(options?: GeminiOptions) {
  if (options === undefined) {
    return { kind: "default" } as const;
  }

  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new Error(
      'gemini(...) explicit override requires a non-empty "apiKey". Omit the options object to use GEMINI_API_KEY.',
    );
  }

  return { kind: "value", value: options.apiKey } as const;
}

export function resolveGeminiDefaultApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY;
}

export function gemini(options?: GeminiOptions): PolicyServiceDescriptor {
  return {
    id: "gemini",
    name: "Gemini",
    description: "Allow outbound access commonly needed by Gemini clients.",
    domains: GEMINI_DOMAINS,
    headers: [
      {
        headerName: "x-goog-api-key",
        credential: resolveGeminiCredential(options),
      },
    ],
  };
}

export function allowGemini(): WorkspacePolicy {
  return allowService(gemini());
}
