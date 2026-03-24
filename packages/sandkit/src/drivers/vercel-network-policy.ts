import type {
  NetworkPolicy as VercelNetworkPolicy,
  NetworkPolicyRule as VercelNetworkPolicyRule,
} from "@vercel/sandbox";

import {
  describeDefaultCredentialSource,
  resolveDefaultCredentialValue,
} from "../policies/default-credentials.ts";
import type { PolicyServiceHeaderTransform, WorkspacePolicy } from "../policies/types.ts";

function resolveCredentialValue(serviceId: string, header: PolicyServiceHeaderTransform): string {
  if (header.credential.kind === "value") {
    return header.credential.value;
  }

  if (header.credential.kind === "default") {
    const value = resolveDefaultCredentialValue(serviceId);
    if (!value) {
      throw new Error(
        `Workspace policy for service "${serviceId}" requires ${describeDefaultCredentialSource(serviceId)}.`,
      );
    }
    return value;
  }

  throw new Error(
    `Workspace policy for service "${serviceId}" contains a redacted credential and cannot be applied.`,
  );
}

function encodeHeaderValue(
  value: string,
  encoding: PolicyServiceHeaderTransform["valueEncoding"],
): string {
  if (encoding === "base64") {
    return Buffer.from(value, "utf8").toString("base64");
  }

  return value;
}

function compileHeaderRules(
  serviceId: string,
  headers: readonly PolicyServiceHeaderTransform[] | undefined,
): VercelNetworkPolicyRule[] {
  if (!headers || headers.length === 0) {
    return [];
  }

  const resolvedHeaders = Object.fromEntries(
    headers.map((header) => [
      header.headerName,
      `${header.valuePrefix ?? ""}${encodeHeaderValue(
        `${header.credentialPrefix ?? ""}${resolveCredentialValue(serviceId, header)}`,
        header.valueEncoding,
      )}`,
    ]),
  );

  return [
    {
      transform: [
        {
          headers: resolvedHeaders,
        },
      ],
    },
  ];
}

export function compileVercelNetworkPolicy(policy: WorkspacePolicy): VercelNetworkPolicy {
  switch (policy.mode) {
    case "allow-all":
      return "allow-all";
    case "deny-all":
      return "deny-all";
    case "allow-services": {
      const allow: Record<string, VercelNetworkPolicyRule[]> = {};

      for (const service of policy.services) {
        for (const domain of service.domains) {
          const rules = compileHeaderRules(
            service.id,
            service.domainHeaders?.[domain] ?? service.headers,
          );
          const existing = allow[domain] ?? [];
          allow[domain] = [...existing, ...rules];
        }
      }

      return { allow };
    }
  }
}
