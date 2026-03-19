export type WorkspaceStatus = "active" | "inactive" | "archived";

export interface WorkspaceMetadata {
  [key: string]: unknown;
}

export interface WorkspaceRecord {
  id: string;
  name?: string;
  metadata?: WorkspaceMetadata;
  status: WorkspaceStatus;
  sandboxId?: string;
  lastResumedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCreateInput {
  id?: string;
  name?: string;
  metadata?: WorkspaceMetadata;
  status?: WorkspaceStatus;
  sandboxId?: string;
  lastResumedAt?: string;
}

export interface WorkspaceUpdateInput {
  name?: string;
  metadata?: WorkspaceMetadata;
  status?: WorkspaceStatus;
  sandboxId?: string | null;
  lastResumedAt?: string | null;
}

export interface WorkspaceAdapter {
  createWorkspace(input?: WorkspaceCreateInput): Promise<WorkspaceRecord>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  updateWorkspace(id: string, input: WorkspaceUpdateInput): Promise<WorkspaceRecord>;
}

export interface SandkitAdapter {
  readonly id: string;
  readonly workspaces: WorkspaceAdapter;
}
