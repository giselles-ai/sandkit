import type { WorkspaceMetadata, WorkspaceRecord } from "../adapters/types.ts";
import type { WorkspaceCreateOptions } from "../types.ts";

export const WORKSPACE_SANDBOX_CONFIG_METADATA_KEY = "sandkit:sandbox-config";

export interface WorkspaceSandboxConfig {
  readonly exposedPorts?: readonly number[];
}

function isFinitePort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function normalizeExposedPorts(ports: unknown): readonly number[] {
  if (ports === undefined) {
    return [];
  }

  if (!Array.isArray(ports)) {
    throw new Error("exposedPorts must be an array of positive integers in [1, 65535]");
  }

  const normalized = ports.map((value, index) => {
    if (!isFinitePort(value)) {
      throw new Error(`exposedPorts[${index}] must be a positive integer in [1, 65535]`);
    }

    return value;
  });

  return [...normalized];
}

function corruptionError(reason: string): Error {
  return new Error(`Sandkit durable state corruption in sandkit_workspaces.metadata: ${reason}`);
}

function readWorkspaceSandboxConfigValue(value: unknown): WorkspaceSandboxConfig {
  if (value === undefined) {
    return {};
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected sandbox config metadata object");
  }

  const candidate = value as WorkspaceSandboxConfig;
  const ports = normalizeExposedPorts((candidate as { exposedPorts?: unknown }).exposedPorts);
  return ports.length === 0 ? {} : { exposedPorts: ports };
}

export function normalizeWorkspaceSandboxCreateConfig(
  config?: WorkspaceCreateOptions["sandbox"],
): WorkspaceSandboxConfig {
  if (config === undefined) {
    return {};
  }

  return {
    exposedPorts: normalizeExposedPorts(config.exposedPorts),
  };
}

export function asWorkspaceSandboxConfigMetadata(
  config: WorkspaceSandboxConfig,
): WorkspaceMetadata {
  if (!config.exposedPorts || config.exposedPorts.length === 0) {
    return {};
  }

  return {
    [WORKSPACE_SANDBOX_CONFIG_METADATA_KEY]: {
      exposedPorts: [...config.exposedPorts],
    },
  };
}

export function removeWorkspaceSandboxConfigMetadata(
  metadata?: WorkspaceMetadata | undefined,
): WorkspaceMetadata | undefined {
  if (!metadata || typeof metadata !== "object") {
    return metadata;
  }

  if (!Object.prototype.hasOwnProperty.call(metadata, WORKSPACE_SANDBOX_CONFIG_METADATA_KEY)) {
    return metadata;
  }

  const { [WORKSPACE_SANDBOX_CONFIG_METADATA_KEY]: _sandboxConfigMetadata, ...rest } = metadata;
  return rest;
}

export function readWorkspaceSandboxConfig(workspace: WorkspaceRecord): WorkspaceSandboxConfig {
  const metadataValue = workspace.metadata?.[WORKSPACE_SANDBOX_CONFIG_METADATA_KEY];
  if (metadataValue === undefined) {
    return {};
  }

  try {
    return readWorkspaceSandboxConfigValue(metadataValue);
  } catch (error) {
    throw corruptionError(
      error instanceof Error ? error.message : "invalid workspace sandbox config",
    );
  }
}
