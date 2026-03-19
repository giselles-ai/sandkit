import type { SandkitAdapter, WorkspaceCreateInput, WorkspaceRecord } from "./adapters/types.ts";
import type { NetworkPolicy } from "./policies/types.ts";

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

export type { SandkitAdapter, WorkspaceCreateInput, WorkspaceRecord };
export type { NetworkPolicy };

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface PersistedSandboxState {
  readonly kind: string;
  readonly sessionId: string;
  readonly state?: JsonValue;
}

export interface SandboxDriver {
  readonly id: string;
  runCommand(command: string, args: string[]): Promise<CommandResult>;
  snapshot(): Promise<PersistedSandboxState>;
}

export interface SandboxDriverFactory {
  createSandbox(workspace: WorkspaceRecord): Promise<SandboxDriver>;
  resumeSandbox(
    workspace: WorkspaceRecord,
    snapshot: PersistedSandboxState,
  ): Promise<SandboxDriver>;
}

export interface SandkitOptions {
  readonly database?: SandkitAdapter | undefined;
  readonly network?: NetworkPolicy[] | undefined;
  readonly sandbox?:
    | {
        readonly driverFactory?: SandboxDriverFactory | undefined;
      }
    | undefined;
}
