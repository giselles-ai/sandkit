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
  /**
   * Accesses the same normalized log stream used by onStdout/onStderr callbacks.
   * Sandkit keeps a single internal stream, so callbacks and logs() observe
   * the same sequence and buffered historical chunks are replayed to new readers.
   */
  logs?: () => AsyncIterable<WorkspaceSessionLog>;
}

export interface WorkspaceSessionLog {
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
}

export interface WorkspaceSessionProcessStartInput {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Optional per-call policy override for this session process.
   */
  readonly policy?: WorkspacePolicy;
  /**
   * Callbacks consume chunks from Sandkit's normalized process log stream.
   */
  readonly onStdout?: ((chunk: string) => void) | undefined;
  /**
   * Callbacks consume chunks from Sandkit's normalized process log stream.
   */
  readonly onStderr?: ((chunk: string) => void) | undefined;
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
  /**
   * Returns lease timing observed from the current sandbox instance.
   * Some providers expose this as an interpreted timeout value.
   * Sandkit persists lease updates only from explicit session open/extend paths,
   * so callers should not treat mere reads as lease refreshes.
   */
  getSessionLease(): Promise<SandboxSessionLease>;
  runCommand(command: string, args: string[]): Promise<CommandResult>;
  startProcess?(input: WorkspaceSessionProcessStartInput): Promise<WorkspaceSessionProcess>;
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
  readonly network?: readonly unknown[] | undefined;
  readonly sandbox?:
    | {
        readonly driverFactory?: SandboxDriverFactory | undefined;
      }
    | undefined;
}
