export type WorkspaceStatus = "active" | "inactive" | "archived";
export type RunStatus = "started" | "succeeded" | "failed";

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

export interface RunRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly executionTargetId: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly status: RunStatus;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly policySnapshotId?: string;
  readonly providerCommit?: unknown;
}

export interface RunCreateInput {
  id?: string;
  workspaceId: string;
  provider: string;
  executionTargetId: string;
  command: string;
  args?: readonly string[] | null;
  status?: RunStatus;
  startedAt?: string;
  policySnapshotId?: string | null;
}

export interface RunFinishInput {
  status: RunStatus;
  finishedAt: string;
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  providerCommit?: unknown;
}

export interface PolicySnapshotRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly policyId: string;
  readonly config: unknown;
  readonly createdAt: string;
}

export interface PolicySnapshotCreateInput {
  id?: string;
  workspaceId: string;
  policyId: string;
  config: unknown;
  createdAt?: string;
}

export interface RunAdapter {
  createRun(input: RunCreateInput): Promise<RunRecord>;
  finishRun(id: string, input: RunFinishInput): Promise<RunRecord>;
}

export interface PolicySnapshotAdapter {
  createPolicySnapshot(input: PolicySnapshotCreateInput): Promise<PolicySnapshotRecord>;
}

export interface SandkitAdapter {
  readonly id: string;
  readonly workspaces: WorkspaceAdapter;
  readonly runs: RunAdapter;
  readonly policySnapshots: PolicySnapshotAdapter;
}
