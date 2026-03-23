import type { WorkspaceRecord, WorkspaceUpdateInput } from "../adapters/types.ts";
import { parseWorkspacePolicy, serializeWorkspacePolicy } from "../policies/dsl.ts";
import type { WorkspacePolicy } from "../policies/types.ts";
import type {
  JsonValue,
  PersistedSandboxState,
  SandboxSessionLease,
  WorkspaceSandboxLease,
} from "../types.ts";

const SANDBOX_METADATA_KEY = "sandkit:sandbox";

type RawWorkspaceSandboxState = {
  kind?: unknown;
  sessionId?: unknown;
  state?: unknown;
  lease?: unknown;
  policy?: unknown;
};

type SerializedWorkspaceSandboxState =
  | { kind: "cold" }
  | {
      kind: "session";
      sessionId: string;
      lease: SerializedSessionLease;
      policy?: JsonValue;
    }
  | { kind: "snapshot"; state: PersistedSandboxState };

type SerializedSessionLease = {
  observedAt: string;
  expiresAt: string;
};

interface WorkspaceSandboxStateBase {
  readonly kind: string;
}

interface WorkspaceSandboxStateCold extends WorkspaceSandboxStateBase {
  readonly kind: "cold";
}

interface WorkspaceSandboxStateSession extends WorkspaceSandboxStateBase {
  readonly kind: "session";
  readonly sandboxId: string;
  readonly lease: SandboxSessionLease;
  readonly sessionPolicy?: WorkspacePolicy;
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

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isSerializedSessionLease(value: unknown): value is SerializedSessionLease {
  if (!isRecord(value)) {
    return false;
  }

  return isIsoTimestamp(value.observedAt) && isIsoTimestamp(value.expiresAt);
}

function readWorkspaceSessionPolicy(value: unknown): WorkspacePolicy | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return parseWorkspacePolicy(value);
  } catch {
    return undefined;
  }
}

function toSnapshotCommit(snapshot: PersistedSandboxState): SandboxSnapshotCommit {
  return { kind: "snapshot", state: snapshot };
}

function toSerializedWorkspaceState(state: WorkspaceSandboxState): SerializedWorkspaceSandboxState {
  switch (state.kind) {
    case "cold":
      return { kind: "cold" };
    case "session":
      return {
        kind: "session",
        sessionId: state.sandboxId,
        lease: {
          observedAt: state.lease.observedAt,
          expiresAt: state.lease.expiresAt,
        },
        policy:
          state.sessionPolicy === undefined
            ? undefined
            : serializeWorkspacePolicy(state.sessionPolicy),
      };
    case "snapshot":
      return { kind: "snapshot", state: state.commit.state };
    default:
      return { kind: "cold" };
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
  if (
    raw.kind === "session" &&
    typeof raw.sessionId === "string" &&
    isSerializedSessionLease(raw.lease)
  ) {
    return {
      kind: "session",
      sandboxId: raw.sessionId,
      lease: {
        sandboxId: raw.sessionId,
        observedAt: raw.lease.observedAt,
        expiresAt: raw.lease.expiresAt,
      },
      sessionPolicy: readWorkspaceSessionPolicy(raw.policy),
    };
  }

  if (
    (raw.kind === "session" || raw.kind === "sandbox-session") &&
    typeof raw.sessionId === "string"
  ) {
    return { kind: "cold" };
  }

  if (raw.kind === "snapshot") {
    const snapshot = isPersistedSandboxState(raw.state) ? raw.state : null;
    if (!snapshot) {
      return { kind: "cold" };
    }

    return {
      kind: "snapshot",
      commit: toSnapshotCommit(snapshot),
    };
  }

  return { kind: "cold" };
}

export function readWorkspaceSandboxLease(
  workspace: WorkspaceRecord,
): WorkspaceSandboxLease | null {
  return workspaceSandboxLeaseFromState(readWorkspaceSandboxState(workspace));
}

export function workspaceSandboxLeaseFromState(
  state: WorkspaceSandboxState,
): WorkspaceSandboxLease | null {
  if (state.kind !== "session") {
    return null;
  }

  const expiresAtMs = Date.parse(state.lease.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return null;
  }

  const remainingMs = Math.max(0, expiresAtMs - Date.now());
  if (remainingMs <= 0) {
    return null;
  }

  return {
    sandboxId: state.sandboxId,
    observedAt: state.lease.observedAt,
    expiresAt: state.lease.expiresAt,
    remainingMs,
  };
}

export function isWorkspaceSessionStateExpired(
  state: WorkspaceSandboxState,
  nowMs = Date.now(),
): boolean {
  if (state.kind !== "session") {
    return false;
  }

  return Date.parse(state.lease.expiresAt) <= nowMs;
}

export function transitionToCold(at = new Date().toISOString()): WorkspaceSandboxTransition {
  const nextState: WorkspaceSandboxState = { kind: "cold" };

  return {
    nextState,
    patch: {
      metadata: asWorkspaceSandboxStateMetadata(nextState),
      sandboxId: null,
      lastResumedAt: at,
    },
  };
}

export function transitionToSession(
  sandboxId: string,
  lease: SandboxSessionLease,
  sessionPolicy?: WorkspacePolicy,
): WorkspaceSandboxTransition {
  const nextState: WorkspaceSandboxState = {
    kind: "session",
    sandboxId,
    lease,
    sessionPolicy,
  };

  return {
    nextState,
    patch: {
      metadata: asWorkspaceSandboxStateMetadata(nextState),
      sandboxId,
      lastResumedAt: lease.observedAt,
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
