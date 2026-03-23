import { allowService } from "./dsl.ts";
import type { PolicyServiceDescriptor, WorkspacePolicy } from "./types.ts";

const DEFAULT_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export interface AiGatewayOptions {
  readonly baseUrl?: string;
}

function resolveAiGatewayBaseUrl(baseUrl?: string): string {
  const provided = (
    baseUrl ??
    process.env.AI_GATEWAY_BASE_URL ??
    DEFAULT_AI_GATEWAY_BASE_URL
  ).trim();
  if (!provided) {
    throw new Error("aiGateway() requires a non-empty base URL.");
  }
  return provided;
}

function resolveAiGatewayBaseDomains(baseUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`aiGateway() received an invalid base URL: ${baseUrl}`);
  }

  const hostname = parsed.hostname.trim().toLowerCase();

  if (!hostname) {
    throw new Error("aiGateway() requires a URL with a valid hostname.");
  }

  // Use hostname only for policy matching; ports are intentionally ignored so allow-lists
  // stay compatible with Vercel Sandbox host/domain matching.
  return [hostname, `*.${hostname}`];
}

function resolveAiGatewayCredential(): { kind: "default" } {
  return { kind: "default" };
}

export function resolveAiGatewayDefaultApiKey(): string | undefined {
  return process.env.AI_GATEWAY_API_KEY;
}

/**
 * Allow outbound access to the currently configured AI Gateway endpoint host/domain.
 * The configured endpoint is not treated as a generic capability; it follows
 * `AI_GATEWAY_BASE_URL` and derives allowed host/domain entries from its hostname.
 */
export function aiGateway(options?: AiGatewayOptions): PolicyServiceDescriptor {
  const configuredBaseUrl = resolveAiGatewayBaseUrl(options?.baseUrl);

  return {
    id: "aiGateway",
    name: "AI Gateway",
    description: "Allow outbound access to the configured AI Gateway endpoint host.",
    domains: resolveAiGatewayBaseDomains(configuredBaseUrl),
    headers: [
      {
        headerName: "authorization",
        valuePrefix: "Bearer ",
        credential: resolveAiGatewayCredential(),
      },
    ],
  };
}

export function allowAiGateway(): WorkspacePolicy {
  return allowService(aiGateway());
}
