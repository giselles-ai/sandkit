import type { PolicyServiceDescriptor } from "./types.ts";

const GITHUB_DOMAINS = ["github.com", "*.github.com", "api.github.com", "*.githubusercontent.com"];

export interface GithubOptions {
  readonly apiKey?: string;
}

function resolveGithubCredential(options?: GithubOptions) {
  if (options === undefined) {
    return { kind: "default" } as const;
  }

  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new Error(
      'github(...) explicit override requires a non-empty "apiKey". Omit the options object to use GITHUB_TOKEN.',
    );
  }

  return { kind: "value", value: options.apiKey } as const;
}

export function resolveGithubDefaultApiKey(): string | undefined {
  return process.env.GITHUB_TOKEN;
}

export function github(options?: GithubOptions): PolicyServiceDescriptor {
  return {
    id: "github",
    name: "GitHub",
    description: "Allow outbound access commonly needed for GitHub APIs and assets.",
    domains: GITHUB_DOMAINS,
    headers: [
      {
        headerName: "authorization",
        valuePrefix: "Bearer ",
        credential: resolveGithubCredential(options),
      },
    ],
  };
}
