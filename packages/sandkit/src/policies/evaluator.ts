import type { NetworkPolicy, NetworkPolicyDecision, NetworkPolicyRecord } from "./types";

const parseTarget = (target: string | URL) => {
  if (typeof target === "string") {
    try {
      return new URL(target);
    } catch {
      // Accept host-like values without a scheme.
      return new URL(`https://${target}`);
    }
  }
  return target;
};

const normalizeHostname = (hostname: string) => hostname.toLowerCase().replace(/\.+$/, "");

const portsMatch = (record: NetworkPolicyRecord, urlPort: string, protocol: string) => {
  if (!record.ports || record.ports.length === 0) {
    return true;
  }
  const targetPort = urlPort === "" ? (protocol === "http:" ? 80 : 443) : Number(urlPort);
  return record.ports.includes(targetPort);
};

const pathMatch = (record: NetworkPolicyRecord, pathname: string) => {
  if (!record.pathPrefix) {
    return true;
  }
  return pathname.startsWith(record.pathPrefix);
};

const hostMatch = (record: NetworkPolicyRecord, targetHost: string) => {
  const expected = normalizeHostname(record.host);
  const normalizedTarget = normalizeHostname(targetHost);
  if (record.includeSubdomains) {
    return normalizedTarget === expected || normalizedTarget.endsWith(`.${expected}`);
  }
  return normalizedTarget === expected;
};

const evaluateRecord = (record: NetworkPolicyRecord, url: URL) => {
  if (!url.hostname) {
    return false;
  }
  if (!hostMatch(record, url.hostname)) {
    return false;
  }
  if (!pathMatch(record, url.pathname)) {
    return false;
  }
  return portsMatch(record, url.port, url.protocol);
};

export function evaluateNetworkPolicies(
  policies: readonly NetworkPolicy[] | undefined,
  target: string | URL,
): NetworkPolicyDecision {
  let parsedTarget: URL;
  try {
    parsedTarget = parseTarget(target);
  } catch {
    return {
      allowed: false,
      reason: "Invalid target URL",
    };
  }

  if (!policies || policies.length === 0) {
    return {
      allowed: true,
      reason: "No policies configured",
    };
  }

  for (const policy of policies) {
    for (const record of policy.records) {
      if (evaluateRecord(record, parsedTarget)) {
        return {
          allowed: true,
          matchedPolicyId: policy.id,
          matchedPolicyName: policy.name,
          matchedRecord: record,
          reason: `Allowed by ${policy.name} policy`,
        };
      }
    }
  }

  return {
    allowed: false,
    reason: "No policy matched target host",
  };
}
