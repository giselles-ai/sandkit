import type { WorkspaceRecord } from "../types.ts";
import type { SandkitContext } from "./context.ts";
import { LazySandboxHandle, ManagedSandbox, WorkspaceSandboxHandle } from "./sandbox.ts";
import type { SandboxCommit, WorkspaceSandboxState } from "./workspace-state.ts";
import {
  readWorkspaceSandboxState,
  toDriverResumeState,
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
    const resumeState = toDriverResumeState(this.#sandboxState);
    const sandbox = resumeState
      ? await this.#ctx.driverFactory.resumeSandbox(workspace, resumeState)
      : await this.#ctx.driverFactory.createSandbox(workspace);

    const now = new Date().toISOString();
    const transition = transitionToSession(sandbox.id, now);
    this.#record = await this.#ctx.adapter.workspaces.updateWorkspace(
      workspace.id,
      transition.patch,
    );
    this.#sandboxState = transition.nextState;

    return new ManagedSandbox(sandbox, async (commit: SandboxCommit) => {
      const next = transitionAfterCommandCommit(commit, new Date().toISOString());
      this.#record = await this.#ctx.adapter.workspaces.updateWorkspace(
        this.#record.id,
        next.patch,
      );
      this.#sandboxState = next.nextState;
    });
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
