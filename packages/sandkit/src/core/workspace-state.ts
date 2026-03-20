import type { WorkspaceRecord, WorkspaceUpdateInput } from "../adapters/types.ts";
import type { JsonValue, PersistedSandboxState } from "../types.ts";

const SANDBOX_METADATA_KEY = "sandkit:sandbox";

type RawWorkspaceSandboxState = {
  kind: string;
  sessionId?: unknown;
  state?: unknown;
};

type SerializedWorkspaceSandboxState =
  | { kind: "cold" }
  | { kind: "session"; sessionId: string }
  | { kind: "snapshot"; state: PersistedSandboxState };

interface WorkspaceSandboxStateBase {
  readonly kind: string;
}

interface WorkspaceSandboxStateCold extends WorkspaceSandboxStateBase {
  readonly kind: "cold";
}

interface WorkspaceSandboxStateSession extends WorkspaceSandboxStateBase {
  readonly kind: "session";
  readonly sandboxId: string;
}

interface WorkspaceSandboxStateSnapshot extends WorkspaceSandboxStateBase {
  readonly kind: "snapshot";
  readonly commit: SandboxCommit;
}

export type WorkspaceSandboxState =
  | WorkspaceSandboxStateCold
  | WorkspaceSandboxStateSession
  | WorkspaceSandboxStateSnapshot;

export type SandboxCommit = SandboxSnapshotCommit;

interface SandboxSnapshotCommit {
  readonly kind: "snapshot";
  readonly state: PersistedSandboxState;
}

export interface WorkspaceSandboxTransition {
  readonly nextState: WorkspaceSandboxState;
  readonly patch: WorkspaceUpdateInput;
}

export interface WorkspaceSandboxTransitionResult {
  readonly record: WorkspaceRecord;
  readonly state: WorkspaceSandboxState;
}

export interface WorkspaceStateStore {
  updateWorkspace(id: string, input: WorkspaceUpdateInput): Promise<WorkspaceRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedSandboxState(value: unknown): value is PersistedSandboxState {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.kind !== "string" || typeof value.sessionId !== "string") {
    return false;
  }

  return value.state === undefined || isJsonValue(value.state);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((item) => isJsonValue(item));
}

function normalizeWorkspaceSnapshotState(state: unknown): PersistedSandboxState | null {
  return isPersistedSandboxState(state) ? state : null;
}

function toSnapshotCommit(snapshot: PersistedSandboxState): SandboxSnapshotCommit {
  return { kind: "snapshot", state: snapshot };
}

function toSerializedWorkspaceState(state: WorkspaceSandboxState): SerializedWorkspaceSandboxState {
  switch (state.kind) {
    case "cold": {
      return { kind: "cold" };
    }
    case "session": {
      return { kind: "session", sessionId: state.sandboxId };
    }
    case "snapshot": {
      return { kind: "snapshot", state: state.commit.state };
    }
    default: {
      return { kind: "cold" };
    }
  }
}

export function makeSnapshotCommit(state: PersistedSandboxState): SandboxCommit {
  return toSnapshotCommit(state);
}

export function asWorkspaceSandboxStateMetadata(
  state: WorkspaceSandboxState,
): WorkspaceRecord["metadata"] {
  return {
    [SANDBOX_METADATA_KEY]: toSerializedWorkspaceState(state) as JsonValue,
  };
}

export function readWorkspaceSandboxState(workspace: WorkspaceRecord): WorkspaceSandboxState {
  const value = workspace.metadata?.[SANDBOX_METADATA_KEY];
  if (!isRecord(value)) {
    return { kind: "cold" };
  }

  const raw = value as RawWorkspaceSandboxState;
  if (typeof raw.kind !== "string") {
    return { kind: "cold" };
  }

  if (raw.kind === "session" && typeof raw.sessionId === "string") {
    return { kind: "session", sandboxId: raw.sessionId };
  }

  if (raw.kind === "sandbox-session" && typeof raw.sessionId === "string") {
    return { kind: "session", sandboxId: raw.sessionId };
  }

  if (raw.kind === "snapshot") {
    const snapshot = normalizeWorkspaceSnapshotState(raw.state);
    if (!snapshot) {
      return { kind: "cold" };
    }
    return { kind: "snapshot", commit: toSnapshotCommit(snapshot) };
  }

  return { kind: "cold" };
}

export function transitionToSession(sandboxId: string, at: string): WorkspaceSandboxTransition {
  const nextState: WorkspaceSandboxState = {
    kind: "session",
    sandboxId,
  };

  return {
    nextState,
    patch: {
      metadata: asWorkspaceSandboxStateMetadata(nextState),
      sandboxId,
      lastResumedAt: at,
    },
  };
}

export function transitionAfterCommandCommit(
  commit: SandboxCommit,
  at: string,
): WorkspaceSandboxTransition {
  const nextState: WorkspaceSandboxState = {
    kind: "snapshot",
    commit,
  };

  return {
    nextState,
    patch: {
      metadata: asWorkspaceSandboxStateMetadata(nextState),
      sandboxId: commit.state.sessionId,
      lastResumedAt: at,
    },
  };
}

export function toDriverResumeState(state: WorkspaceSandboxState): PersistedSandboxState | null {
  if (state.kind === "snapshot") {
    return state.commit.state;
  }

  if (state.kind === "session") {
    return {
      kind: "sandbox-session",
      sessionId: state.sandboxId,
    };
  }

  return null;
}

export async function persistSandboxTransition(
  store: WorkspaceStateStore,
  workspaceId: string,
  transition: WorkspaceSandboxTransition,
): Promise<WorkspaceSandboxTransitionResult> {
  const record = await store.updateWorkspace(workspaceId, transition.patch);
  return {
    record,
    state: transition.nextState,
  };
}
