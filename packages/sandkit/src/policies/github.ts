import type { PolicyServiceDescriptor } from "./types.ts";

const GITHUB_DOMAINS = ["github.com", "api.github.com", "*.githubusercontent.com"] as const;

export interface GithubOptions {
  readonly token?: string;
}

function resolveGithubCredential(options?: GithubOptions) {
  if (options === undefined) {
    return { kind: "default" } as const;
  }

  if (typeof options.token !== "string" || options.token.trim().length === 0) {
    throw new Error(
      'github(...) explicit override requires a non-empty "token". Omit the options object to use GITHUB_TOKEN.',
    );
  }

  return { kind: "value", value: options.token } as const;
}

export function resolveGithubDefaultApiKey(): string | undefined {
  return process.env.GITHUB_TOKEN;
}

export function github(options?: GithubOptions): PolicyServiceDescriptor {
  const credential = resolveGithubCredential(options);

  return {
    id: "github",
    name: "GitHub",
    description:
      "Allow requests to github.com and api.github.com through Vercel Sandbox firewall header transforms.",
    domains: GITHUB_DOMAINS,
    domainHeaders: {
      "github.com": [
        {
          headerName: "authorization",
          valuePrefix: "Basic ",
          credentialPrefix: "x-access-token:",
          valueEncoding: "base64",
          credential,
        },
      ],
      "api.github.com": [
        {
          headerName: "authorization",
          valuePrefix: "Bearer ",
          credential,
        },
      ],
      "*.githubusercontent.com": [],
    },
  };
}
