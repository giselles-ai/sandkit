import type {
  WorkspaceAdapter,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceUpdateInput,
  SandkitAdapter,
} from "./types";

const defaultWorkspaceStatus = "active";
const defaultWorkspaceName = "default";

const getNow = () => new Date().toISOString();

const normalizeWorkspace = (workspace: WorkspaceRecord): WorkspaceRecord => ({
  ...workspace,
  metadata: workspace.metadata && { ...workspace.metadata },
});

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

const createId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

function createMemoryWorkspaceAdapter(): WorkspaceAdapter {
  const workspaces = new Map<string, WorkspaceRecord>();

  return {
    async createWorkspace(input: WorkspaceCreateInput = {}) {
      const now = getNow();
      const normalizedId =
        input.id?.trim() && input.id?.trim().length > 0 ? input.id.trim() : createId();

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
      return normalizeWorkspace(workspace);
    },
    async getWorkspace(id: string) {
      const workspace = workspaces.get(id);
      return workspace ? normalizeWorkspace(workspace) : null;
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
      return normalizeWorkspace(next);
    },
  };
}

export const createMemoryAdapter = (): SandkitAdapter => ({
  id: "memory",
  workspaces: createMemoryWorkspaceAdapter(),
});
