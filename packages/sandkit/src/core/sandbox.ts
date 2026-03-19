import type {
  CommandResult,
  PersistedSandboxState,
  SandboxDriver,
  WorkspaceRecord,
} from "../types.ts";
import type { SandkitContext } from "./context.ts";
import { writePersistedSandboxState } from "./workspace-state.ts";

export interface WorkspaceSandboxHandle {
  runCommand(command: string, args: string[]): Promise<CommandResult>;
}

export class ManagedSandbox {
  readonly #ctx: SandkitContext;
  readonly #driver: SandboxDriver;
  #workspace: WorkspaceRecord;
  readonly #onWorkspaceUpdate?: ((workspace: WorkspaceRecord) => void) | undefined;

  constructor(
    ctx: SandkitContext,
    workspace: WorkspaceRecord,
    driver: SandboxDriver,
    onWorkspaceUpdate?: (workspace: WorkspaceRecord) => void,
  ) {
    this.#ctx = ctx;
    this.#workspace = workspace;
    this.#driver = driver;
    this.#onWorkspaceUpdate = onWorkspaceUpdate;
  }

  get id(): string {
    return this.#driver.id;
  }

  async runCommand(command: string, args: string[]): Promise<CommandResult> {
    this.ensureCommandShape(command, args);
    try {
      const result = await this.#driver.runCommand(command, args);
      await this.persistDurableState();
      return result;
    } catch (error) {
      await this.persistDurableState();
      throw error;
    }
  }

  async snapshot(): Promise<PersistedSandboxState> {
    return this.#driver.snapshot();
  }

  private ensureCommandShape(command: string, args: string[]): void {
    if (!command.trim()) {
      throw new Error("Sandbox command must not be empty.");
    }

    if (!Array.isArray(args)) {
      throw new Error("Sandbox command arguments must be an array.");
    }
  }

  private async persistDurableState(): Promise<void> {
    const snapshot = await this.#driver.snapshot();
    this.#workspace = await this.#ctx.adapter.workspaces.updateWorkspace(this.#workspace.id, {
      metadata: writePersistedSandboxState(this.#workspace, snapshot),
      sandboxId: snapshot.sessionId,
    });
    this.#onWorkspaceUpdate?.(this.#workspace);
  }
}

export class LazySandboxHandle implements WorkspaceSandboxHandle {
  readonly #resolveSandbox: () => Promise<ManagedSandbox>;

  constructor(resolveSandbox: () => Promise<ManagedSandbox>) {
    this.#resolveSandbox = resolveSandbox;
  }

  async runCommand(command: string, args: string[]): Promise<CommandResult> {
    const sandbox = await this.#resolveSandbox();
    return sandbox.runCommand(command, args);
  }
}
