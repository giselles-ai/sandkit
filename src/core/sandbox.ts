import type {
  CommandResult,
  PersistedSandboxState,
  SandboxDriver,
  WorkspaceRecord,
} from "../types.ts";
import type { SandkitContext } from "./context.ts";
import { writePersistedSandboxState } from "./workspace-state.ts";

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
    return this.withManagedExecution("runCommand", async () => {
      this.ensureCommandShape(command, args);
      return this.#driver.runCommand(command, args);
    });
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

  private async persistSnapshot(): Promise<void> {
    const snapshot = await this.#driver.snapshot();
    this.#workspace = await this.#ctx.adapter.workspaces.updateWorkspace(this.#workspace.id, {
      metadata: writePersistedSandboxState(this.#workspace, snapshot),
      sandboxId: snapshot.sessionId,
    });
    this.#onWorkspaceUpdate?.(this.#workspace);
  }

  private async withManagedExecution<T>(_action: string, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      await this.persistSnapshot();
      return result;
    } catch (error) {
      await this.persistSnapshot();
      throw error;
    }
  }
}
