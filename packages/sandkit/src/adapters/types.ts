import type { WorkspacePolicy } from "../policies/types.ts";

export type WorkspaceStatus = "active" | "inactive" | "archived";
export type RunStatus = "started" | "succeeded" | "failed";

export interface WorkspaceMetadata {
  [key: string]: unknown;
}

export type SharedSetupStateValue =
  | null
  | boolean
  | number
  | string
  | SharedSetupStateValue[]
  | { [key: string]: SharedSetupStateValue };

export interface SharedSetup {
  readonly command: string;
  readonly args?: readonly string[];
  /**
   * Shared setup state is durable and reused across workspaces, so this policy
   * must also be durable. Explicit secret-bearing policies are rejected.
   */
  readonly policy?: WorkspacePolicy;
}

/**
 * Internal durable artifact produced by a successful shared bootstrap.
 */
export interface SharedSetupState {
  readonly kind: string;
  readonly sessionId: string;
  readonly state?: SharedSetupStateValue;
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
  policy?: WorkspacePolicy;
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

export interface SetupStateRecord {
  readonly id: string;
  readonly state: SharedSetupState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SetupStatePutInput {
  readonly id: string;
  readonly state: SharedSetupState;
}

export interface SetupStateAdapter {
  getSetupState(id: string): Promise<SetupStateRecord | null>;
  putSetupState(input: SetupStatePutInput): Promise<SetupStateRecord>;
  deleteSetupState(id: string): Promise<void>;
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
  readonly setupStates: SetupStateAdapter;
  readonly runs: RunAdapter;
  readonly policySnapshots: PolicySnapshotAdapter;
}
