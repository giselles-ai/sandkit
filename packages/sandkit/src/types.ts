import type { SandkitAdapter, WorkspaceCreateInput, WorkspaceRecord } from "./adapters/types.ts";
import type {
  PolicySnapshotAdapter,
  PolicySnapshotRecord,
  PolicySnapshotCreateInput,
  RunAdapter,
  RunCreateInput,
  RunFinishInput,
  RunRecord,
  RunStatus,
} from "./adapters/types.ts";
import type { WorkspacePolicy } from "./policies/types.ts";

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

export type {
  SandkitAdapter,
  WorkspaceCreateInput,
  WorkspaceRecord,
  RunAdapter,
  RunCreateInput,
  RunFinishInput,
  RunRecord,
  PolicySnapshotAdapter,
  PolicySnapshotRecord,
  PolicySnapshotCreateInput,
  RunStatus,
};
export type { WorkspacePolicy };

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface SandboxSessionLease {
  readonly sandboxId: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface WorkspaceSandboxLease {
  readonly sandboxId: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly remainingMs: number;
}

export interface WorkspaceSessionProcess {
  readonly processId: string;
  wait(): Promise<CommandResult>;
}

export interface SandboxRunCommandOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly policy?: WorkspacePolicy;
}

export interface PersistedSandboxState {
  readonly kind: string;
  readonly sessionId: string;
  readonly state?: JsonValue;
}

export interface SandboxDriver {
  readonly id: string;
  readonly provider: string;
  applyPolicy(policy: WorkspacePolicy): Promise<void>;
  /** Returns live session information for the current sandbox instance. */
  getSessionLease(): Promise<SandboxSessionLease>;
  runCommand(command: string, args: string[]): Promise<CommandResult>;
  startProcess?(command: string, args: string[]): Promise<WorkspaceSessionProcess>;
  /** Persists and restores durability state through commit() and attach/restore APIs. */
  snapshot(): Promise<PersistedSandboxState>;
  url?(port: number): Promise<string>;
  extendTimeout?(durationMs: number): Promise<void>;
}

export interface SandboxCreateOptions {
  readonly policy: WorkspacePolicy;
}

export interface SandboxDriverFactory {
  createSandbox(workspace: WorkspaceRecord, options: SandboxCreateOptions): Promise<SandboxDriver>;
  resumeSandbox(
    workspace: WorkspaceRecord,
    snapshot: PersistedSandboxState,
    options: SandboxCreateOptions,
  ): Promise<SandboxDriver>;
  isSessionUnavailableError?(error: unknown): boolean;
}

export interface SandkitOptions {
  readonly database?: SandkitAdapter | undefined;
  readonly policy?: WorkspacePolicy | undefined;
  readonly network?: readonly unknown[] | undefined;
  readonly sandbox?:
    | {
        readonly driverFactory?: SandboxDriverFactory | undefined;
      }
    | undefined;
}
