import type { WorkspaceRecord } from "../types.ts";
import type { SandkitContext } from "./context.ts";
import { LazySandboxHandle, ManagedSandbox, WorkspaceSandboxHandle } from "./sandbox.ts";
import { readPersistedSandboxState, writePersistedSandboxState } from "./workspace-state.ts";

export interface PublicWorkspaceHandle {
  readonly id: string;
  readonly record: WorkspaceRecord;
  readonly sandbox: WorkspaceSandboxHandle;
}

export class WorkspaceHandle implements PublicWorkspaceHandle {
  readonly #ctx: SandkitContext;
  #record: WorkspaceRecord;
  #lazySandbox?: WorkspaceSandboxHandle;

  constructor(ctx: SandkitContext, record: WorkspaceRecord) {
    this.#ctx = ctx;
    this.#record = record;
  }

  get id(): string {
    return this.#record.id;
  }

  get record(): WorkspaceRecord {
    return this.#record;
  }

  get sandbox(): LazySandboxHandle {
    if (!this.#lazySandbox) {
      this.#lazySandbox = new LazySandboxHandle(() => this.createOrResumeSandbox());
    }
    return this.#lazySandbox;
  }

  /**
   * Internal API. Public callers should use `workspace.sandbox.runCommand(...)`.
   */
  async createOrResumeSandbox(): Promise<ManagedSandbox> {
    const workspace = await this.resolveLatestWorkspace();
    const persistedSandbox = readPersistedSandboxState(workspace);
    const sandbox = persistedSandbox
      ? await this.#ctx.driverFactory.resumeSandbox(workspace, persistedSandbox)
      : await this.#ctx.driverFactory.createSandbox(workspace);

    this.#record = await this.#ctx.adapter.workspaces.updateWorkspace(workspace.id, {
      lastResumedAt: new Date().toISOString(),
      metadata: writePersistedSandboxState(workspace, {
        kind: persistedSandbox?.kind ?? "sandbox-session",
        sessionId: sandbox.id,
      }),
      sandboxId: sandbox.id,
    });

    return new ManagedSandbox(this.#ctx, this.#record, sandbox, (record) => {
      this.#record = record;
    });
  }

  private async resolveLatestWorkspace(): Promise<WorkspaceRecord> {
    const latest = await this.#ctx.adapter.workspaces.getWorkspace(this.#record.id);
    if (!latest) {
      throw new Error(`Workspace with id "${this.#record.id}" no longer exists`);
    }
    this.#record = latest;
    return latest;
  }
}
