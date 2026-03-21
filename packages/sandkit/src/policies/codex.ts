import { allowService } from "./dsl.ts";
import type { PolicyServiceDescriptor, WorkspacePolicy } from "./types.ts";

const CODEX_DOMAINS = ["api.openai.com", "*.openai.com", "openrouter.ai", "*.openrouter.ai"];

export interface CodexOptions {
  readonly apiKey?: string;
}

function resolveCodexCredential(options?: CodexOptions) {
  if (options === undefined) {
    return { kind: "default" } as const;
  }

  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new Error(
      'codex(...) explicit override requires a non-empty "apiKey". Omit the options object to use CODEX_API_KEY.',
    );
  }

  return { kind: "value", value: options.apiKey } as const;
}

export function resolveCodexDefaultApiKey(): string | undefined {
  return process.env.CODEX_API_KEY;
}

export function codex(options?: CodexOptions): PolicyServiceDescriptor {
  return {
    id: "codex",
    name: "Codex",
    description: "Allow outbound access commonly needed by Codex-style clients.",
    domains: CODEX_DOMAINS,
    headers: [
      {
        headerName: "authorization",
        valuePrefix: "Bearer ",
        credential: resolveCodexCredential(options),
      },
    ],
  };
}

export function allowCodex(): WorkspacePolicy {
  return allowService(codex());
}
