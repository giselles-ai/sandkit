import { allowAll } from "../policies/dsl.ts";
import type {
  RunFinishInput as AdapterRunFinishInput,
  SandboxDriver,
  SandboxSessionLease,
  WorkspacePolicy,
  WorkspaceRecord,
  WorkspaceSandboxLease,
  PersistedSandboxState,
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

function setupStateFingerprint(command: string, args: readonly string[]): string {
  return encodeURIComponent(JSON.stringify({ command, args }));
}

export const sharedSetupStateId = (
  adapterId: string,
  setup: { command: string; args?: readonly string[] } | undefined,
): string => {
  const fingerprint = setup
    ? setupStateFingerprint(setup.command, [...(setup.args ?? [])])
    : "no-bootstrap";
  return `${adapterId}:shared-bootstrap:${fingerprint}`;
};

export interface PublicWorkspaceHandle {
  readonly id: string;
  readonly descriptor: WorkspaceDescriptor;
  readonly sandbox: WorkspaceSandboxHandle;
  setPolicy(policy: WorkspacePolicy): Promise<void>;
}

export type WorkspaceStatus = "active" | "inactive" | "archived";

export interface WorkspaceDescriptor {
  readonly id: string;
  readonly name?: string;
  readonly status: WorkspaceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RunFinishInput extends AdapterRunFinishInput {
  runId: string;
}

export class WorkspaceHandle implements PublicWorkspaceHandle {
  readonly #ctx: SandkitContext;
  #record: WorkspaceRecord;
  #sandboxState: WorkspaceSandboxState;
  #descriptor: WorkspaceDescriptor;
  #lazySandbox?: LazySandboxHandle;

  constructor(ctx: SandkitContext, record: WorkspaceRecord) {
    this.#ctx = ctx;
    this.#record = record;
    this.#descriptor = this.resolveDescriptor(record);
    this.#sandboxState = readWorkspaceSandboxState(record);
  }

  get id(): string {
    return this.#record.id;
  }

  get descriptor(): WorkspaceDescriptor {
    return this.#descriptor;
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
    this.updateFromRecord(result);
    this.#sandboxState = readWorkspaceSandboxState(result);
  }

  /**
   * Returns a current lease only if a session is still attachable and unexpired.
   * This is attachment-state derived from persisted metadata; it is not intended
   * to reset expiry on read.
   */
  async getActiveLease(): Promise<WorkspaceSandboxLease | null> {
    await this.resolveLatestWorkspace();
    const sandbox = await this.resolveAttachableSession();
    if (!sandbox) {
      return null;
    }

    return readWorkspaceSandboxLease(this.#record);
  }

  async createOrResumeSandboxForCommand(): Promise<ManagedSandbox> {
    await this.resolveLatestWorkspace();
    if (await this.resolveAttachableSession()) {
      throw new Error(
        "Cannot run command while a sandbox session is active. Use attachSession() to reuse it or commit the session first.",
      );
    }

    const workspace = await this.resolveLatestWorkspace();
    const sandbox = await this.resolveSandboxDriver(workspace);

    return this.createManagedSandbox(sandbox);
  }

  async openSession(): Promise<WorkspaceSessionHandle> {
    await this.resolveLatestWorkspace();
    if (await this.resolveAttachableSession()) {
      throw new Error("A sandbox session is already active for this workspace.");
    }

    const workspace = await this.resolveLatestWorkspace();
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

  private async persistSessionPolicy(policy: WorkspacePolicy): Promise<void> {
    await this.resolveLatestWorkspace();
    if (!workspaceStateIsSession(this.#sandboxState)) {
      throw new Error("Cannot persist session policy without an active sandbox session.");
    }

    await this.persistSandboxState(
      transitionToSession(this.#sandboxState.sandboxId, this.#sandboxState.lease, policy),
    );
  }

  private makeSession(sandbox: SandboxDriver): ManagedSession {
    const sessionPolicy = workspaceStateIsSession(this.#sandboxState)
      ? this.#sandboxState.sessionPolicy
      : undefined;

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
      {
        initialSessionPolicy: sessionPolicy,
        onPolicyChange: async (policy: WorkspacePolicy) => {
          await this.persistSessionPolicy(policy);
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

    await this.persistSandboxState(
      transitionToSession(sandboxId, lease, this.#sandboxState.sessionPolicy),
    );
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
      return await this.resolveSandboxDriver(this.#record);
    } catch (error) {
      if (!this.#ctx.driverFactory.isSessionUnavailableError?.(error)) {
        throw error;
      }

      await this.persistSandboxState(transitionToCold());
      return null;
    }
  }

  private async resolveSandboxDriver(workspace: WorkspaceRecord): Promise<SandboxDriver> {
    const policy = readWorkspacePolicy(workspace, allowAll());
    const currentState = toDriverResumeState(this.#sandboxState);
    if (currentState) {
      return this.#ctx.driverFactory.resumeSandbox(workspace, currentState, { policy });
    }

    try {
      const setupState = await this.#readSharedSetupState();
      if (!setupState) {
        return this.#bootstrapSetupState(workspace, policy);
      }

      return await this.#ctx.driverFactory.resumeSandbox(workspace, setupState, {
        policy,
      });
    } catch (error) {
      if (
        !this.#ctx.driverFactory.isSessionUnavailableError?.(error) &&
        !this.#isRecoverableSetupStateError(error)
      ) {
        throw error;
      }

      await this.#clearSharedSetupState();
      return this.#bootstrapSetupState(workspace, policy);
    }
  }

  async #bootstrapSetupState(
    workspace: WorkspaceRecord,
    policy: WorkspacePolicy,
  ): Promise<SandboxDriver> {
    const setup = this.#ctx.options.setup;
    if (!setup) {
      return this.#ctx.driverFactory.createSandbox(workspace, { policy });
    }

    const sandbox = await this.#ctx.driverFactory.createSandbox(workspace, { policy });
    const result = await sandbox.runCommand(setup.command, [...(setup.args ?? [])]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Workspace setup failed with exit code ${result.exitCode}. ${result.stderr.trim()}`.trim(),
      );
    }

    const setupState = await sandbox.snapshot();
    await this.#persistSharedSetupState(setupState);

    return this.#ctx.driverFactory.resumeSandbox(workspace, setupState, {
      policy,
    });
  }

  async #readSharedSetupState(): Promise<PersistedSandboxState | null> {
    if (!this.#ctx.options.setup) {
      return null;
    }

    const setupState = await this.#ctx.adapter.setupStates.getSetupState(
      this.#sharedSetupStateId(),
    );
    return setupState ? setupState.state : null;
  }

  async #persistSharedSetupState(state: PersistedSandboxState): Promise<void> {
    await this.#ctx.adapter.setupStates.putSetupState({
      id: this.#sharedSetupStateId(),
      state: {
        kind: state.kind,
        sessionId: state.sessionId,
        state: state.state,
      },
    });
  }

  async #clearSharedSetupState(): Promise<void> {
    await this.#ctx.adapter.setupStates.deleteSetupState(this.#sharedSetupStateId());
  }

  #sharedSetupStateId(): string {
    return sharedSetupStateId(this.#ctx.adapter.id, this.#ctx.options.setup);
  }

  #isRecoverableSetupStateError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return (
      error.message.includes("Sandkit durable state corruption") &&
      error.message.includes("sandkit_setup_states")
    );
  }

  private createManagedSandbox(sandbox: SandboxDriver): ManagedSandbox {
    return new ManagedSandbox(
      sandbox,
      async () => this.resolveDefaultPolicy(),
      async (commit: SandboxCommit) =>
        this.persistSandboxState(transitionAfterCommandCommit(commit, new Date().toISOString())),
      this.createRunLifecycle(sandbox),
    );
  }

  private createRunLifecycle(sandbox: SandboxDriver) {
    return {
      onRunStart: async (input: {
        command: string;
        args: readonly string[];
        effectivePolicy: WorkspacePolicy;
        startedAt: string;
      }) => {
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
    };
  }

  private async persistSandboxState(transition: WorkspaceSandboxTransition): Promise<void> {
    const result = await persistSandboxTransition(
      this.#ctx.adapter.workspaces,
      this.#record.id,
      transition,
    );
    this.updateFromRecord(result.record);
    this.#sandboxState = result.state;
  }

  private async resolveLatestWorkspace(): Promise<WorkspaceRecord> {
    const latest = await this.#ctx.adapter.workspaces.getWorkspace(this.#record.id);
    if (!latest) {
      throw new Error(`Workspace with id "${this.#record.id}" no longer exists`);
    }

    this.updateFromRecord(latest);
    this.#sandboxState = readWorkspaceSandboxState(latest);
    if (isWorkspaceSessionStateExpired(this.#sandboxState)) {
      const result = await persistSandboxTransition(
        this.#ctx.adapter.workspaces,
        this.#record.id,
        transitionToCold(),
      );
      this.updateFromRecord(result.record);
      this.#sandboxState = result.state;
    }

    return this.#record;
  }

  private resolveDescriptor(record: WorkspaceRecord): WorkspaceDescriptor {
    return {
      id: record.id,
      name: record.name,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private updateFromRecord(record: WorkspaceRecord): void {
    this.#record = record;
    this.#descriptor = this.resolveDescriptor(record);
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
    return readWorkspacePolicy(workspace, allowAll());
  }
}

function workspaceStateIsSession(
  state: WorkspaceSandboxState,
): state is Extract<WorkspaceSandboxState, { kind: "session" }> {
  return state.kind === "session";
}
