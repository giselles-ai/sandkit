import type {
  RunFinishInput as AdapterRunFinishInput,
  SandboxDriver,
  SandboxSessionLease,
  WorkspacePolicy,
  WorkspaceRecord,
  WorkspaceSandboxLease,
} from "../types.ts";
import type { SandkitContext } from "./context.ts";
import {
  LazySandboxHandle,
  ManagedSandbox,
  ManagedSession,
  type WorkspaceSessionHandle,
  type WorkspaceSandboxHandle,
} from "./sandbox.ts";
import {
  asPolicySnapshotConfig,
  asWorkspacePolicyPatch,
  describeWorkspacePolicyId,
  readWorkspacePolicy,
} from "./workspace-policy.ts";
import type { SandboxCommit, WorkspaceSandboxState } from "./workspace-state.ts";
import {
  isWorkspaceSessionStateExpired,
  persistSandboxTransition,
  readWorkspaceSandboxLease,
  readWorkspaceSandboxState,
  toDriverResumeState,
  transitionAfterCommandCommit,
  transitionToCold,
  transitionToSession,
  type WorkspaceSandboxTransition,
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
      this.#lazySandbox = new LazySandboxHandle(
        () => this.createOrResumeSandboxForCommand(),
        () => this.openSession(),
        () => this.attachSession(),
        () => this.getActiveLease(),
      );
    }

    return this.#lazySandbox;
  }

  async setPolicy(policy: WorkspacePolicy): Promise<void> {
    await this.resolveLatestWorkspace();
    const result = await this.#ctx.adapter.workspaces.updateWorkspace(
      this.#record.id,
      asWorkspacePolicyPatch(policy),
    );
    this.#record = result;
    this.#sandboxState = readWorkspaceSandboxState(result);
  }

  async getActiveLease(): Promise<WorkspaceSandboxLease | null> {
    await this.resolveLatestWorkspace();
    const sandbox = await this.resolveAttachableSession();
    if (!sandbox) {
      return null;
    }

    return readWorkspaceSandboxLease(this.#record);
  }

  async createOrResumeSandboxForCommand(): Promise<ManagedSandbox> {
    const workspace = await this.resolveLatestWorkspace();
    if (await this.resolveAttachableSession()) {
      throw new Error(
        "Cannot run command while a sandbox session is active. Use attachSession() to reuse it or commit the session first.",
      );
    }

    const sandbox = await this.resolveSandboxDriver(workspace);

    return new ManagedSandbox(
      sandbox,
      async () => this.resolveDefaultPolicy(),
      async (commit: SandboxCommit) =>
        this.persistSandboxState(transitionAfterCommandCommit(commit, new Date().toISOString())),
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

  async openSession(): Promise<WorkspaceSessionHandle> {
    const workspace = await this.resolveLatestWorkspace();
    if (await this.resolveAttachableSession()) {
      throw new Error("A sandbox session is already active for this workspace.");
    }

    const sandbox = await this.resolveSandboxDriver(workspace);
    const lease = await sandbox.getSessionLease();
    await this.persistSandboxState(transitionToSession(sandbox.id, lease));

    return this.makeSession(sandbox);
  }

  async attachSession(): Promise<WorkspaceSessionHandle> {
    await this.resolveLatestWorkspace();
    const sandbox = await this.resolveAttachableSession();
    if (!sandbox) {
      throw new Error("There is no active sandbox session to attach for this workspace.");
    }

    return this.makeSession(sandbox);
  }

  private makeSession(sandbox: SandboxDriver): ManagedSession {
    return new ManagedSession(
      sandbox,
      async () => this.resolveDefaultPolicy(),
      async (commit: SandboxCommit) =>
        this.persistSandboxState(transitionAfterCommandCommit(commit, new Date().toISOString())),
      {
        assertActive: async () => {
          const activeSandbox = await this.resolveAttachableSession();
          if (!activeSandbox || activeSandbox.id !== sandbox.id) {
            throw new Error("This sandbox session is no longer active.");
          }
        },
      },
      {
        onLeaseRefresh: async () => {
          const lease = await sandbox.getSessionLease();
          await this.refreshSessionLease(sandbox.id, lease);
        },
      },
    );
  }

  private async refreshSessionLease(sandboxId: string, lease: SandboxSessionLease): Promise<void> {
    await this.resolveLatestWorkspace();
    if (
      !workspaceStateIsSession(this.#sandboxState) ||
      this.#sandboxState.sandboxId !== sandboxId
    ) {
      throw new Error("Cannot refresh lease for an inactive sandbox session.");
    }

    await this.persistSandboxState(transitionToSession(sandboxId, lease));
  }

  private async resolveAttachableSession(): Promise<SandboxDriver | null> {
    if (!workspaceStateIsSession(this.#sandboxState)) {
      return null;
    }

    if (isWorkspaceSessionStateExpired(this.#sandboxState)) {
      await this.persistSandboxState(transitionToCold());
      return null;
    }

    try {
      const sandbox = await this.resolveSandboxDriver(this.#record);
      const lease = await sandbox.getSessionLease();
      await this.persistSandboxState(transitionToSession(sandbox.id, lease));
      return sandbox;
    } catch (error) {
      if (!this.#ctx.driverFactory.isSessionUnavailableError?.(error)) {
        throw error;
      }

      await this.persistSandboxState(transitionToCold());
      return null;
    }
  }

  private async resolveSandboxDriver(workspace: WorkspaceRecord): Promise<SandboxDriver> {
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
    if (isWorkspaceSessionStateExpired(this.#sandboxState)) {
      const result = await persistSandboxTransition(
        this.#ctx.adapter.workspaces,
        this.#record.id,
        transitionToCold(),
      );
      this.#record = result.record;
      this.#sandboxState = result.state;
    }

    return this.#record;
  }

  private async createPolicySnapshot(policy: WorkspacePolicy) {
    return this.#ctx.adapter.policySnapshots.createPolicySnapshot({
      workspaceId: this.#record.id,
      policyId: describeWorkspacePolicyId(policy),
      config: asPolicySnapshotConfig(policy),
    });
  }

  private async resolveDefaultPolicy(): Promise<WorkspacePolicy> {
    const workspace = await this.resolveLatestWorkspace();
    return readWorkspacePolicy(workspace, this.#ctx.defaultPolicy);
  }
}

function workspaceStateIsSession(
  state: WorkspaceSandboxState,
): state is Extract<WorkspaceSandboxState, { kind: "session" }> {
  return state.kind === "session";
}
