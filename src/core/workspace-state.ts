import type { WorkspaceRecord } from "../adapters/types.ts";
import type { JsonValue, PersistedSandboxState } from "../types.ts";

const SANDBOX_METADATA_KEY = "sandkit:sandbox";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPersistedSandboxState(
  workspace: WorkspaceRecord,
): PersistedSandboxState | null {
  const value = workspace.metadata?.[SANDBOX_METADATA_KEY];
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.kind !== "string" || typeof value.sessionId !== "string") {
    return null;
  }

  const state = value.state as JsonValue | undefined;
  return {
    kind: value.kind,
    sessionId: value.sessionId,
    state,
  };
}

export function writePersistedSandboxState(
  workspace: WorkspaceRecord,
  snapshot: PersistedSandboxState,
): WorkspaceRecord["metadata"] {
  return {
    ...workspace.metadata,
    [SANDBOX_METADATA_KEY]: snapshot as unknown as JsonValue,
  };
}
