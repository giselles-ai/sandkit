import type {
  RunFinishInput as AdapterRunFinishInput,
  WorkspacePolicy,
  WorkspaceRecord,
} from "../types.ts";
import type { SandkitContext } from "./context.ts";
import { LazySandboxHandle, ManagedSandbox } from "./sandbox.ts";
import type { WorkspaceSandboxHandle } from "./sandbox.ts";
import {
  readWorkspacePolicy,
  asWorkspacePolicyPatch,
  describeWorkspacePolicyId,
} from "./workspace-policy.ts";
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
  setPolicy(policy: WorkspacePolicy): Promise<void>;
}

interface RunFinishInput extends AdapterRunFinishInput {
  runId: string;
}

export class WorkspaceHandle implements PublicWorkspaceHandle {
  readonly #ctx: SandkitContext;
  #record: WorkspaceRecord;
  #sandboxState: WorkspaceSandboxState;
  #lazySandbox?: LazySandboxHandle;

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

  async setPolicy(policy: WorkspacePolicy): Promise<void> {
    const latest = await this.resolveLatestWorkspace();
    void latest;
    const result = await this.#ctx.adapter.workspaces.updateWorkspace(
      this.#record.id,
      asWorkspacePolicyPatch(policy),
    );
    this.#record = result;
    this.#sandboxState = readWorkspaceSandboxState(result);
  }

  /**
   * Internal API. Public callers should use `workspace.sandbox.runCommand(...)`.
   */
  async createOrResumeSandbox(): Promise<ManagedSandbox> {
    const workspace = await this.resolveLatestWorkspace();
    const sandbox = await this.resolveSandboxDriver(workspace);
    await this.persistSandboxState(transitionToSession(sandbox.id, new Date().toISOString()));

    return new ManagedSandbox(
      sandbox,
      async () => this.resolveDefaultPolicy(),
      async (commit: SandboxCommit) => {
        const next = transitionAfterCommandCommit(commit, new Date().toISOString());
        await this.persistSandboxState(next);
      },
      {
        onRunStart: async (input) => {
          const policySnapshot = await this.createPolicySnapshot(input.effectivePolicy);
          const run = await this.#ctx.adapter.runs.createRun({
            workspaceId: this.#record.id,
            provider: sandbox.provider,
            executionTargetId: sandbox.id,
            command: input.command,
            args: input.args,
            status: "started",
            startedAt: input.startedAt,
            policySnapshotId: policySnapshot.id,
          });

          return run.id;
        },
        onRunFinish: async (input: RunFinishInput) => {
          await this.#ctx.adapter.runs.finishRun(input.runId, {
            status: input.status,
            finishedAt: input.finishedAt,
            exitCode: input.exitCode ?? null,
            stdout: input.stdout ?? null,
            stderr: input.stderr ?? null,
            providerCommit: input.providerCommit,
          });
        },
      },
    );
  }

  private async resolveSandboxDriver(workspace: WorkspaceRecord) {
    const policy = readWorkspacePolicy(workspace, this.#ctx.defaultPolicy);
    const resumeState = toDriverResumeState(this.#sandboxState);
    return resumeState
      ? await this.#ctx.driverFactory.resumeSandbox(workspace, resumeState, { policy })
      : await this.#ctx.driverFactory.createSandbox(workspace, { policy });
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

  private async createPolicySnapshot(policy: WorkspacePolicy) {
    return this.#ctx.adapter.policySnapshots.createPolicySnapshot({
      workspaceId: this.#record.id,
      policyId: describeWorkspacePolicyId(policy),
      config: policy,
    });
  }

  private async resolveDefaultPolicy(): Promise<WorkspacePolicy> {
    const workspace = await this.resolveLatestWorkspace();
    return readWorkspacePolicy(workspace, this.#ctx.defaultPolicy);
  }
}
