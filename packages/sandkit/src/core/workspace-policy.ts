import type {
  WorkspaceMetadata,
  WorkspaceRecord,
  WorkspaceUpdateInput,
} from "../adapters/types.ts";
import {
  allowAll,
  assertWorkspacePolicyIsDurable,
  describeWorkspacePolicy,
  parseWorkspacePolicy,
  redactWorkspacePolicy,
  serializeWorkspacePolicy,
} from "../policies/dsl.ts";
import type { WorkspacePolicy } from "../policies/types.ts";

export const WORKSPACE_POLICY_METADATA_KEY = "sandkit:policy";

function corruptionError(reason: string): Error {
  return new Error(`Sandkit durable state corruption in sandkit_workspaces.metadata: ${reason}`);
}

export function readWorkspacePolicy(
  workspace: WorkspaceRecord,
  fallback: WorkspacePolicy = allowAll(),
): WorkspacePolicy {
  const value = workspace.metadata?.[WORKSPACE_POLICY_METADATA_KEY];
  if (value === undefined) {
    return fallback;
  }

  try {
    return parseWorkspacePolicy(value);
  } catch (error) {
    throw corruptionError(error instanceof Error ? error.message : "invalid workspace policy");
  }
}

export function asWorkspacePolicyMetadata(policy: WorkspacePolicy): WorkspaceMetadata {
  assertWorkspacePolicyIsDurable(policy);
  return {
    [WORKSPACE_POLICY_METADATA_KEY]: serializeWorkspacePolicy(policy),
  };
}

export function removeWorkspacePolicyMetadata(
  metadata?: WorkspaceMetadata | undefined,
): WorkspaceMetadata | undefined {
  if (!metadata || typeof metadata !== "object") {
    return metadata;
  }

  if (!Object.prototype.hasOwnProperty.call(metadata, WORKSPACE_POLICY_METADATA_KEY)) {
    return metadata;
  }

  const { [WORKSPACE_POLICY_METADATA_KEY]: _policyMetadata, ...rest } = metadata;
  return rest;
}

export function asWorkspacePolicyPatch(policy: WorkspacePolicy): WorkspaceUpdateInput {
  return {
    metadata: asWorkspacePolicyMetadata(policy),
  };
}

export function describeWorkspacePolicyId(policy: WorkspacePolicy): string {
  return describeWorkspacePolicy(policy);
}

export function asPolicySnapshotConfig(policy: WorkspacePolicy): unknown {
  return redactWorkspacePolicy(policy);
}
