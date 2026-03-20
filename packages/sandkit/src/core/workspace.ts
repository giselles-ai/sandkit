import type { WorkspaceRecord } from "../types.ts";
import type { SandkitContext } from "./context.ts";
import { LazySandboxHandle, ManagedSandbox, WorkspaceSandboxHandle } from "./sandbox.ts";
import type { SandboxCommit, WorkspaceSandboxState } from "./workspace-state.ts";
import {
  readWorkspaceSandboxState,
  persistSandboxTransition,
  toDriverResumeState,
  type WorkspaceSandboxTransition,
  transitionAfterCommandCommit,
  transitionToSession,
} from "./workspace-state.ts";

export interface PublicWorkspaceHandle {
  readonly id: string;
  readonly record: WorkspaceRecord;
  readonly sandbox: WorkspaceSandboxHandle;
}

export class WorkspaceHandle implements PublicWorkspaceHandle {
  readonly #ctx: SandkitContext;
  #record: WorkspaceRecord;
  #sandboxState: WorkspaceSandboxState;
  #lazySandbox?: WorkspaceSandboxHandle;

  constructor(ctx: SandkitContext, record: WorkspaceRecord) {
    this.#ctx = ctx;
    this.#record = record;
    this.#sandboxState = readWorkspaceSandboxState(record);
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
    const sandbox = await this.resolveSandboxDriver(workspace);
    await this.persistSandboxState(transitionToSession(sandbox.id, new Date().toISOString()));

    return new ManagedSandbox(sandbox, async (commit: SandboxCommit) => {
      const next = transitionAfterCommandCommit(commit, new Date().toISOString());
      await this.persistSandboxState(next);
    });
  }

  private async resolveSandboxDriver(workspace: WorkspaceRecord) {
    const resumeState = toDriverResumeState(this.#sandboxState);
    return resumeState
      ? await this.#ctx.driverFactory.resumeSandbox(workspace, resumeState)
      : await this.#ctx.driverFactory.createSandbox(workspace);
  }

  private async persistSandboxState(transition: WorkspaceSandboxTransition): Promise<void> {
    const result = await persistSandboxTransition(
      this.#ctx.adapter.workspaces,
      this.#record.id,
      transition,
    );
    this.#record = result.record;
    this.#sandboxState = result.state;
  }

  private async resolveLatestWorkspace(): Promise<WorkspaceRecord> {
    const latest = await this.#ctx.adapter.workspaces.getWorkspace(this.#record.id);
    if (!latest) {
      throw new Error(`Workspace with id "${this.#record.id}" no longer exists`);
    }
    this.#record = latest;
    this.#sandboxState = readWorkspaceSandboxState(latest);
    return latest;
  }
}
