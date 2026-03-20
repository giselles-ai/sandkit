import type { PolicyServiceDescriptor, WorkspacePolicy, WorkspacePolicyDecision } from "./types";

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

const normalizeHostname = (hostname: string) =>
  hostname.toLowerCase().replace(/^\*\./, "").replace(/\.+$/, "");

const domainMatches = (domain: string, targetHost: string) => {
  const expected = normalizeHostname(domain);
  const normalizedTarget = normalizeHostname(targetHost);
  if (domain.startsWith("*.")) {
    return normalizedTarget.endsWith(`.${expected}`);
  }
  return normalizedTarget === expected;
};

const evaluateService = (service: PolicyServiceDescriptor, url: URL) => {
  if (!url.hostname) {
    return false;
  }
  return service.domains.some((domain) => domainMatches(domain, url.hostname));
};

export function evaluateWorkspacePolicy(
  policy: WorkspacePolicy | undefined,
  target: string | URL,
): WorkspacePolicyDecision {
  let parsedTarget: URL;
  try {
    parsedTarget = parseTarget(target);
  } catch {
    return {
      allowed: false,
      reason: "Invalid target URL",
    };
  }

  if (!policy || policy.mode === "allow-all") {
    return {
      allowed: true,
      reason: "Workspace policy allows all outbound traffic",
    };
  }

  if (policy.mode === "deny-all") {
    return {
      allowed: false,
      reason: "Workspace policy denies all outbound traffic",
    };
  }

  for (const service of policy.services) {
    if (evaluateService(service, parsedTarget)) {
      return {
        allowed: true,
        matchedServiceId: service.id,
        matchedServiceName: service.name,
        matchedDomain: service.domains.find((domain) =>
          domainMatches(domain, parsedTarget.hostname),
        ),
        reason: `Allowed by ${service.name} service policy`,
      };
    }
  }

  return {
    allowed: false,
    reason: "No service descriptor matched target host",
  };
}
