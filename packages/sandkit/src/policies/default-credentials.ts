import { resolveAiGatewayDefaultApiKey } from "./ai-gateway.ts";
import { resolveCodexDefaultApiKey } from "./codex.ts";
import { resolveGeminiDefaultApiKey } from "./gemini.ts";
import { resolveGithubDefaultApiKey } from "./github.ts";

export function resolveDefaultCredentialValue(serviceId: string): string | undefined {
  switch (serviceId) {
    case "codex":
      return resolveCodexDefaultApiKey();
    case "gemini":
      return resolveGeminiDefaultApiKey();
    case "github":
      return resolveGithubDefaultApiKey();
    case "aiGateway":
      return resolveAiGatewayDefaultApiKey();
    default:
      return undefined;
  }
}

export function describeDefaultCredentialSource(serviceId: string): string {
  switch (serviceId) {
    case "codex":
      return "CODEX_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "github":
      return "GITHUB_TOKEN";
    case "aiGateway":
      return "AI_GATEWAY_API_KEY";
    default:
      return `default credential for service "${serviceId}"`;
  }
}
