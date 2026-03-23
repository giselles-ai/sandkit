import { createId } from "../core/ids.ts";
import type {
  WorkspaceAdapter,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceUpdateInput,
  SandkitAdapter,
  SharedSetupState,
  SetupStateRecord,
  SetupStatePutInput,
  RunAdapter,
  RunCreateInput,
  RunFinishInput,
  RunRecord,
  PolicySnapshotAdapter,
  PolicySnapshotCreateInput,
  PolicySnapshotRecord,
} from "./types";

const defaultWorkspaceStatus = "active";
const defaultWorkspaceName = "default";
const defaultRunStatus = "started" as const;

const getNow = () => new Date().toISOString();

function cloneSetupStateValue(value: SharedSetupState["state"]): SharedSetupState["state"] {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return [...value];
  }

  if (typeof value === "object" && value !== null) {
    return { ...value } as SharedSetupState["state"];
  }

  return value;
}

function normalizeWorkspaceRecord(workspace: WorkspaceRecord): WorkspaceRecord {
  return {
    ...workspace,
    metadata: workspace.metadata && { ...workspace.metadata },
  };
}

const mergeMetadata = (
  existing: WorkspaceRecord["metadata"],
  next?: WorkspaceRecord["metadata"],
) => {
  if (typeof next === "undefined") {
    return existing;
  }
  if (existing === undefined || existing === null) {
    return { ...next };
  }
  return { ...existing, ...next };
};

function createMemorySetupStatesAdapter(): {
  getSetupState: (id: string) => Promise<SetupStateRecord | null>;
  putSetupState: (input: SetupStatePutInput) => Promise<SetupStateRecord>;
  deleteSetupState: (id: string) => Promise<void>;
} {
  const setupStates = new Map<string, SetupStateRecord>();

  return {
    async getSetupState(id: string) {
      const state = setupStates.get(id);
      if (!state) {
        return null;
      }

      return {
        id: state.id,
        state: {
          kind: state.state.kind,
          sessionId: state.state.sessionId,
          state: cloneSetupStateValue(state.state.state),
        },
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      };
    },
    async putSetupState(input: SetupStatePutInput) {
      const now = getNow();
      const existing = setupStates.get(input.id);
      const next: SetupStateRecord = existing
        ? {
            ...existing,
            state: {
              kind: input.state.kind,
              sessionId: input.state.sessionId,
              state: cloneSetupStateValue(input.state.state),
            },
            updatedAt: now,
          }
        : {
            id: input.id,
            state: {
              kind: input.state.kind,
              sessionId: input.state.sessionId,
              state: cloneSetupStateValue(input.state.state),
            },
            createdAt: now,
            updatedAt: now,
          };

      setupStates.set(input.id, next);
      return next;
    },
    async deleteSetupState(id: string) {
      setupStates.delete(id);
    },
  };
}

function createMemoryRunAdapter(): RunAdapter {
  const runs = new Map<string, RunRecord>();

  return {
    async createRun(input: RunCreateInput): Promise<RunRecord> {
      const now = getNow();
      const normalizedId =
        input.id?.trim() && input.id.trim().length > 0 ? input.id.trim() : createId("run");

      const run: RunRecord = {
        id: normalizedId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        executionTargetId: input.executionTargetId,
        command: input.command,
        args: input.args ?? [],
        status: input.status ?? defaultRunStatus,
        startedAt: input.startedAt ?? now,
        policySnapshotId: input.policySnapshotId ?? undefined,
      };

      runs.set(normalizedId, run);
      return { ...run, args: run.args ? [...run.args] : run.args };
    },
    async finishRun(id: string, input: RunFinishInput): Promise<RunRecord> {
      const current = runs.get(id);
      if (!current) {
        throw new Error(`Run with id "${id}" does not exist`);
      }

      const next: RunRecord = {
        ...current,
        status: input.status,
        finishedAt: input.finishedAt,
        exitCode: input.exitCode ?? current.exitCode,
        stdout: input.stdout ?? current.stdout,
        stderr: input.stderr ?? current.stderr,
        providerCommit: input.providerCommit,
        policySnapshotId: current.policySnapshotId,
      };

      runs.set(id, next);
      return { ...next, args: next.args ? [...next.args] : next.args };
    },
  };
}

function createMemoryPolicySnapshotAdapter(): PolicySnapshotAdapter {
  const policySnapshots = new Map<string, PolicySnapshotRecord>();

  return {
    async createPolicySnapshot(input: PolicySnapshotCreateInput): Promise<PolicySnapshotRecord> {
      const now = getNow();
      const normalizedId =
        input.id?.trim() && input.id.trim().length > 0
          ? input.id.trim()
          : createId("policy-snapshot");

      if (policySnapshots.has(normalizedId)) {
        throw new Error(`Policy snapshot with id "${normalizedId}" already exists`);
      }

      const snapshot: PolicySnapshotRecord = {
        id: normalizedId,
        workspaceId: input.workspaceId,
        policyId: input.policyId,
        config: input.config,
        createdAt: input.createdAt ?? now,
      };

      policySnapshots.set(normalizedId, snapshot);
      return { ...snapshot, config: snapshot.config };
    },
  };
}

function createMemoryWorkspaceAdapter(): WorkspaceAdapter {
  const workspaces = new Map<string, WorkspaceRecord>();

  return {
    async createWorkspace(input: WorkspaceCreateInput = {}) {
      const now = getNow();
      const normalizedId =
        input.id?.trim() && input.id.trim().length > 0 ? input.id.trim() : createId("workspace");

      if (workspaces.has(normalizedId)) {
        throw new Error(`Workspace with id "${normalizedId}" already exists`);
      }

      const workspace: WorkspaceRecord = {
        id: normalizedId,
        name: input.name ?? defaultWorkspaceName,
        status: input.status ?? defaultWorkspaceStatus,
        metadata: input.metadata ? { ...input.metadata } : undefined,
        sandboxId: input.sandboxId === "" ? undefined : input.sandboxId?.trim() || undefined,
        lastResumedAt: input.lastResumedAt,
        createdAt: now,
        updatedAt: now,
      };
      workspaces.set(normalizedId, workspace);
      return normalizeWorkspaceRecord(workspace);
    },
    async getWorkspace(id: string) {
      const workspace = workspaces.get(id);
      return workspace ? normalizeWorkspaceRecord(workspace) : null;
    },
    async updateWorkspace(id: string, input: WorkspaceUpdateInput) {
      const current = workspaces.get(id);
      if (!current) {
        throw new Error(`Workspace with id "${id}" does not exist`);
      }

      const next: WorkspaceRecord = {
        ...current,
        metadata: mergeMetadata(current.metadata, input.metadata),
        name: input.name ?? current.name,
        status: input.status ?? current.status,
        sandboxId: input.sandboxId === null ? undefined : (input.sandboxId ?? current.sandboxId),
        lastResumedAt:
          input.lastResumedAt === null ? undefined : (input.lastResumedAt ?? current.lastResumedAt),
        updatedAt: getNow(),
      };

      workspaces.set(id, next);
      return normalizeWorkspaceRecord(next);
    },
  };
}

export const createMemoryAdapter = (): SandkitAdapter => ({
  id: "memory",
  workspaces: createMemoryWorkspaceAdapter(),
  setupStates: createMemorySetupStatesAdapter(),
  runs: createMemoryRunAdapter(),
  policySnapshots: createMemoryPolicySnapshotAdapter(),
});
