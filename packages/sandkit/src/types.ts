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
  runCommand(command: string, args: string[]): Promise<CommandResult>;
  snapshot(): Promise<PersistedSandboxState>;
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
