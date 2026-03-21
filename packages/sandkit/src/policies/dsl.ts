import type { JsonValue } from "../types.ts";
import type {
  PolicyServiceCredentialSource,
  PolicyServiceDescriptor,
  PolicyServiceHeaderTransform,
  WorkspacePolicy,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry));
}

function normalizeCredentialSource(
  source: PolicyServiceCredentialSource,
): PolicyServiceCredentialSource {
  if (source.kind === "default") {
    return { kind: "default" };
  }

  if (source.kind === "value") {
    if (!source.value) {
      throw new Error("Policy credential value must not be empty.");
    }
    return { kind: "value", value: source.value };
  }

  return { kind: "redacted" };
}

function normalizeHeaderTransform(
  header: PolicyServiceHeaderTransform,
): PolicyServiceHeaderTransform {
  const headerName = header.headerName.trim().toLowerCase();
  if (!headerName) {
    throw new Error("Policy header transform must include a header name.");
  }

  return {
    headerName,
    valuePrefix: header.valuePrefix,
    credential: normalizeCredentialSource(header.credential),
  };
}

function normalizeService(service: PolicyServiceDescriptor): PolicyServiceDescriptor {
  const id = service.id.trim();
  const name = service.name.trim();
  const domains = [
    ...new Set(service.domains.map((domain) => domain.trim()).filter(Boolean)),
  ].sort();

  if (!id) {
    throw new Error("Policy service id must not be empty.");
  }

  if (!name) {
    throw new Error(`Policy service "${id}" must have a name.`);
  }

  if (domains.length === 0) {
    throw new Error(`Policy service "${id}" must declare at least one domain.`);
  }

  return {
    id,
    name,
    description: service.description?.trim() || undefined,
    domains,
    headers: service.headers?.map((header) => normalizeHeaderTransform(header)),
  };
}

function normalizeServices(
  services: readonly PolicyServiceDescriptor[],
): readonly PolicyServiceDescriptor[] {
  if (services.length === 0) {
    throw new Error("allowServices(...) requires at least one service descriptor.");
  }

  const deduped = new Map<string, PolicyServiceDescriptor>();
  for (const service of services) {
    const normalized = normalizeService(service);
    deduped.set(normalized.id, normalized);
  }

  return [...deduped.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function allowAll(): WorkspacePolicy {
  return { mode: "allow-all" };
}

export function denyAll(): WorkspacePolicy {
  return { mode: "deny-all" };
}

export function allowService(service: PolicyServiceDescriptor): WorkspacePolicy {
  return allowServices([service]);
}

export function allowServices(services: readonly PolicyServiceDescriptor[]): WorkspacePolicy {
  return {
    mode: "allow-services",
    services: normalizeServices(services),
  };
}

export function describeWorkspacePolicy(policy: WorkspacePolicy): string {
  switch (policy.mode) {
    case "allow-all":
      return "allow-all";
    case "deny-all":
      return "deny-all";
    case "allow-services":
      return `allow-services:${policy.services.map((service) => service.id).join(",")}`;
  }
}

export function serializeWorkspacePolicy(policy: WorkspacePolicy): JsonValue {
  return policy as unknown as JsonValue;
}

export function redactWorkspacePolicy(policy: WorkspacePolicy): WorkspacePolicy {
  if (policy.mode !== "allow-services") {
    return policy;
  }

  return {
    mode: "allow-services",
    services: policy.services.map((service) => ({
      ...service,
      headers: service.headers?.map((header) => ({
        headerName: header.headerName,
        valuePrefix: header.valuePrefix,
        credential: header.credential.kind === "value" ? { kind: "redacted" } : header.credential,
      })),
    })),
  };
}

export function assertWorkspacePolicyIsDurable(policy: WorkspacePolicy): void {
  if (policy.mode !== "allow-services") {
    return;
  }

  for (const service of policy.services) {
    for (const header of service.headers ?? []) {
      if (header.credential.kind === "value") {
        throw new Error(
          `Workspace policy for service "${service.id}" contains an explicit secret and cannot be stored durably.`,
        );
      }
    }
  }
}

export function parseWorkspacePolicy(value: unknown): WorkspacePolicy {
  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new Error("expected workspace policy object");
  }

  if (value.mode === "allow-all") {
    return allowAll();
  }

  if (value.mode === "deny-all") {
    return denyAll();
  }

  if (value.mode === "allow-services") {
    if (!Array.isArray(value.services)) {
      throw new Error("allow-services policy must include a services array");
    }

    const services = value.services.map((service, index) => {
      if (!isRecord(service)) {
        throw new Error(`service at index ${index} must be an object`);
      }

      if (
        typeof service.id !== "string" ||
        typeof service.name !== "string" ||
        !isStringArray(service.domains)
      ) {
        throw new Error(`service at index ${index} has an invalid shape`);
      }

      const headers =
        service.headers === undefined
          ? undefined
          : (() => {
              if (!isRecordArray(service.headers)) {
                throw new Error(`service at index ${index} has invalid headers`);
              }

              return service.headers.map((header, headerIndex) => {
                if (
                  typeof header.headerName !== "string" ||
                  !isRecord(header.credential) ||
                  typeof header.credential.kind !== "string"
                ) {
                  throw new Error(
                    `service at index ${index} has invalid header transform at ${headerIndex}`,
                  );
                }

                if (header.credential.kind === "default") {
                  return normalizeHeaderTransform({
                    headerName: header.headerName,
                    valuePrefix:
                      typeof header.valuePrefix === "string" ? header.valuePrefix : undefined,
                    credential: {
                      kind: "default",
                    },
                  });
                }

                if (header.credential.kind === "redacted") {
                  return normalizeHeaderTransform({
                    headerName: header.headerName,
                    valuePrefix:
                      typeof header.valuePrefix === "string" ? header.valuePrefix : undefined,
                    credential: { kind: "redacted" },
                  });
                }

                throw new Error(
                  `service at index ${index} contains a non-durable credential source`,
                );
              });
            })();

      return normalizeService({
        id: service.id,
        name: service.name,
        description: typeof service.description === "string" ? service.description : undefined,
        domains: service.domains,
        headers,
      });
    });

    return allowServices(services);
  }

  throw new Error(`unsupported workspace policy mode "${value.mode}"`);
}
