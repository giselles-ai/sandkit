import type { WorkspacePolicy } from "../policies/types.ts";
import type {
  CommandResult,
  Command,
  WorkspaceSessionRunCommandOptions,
  SandboxDriver,
  SandboxRunCommandOptions,
  WorkspaceRunCommandOptions,
  WorkspaceRunCommandDetachedOptions,
  WorkspaceSessionProcessStartInput,
  WorkspaceSessionProcess,
  WorkspaceSandboxLease,
} from "../types.ts";
import { makeSnapshotCommit, type SandboxCommit } from "./workspace-state.ts";

export interface WorkspaceSandboxHandle {
  runCommand(command: string, args: string[]): Promise<CommandResult>;
  runCommand(input: WorkspaceRunCommandOptions): Promise<CommandResult>;
  runCommand(input: WorkspaceRunCommandDetachedOptions): Promise<Command>;
  /**
   * Opens a live sandbox lease. timeoutMs overrides the provider's default
   * lease timeout for this session start; it does not change runCommand()
   * semantics or command-level timeouts.
   */
  openSession(input?: { timeoutMs?: number }): Promise<WorkspaceSessionHandle>;
  attachSession(): Promise<WorkspaceSessionHandle>;
  getActiveLease(): Promise<WorkspaceSandboxLease | null>;
}

export interface WorkspaceSessionHandle {
  exec(command: string, args: string[]): Promise<CommandResult>;
  exec(input: WorkspaceSessionRunCommandOptions): Promise<CommandResult>;
  commit(): Promise<void>;
  /**
   * Sets a non-durable, session-scoped policy override for subsequent session
   * commands and process launches.
   */
  setPolicy(policy: WorkspacePolicy): Promise<void>;
  startProcess(command: string, args: string[]): Promise<WorkspaceSessionProcess>;
  startProcess(input: WorkspaceSessionProcessStartInput): Promise<WorkspaceSessionProcess>;
  url(port: number): Promise<string>;
  extendTimeout(durationMs: number): Promise<void>;
}

interface RunStartInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly effectivePolicy: WorkspacePolicy;
  readonly startedAt: string;
}

interface RunFinishInput {
  readonly runId: string;
  readonly status: "started" | "succeeded" | "failed";
  readonly finishedAt: string;
  readonly exitCode?: number | null;
  readonly stdout?: string | null;
  readonly stderr?: string | null;
  readonly providerCommit?: unknown;
}

interface RunLifecycle {
  readonly onRunStart?: (input: RunStartInput) => Promise<string>;
  readonly onRunFinish?: (input: RunFinishInput) => Promise<void>;
}

interface SessionStateValidator {
  readonly assertActive: () => Promise<void>;
}

interface SessionLeaseLifecycle {
  readonly onLeaseRefresh?: () => Promise<void>;
}

interface SessionPolicyLifecycle {
  readonly initialSessionPolicy?: WorkspacePolicy;
  readonly onPolicyChange?: (policy: WorkspacePolicy) => Promise<void>;
}

type NormalizedRunCommandInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly policy: WorkspacePolicy;
  readonly timeoutMs: number | undefined;
  readonly detached: boolean;
};
type SessionRunCommandInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly policy: WorkspacePolicy;
};

type CommitHook = (commit: SandboxCommit) => Promise<void>;
type DefaultPolicyResolver = () => Promise<WorkspacePolicy>;

export class ManagedSandbox {
  readonly #driver: SandboxDriver;
  readonly #onCommit?: CommitHook;
  readonly #runLifecycle?: RunLifecycle;
  readonly #resolveDefaultPolicy: DefaultPolicyResolver;

  constructor(
    driver: SandboxDriver,
    resolveDefaultPolicy: DefaultPolicyResolver,
    onCommit?: CommitHook,
    runLifecycle?: RunLifecycle,
  ) {
    this.#driver = driver;
    this.#resolveDefaultPolicy = resolveDefaultPolicy;
    this.#onCommit = onCommit;
    this.#runLifecycle = runLifecycle;
  }

  get id(): string {
    return this.#driver.id;
  }

  async runCommand(command: string, args: string[]): Promise<Command>;
  async runCommand(input: WorkspaceRunCommandOptions): Promise<Command>;
  async runCommand(input: WorkspaceRunCommandDetachedOptions): Promise<Command>;
  async runCommand(
    inputOrCommand: string | SandboxRunCommandOptions,
    args: string[] = [],
  ): Promise<Command> {
    const normalized = await this.normalizeRunCommandInput(inputOrCommand, args);
    this.ensureCommandShape(normalized.command, normalized.args);
    return this.runUnitOfWork(normalized.command, normalized.args, normalized.policy, () =>
      this.executeCommand(
        normalized.command,
        normalized.args,
        normalized.policy,
        normalized.detached,
      ),
    );
  }

  private async normalizeRunCommandInput(
    inputOrCommand: string | SandboxRunCommandOptions,
    args: readonly string[],
  ): Promise<NormalizedRunCommandInput> {
    if (typeof inputOrCommand === "string") {
      return {
        command: inputOrCommand,
        args,
        policy: await this.#resolveDefaultPolicy(),
        timeoutMs: undefined,
        detached: false,
      };
    }

    return {
      command: inputOrCommand.command,
      args: inputOrCommand.args ?? [],
      policy: inputOrCommand.policy ?? (await this.#resolveDefaultPolicy()),
      timeoutMs: inputOrCommand.timeoutMs,
      detached: "detached" in inputOrCommand ? inputOrCommand.detached : false,
    };
  }

  private ensureCommandShape(command: string, args: readonly string[]): void {
    if (!command.trim()) {
      throw new Error("Sandbox command must not be empty.");
    }

    if (!Array.isArray(args)) {
      throw new Error("Sandbox command arguments must be an array.");
    }
  }

  private async runUnitOfWork(
    command: string,
    args: readonly string[],
    effectivePolicy: WorkspacePolicy,
    operation: () => Promise<Command>,
  ): Promise<Command> {
    const now = new Date().toISOString();
    const runId = await this.startRun(command, args, effectivePolicy, now);
    let commandHandle: Command;
    try {
      commandHandle = await operation();
    } catch (commandError) {
      const finishedAt = new Date().toISOString();
      let providerCommit: unknown;
      let finalizeError: unknown | undefined;

      try {
        const commit = await this.snapshotWithFallback();
        providerCommit = commit.state;

        if (this.#onCommit) {
          await this.persistCommit(commit);
        }
      } catch (error) {
        finalizeError = error;
        providerCommit = undefined;
      }

      try {
        if (runId) {
          await this.finishRun({
            runId,
            status: "failed",
            providerCommit,
            finishedAt,
          });
        }
      } catch (error) {
        finalizeError = finalizeError ?? error;
      }

      if (finalizeError !== undefined) {
        throw new AggregateError(
          [commandError, finalizeError],
          "Sandbox command failed and unit-of-work durability finalization did not complete.",
        );
      }

      throw commandError;
    }

    const waitResult = (async () => {
      let commandError: unknown | undefined;
      let commandResult: CommandResult | undefined;
      let providerCommit: unknown;
      let finalizeError: unknown | undefined;

      try {
        commandResult = await commandHandle.wait();
      } catch (error) {
        commandError = error;
      }

      const finishedAt = new Date().toISOString();
      const commandStatus: "succeeded" | "failed" =
        commandError === undefined
          ? commandResult?.exitCode === 0
            ? "succeeded"
            : "failed"
          : "failed";

      try {
        const commit = await this.snapshotWithFallback();
        providerCommit = commit.state;

        if (this.#onCommit) {
          await this.persistCommit(commit);
        }
      } catch (error) {
        finalizeError = error;
        providerCommit = undefined;
      }

      const finalRunStatus: "succeeded" | "failed" =
        commandError === undefined && finalizeError === undefined ? commandStatus : "failed";

      try {
        if (runId) {
          await this.finishRun({
            runId,
            status: finalRunStatus,
            providerCommit,
            finishedAt,
            exitCode: commandResult?.exitCode,
            stdout: commandResult?.stdout,
            stderr: commandResult?.stderr,
          });
        }
      } catch (error) {
        finalizeError = finalizeError ?? error;
      }

      if (commandError !== undefined) {
        if (finalizeError !== undefined) {
          throw new AggregateError(
            [commandError, finalizeError],
            "Sandbox command failed and unit-of-work durability finalization did not complete.",
          );
        }
        throw commandError;
      }

      if (finalizeError !== undefined) {
        throw finalizeError;
      }

      if (!commandResult) {
        throw new Error("Command result was missing after successful execution.");
      }

      return commandResult;
    })();
    void waitResult.catch(() => {});

    return {
      wait: async () => waitResult,
      logs: commandHandle.logs,
    };
  }

  private async startRun(
    command: string,
    args: readonly string[],
    effectivePolicy: WorkspacePolicy,
    at: string,
  ): Promise<string | undefined> {
    if (!this.#runLifecycle?.onRunStart) {
      return undefined;
    }

    return this.#runLifecycle.onRunStart({
      command,
      args,
      effectivePolicy,
      startedAt: at,
    });
  }

  private async executeCommand(
    command: string,
    args: readonly string[],
    policy: WorkspacePolicy,
    detached: boolean,
  ): Promise<Command> {
    await this.#driver.applyPolicy(policy);
    return this.#driver.runCommand(command, [...args], { detached });
  }

  private async finishRun(input: RunFinishInput): Promise<void> {
    if (!this.#runLifecycle?.onRunFinish) {
      return;
    }

    await this.#runLifecycle.onRunFinish(input);
  }

  private async snapshotWithFallback(): Promise<SandboxCommit> {
    const snapshot = await this.#driver.snapshot();
    return makeSnapshotCommit(snapshot);
  }

  private async persistCommit(commit: SandboxCommit): Promise<void> {
    if (!this.#onCommit) {
      return;
    }

    await this.#onCommit(commit);
  }
}

export class ManagedSession implements WorkspaceSessionHandle {
  readonly #driver: SandboxDriver;
  readonly #onCommit?: CommitHook;
  readonly #resolveDefaultPolicy: DefaultPolicyResolver;
  readonly #onPolicyChange?: (policy: WorkspacePolicy) => Promise<void>;
  readonly #stateValidator?: SessionStateValidator;
  readonly #leaseLifecycle?: SessionLeaseLifecycle;
  #sessionPolicyOverride: WorkspacePolicy | undefined;
  #isActive = true;

  constructor(
    driver: SandboxDriver,
    resolveDefaultPolicy: DefaultPolicyResolver,
    onCommit?: CommitHook,
    stateValidator?: SessionStateValidator,
    leaseLifecycle?: SessionLeaseLifecycle,
    policyLifecycle?: SessionPolicyLifecycle,
  ) {
    this.#driver = driver;
    this.#resolveDefaultPolicy = resolveDefaultPolicy;
    this.#onCommit = onCommit;
    this.#stateValidator = stateValidator;
    this.#leaseLifecycle = leaseLifecycle;
    this.#onPolicyChange = policyLifecycle?.onPolicyChange;
    this.#sessionPolicyOverride = policyLifecycle?.initialSessionPolicy;
  }

  get id(): string {
    return this.#driver.id;
  }

  async exec(command: string, args: string[]): Promise<CommandResult>;
  async exec(input: WorkspaceSessionRunCommandOptions): Promise<CommandResult>;
  async exec(
    inputOrCommand: string | WorkspaceSessionRunCommandOptions,
    args: string[] = [],
  ): Promise<CommandResult> {
    await this.assertSessionActive();
    const normalized = await this.normalizeSessionInput(inputOrCommand, args);
    this.ensureCommandShape(normalized.command, normalized.args);
    await this.#driver.applyPolicy(normalized.policy);
    return (
      await this.#driver.runCommand(normalized.command, [...normalized.args], {
        detached: false,
      })
    ).wait();
  }

  async commit(): Promise<void> {
    await this.assertSessionActive();
    let snapshot: SandboxCommit;
    try {
      snapshot = await this.snapshotWithFallback();
      if (this.#onCommit) {
        await this.persistCommit(snapshot);
      }
    } finally {
      this.#isActive = false;
    }
  }

  async setPolicy(policy: WorkspacePolicy): Promise<void> {
    await this.assertSessionActive();
    this.#sessionPolicyOverride = policy;
    await this.#driver.applyPolicy(policy);
    if (this.#onPolicyChange !== undefined) {
      await this.#onPolicyChange(policy);
    }
  }

  async startProcess(command: string, args: string[]): Promise<WorkspaceSessionProcess>;
  async startProcess(input: WorkspaceSessionProcessStartInput): Promise<WorkspaceSessionProcess>;
  async startProcess(
    inputOrCommand: string | WorkspaceSessionProcessStartInput,
    args: string[] = [],
  ): Promise<WorkspaceSessionProcess> {
    await this.assertSessionActive();
    const startProcess = this.#driver.startProcess;
    if (!startProcess) {
      throw new Error(`This sandbox provider does not support startProcess().`);
    }

    const normalized =
      typeof inputOrCommand === "string"
        ? {
            command: inputOrCommand,
            args,
            policy: this.#sessionPolicyOverride,
            onStdout: undefined,
            onStderr: undefined,
          }
        : inputOrCommand;
    if (!normalized.command.trim()) {
      throw new Error("Sandbox process command must not be empty.");
    }
    if (!Array.isArray(normalized.args)) {
      throw new Error("Sandbox process args must be an array.");
    }

    const policy = await this.resolveSessionPolicy(normalized.policy);
    await this.#driver.applyPolicy(policy);

    return startProcess.call(this.#driver, {
      command: normalized.command,
      args: [...normalized.args],
      policy,
      onStdout: normalized.onStdout,
      onStderr: normalized.onStderr,
    });
  }

  async url(port: number): Promise<string> {
    await this.assertSessionActive();
    const url = this.#driver.url;
    if (!url) {
      throw new Error(`This sandbox provider does not support url(port).`);
    }

    return url.call(this.#driver, port);
  }

  async extendTimeout(durationMs: number): Promise<void> {
    await this.assertSessionActive();
    const extendTimeout = this.#driver.extendTimeout;
    if (!extendTimeout) {
      throw new Error(`This sandbox provider does not support extendTimeout().`);
    }

    await extendTimeout.call(this.#driver, durationMs);
    if (this.#leaseLifecycle?.onLeaseRefresh) {
      await this.#leaseLifecycle.onLeaseRefresh();
    }
  }

  private async normalizeSessionInput(
    inputOrCommand: string | WorkspaceSessionRunCommandOptions,
    args: readonly string[],
  ): Promise<SessionRunCommandInput> {
    if (typeof inputOrCommand === "string") {
      return {
        command: inputOrCommand,
        args,
        policy: await this.resolveSessionPolicy(),
      };
    }

    if ("detached" in inputOrCommand) {
      throw new Error("session exec does not support detached execution.");
    }

    return {
      command: inputOrCommand.command,
      args: inputOrCommand.args ?? [],
      policy: await this.resolveSessionPolicy(inputOrCommand.policy),
    };
  }

  private async resolveSessionPolicy(override?: WorkspacePolicy): Promise<WorkspacePolicy> {
    if (override !== undefined) {
      return override;
    }

    if (this.#sessionPolicyOverride !== undefined) {
      return this.#sessionPolicyOverride;
    }

    return this.#resolveDefaultPolicy();
  }

  private ensureCommandShape(command: string, args: readonly string[]): void {
    if (!command.trim()) {
      throw new Error("Sandbox command must not be empty.");
    }

    if (!Array.isArray(args)) {
      throw new Error("Sandbox command arguments must be an array.");
    }
  }

  private async assertSessionActive(): Promise<void> {
    if (!this.#isActive) {
      throw new Error("This sandbox session has already been committed and is no longer active.");
    }
    if (this.#stateValidator) {
      await this.#stateValidator.assertActive();
    }
  }

  private async snapshotWithFallback(): Promise<SandboxCommit> {
    const snapshot = await this.#driver.snapshot();
    return makeSnapshotCommit(snapshot);
  }

  private async persistCommit(commit: SandboxCommit): Promise<void> {
    if (!this.#onCommit) {
      return;
    }

    await this.#onCommit(commit);
  }
}

export class LazySandboxHandle implements WorkspaceSandboxHandle {
  readonly #resolveSandbox: (input?: SandboxRunCommandOptions) => Promise<ManagedSandbox>;
  readonly #openSession: (input?: { timeoutMs?: number }) => Promise<WorkspaceSessionHandle>;
  readonly #attachSession: () => Promise<WorkspaceSessionHandle>;
  readonly #getActiveLease: () => Promise<WorkspaceSandboxLease | null>;

  constructor(
    resolveSandbox: (input?: SandboxRunCommandOptions) => Promise<ManagedSandbox>,
    openSession: (input?: { timeoutMs?: number }) => Promise<WorkspaceSessionHandle>,
    attachSession: () => Promise<WorkspaceSessionHandle>,
    getActiveLease: () => Promise<WorkspaceSandboxLease | null>,
  ) {
    this.#resolveSandbox = resolveSandbox;
    this.#openSession = openSession;
    this.#attachSession = attachSession;
    this.#getActiveLease = getActiveLease;
  }

  async runCommand(command: string, args: string[]): Promise<CommandResult>;
  async runCommand(input: WorkspaceRunCommandOptions): Promise<CommandResult>;
  async runCommand(input: WorkspaceRunCommandDetachedOptions): Promise<Command>;
  async runCommand(
    inputOrCommand: string | SandboxRunCommandOptions,
    args: string[] = [],
  ): Promise<CommandResult | Command> {
    const sandbox =
      typeof inputOrCommand === "string"
        ? await this.#resolveSandbox()
        : await this.#resolveSandbox(inputOrCommand);
    if (typeof inputOrCommand === "string") {
      return sandbox.runCommand(inputOrCommand, args).then((command) => command.wait());
    }
    const command = await sandbox.runCommand(inputOrCommand);
    if ("detached" in inputOrCommand && inputOrCommand.detached === true) {
      return command;
    }

    return command.wait();
  }

  async openSession(input?: { timeoutMs?: number }): Promise<WorkspaceSessionHandle> {
    return this.#openSession(input);
  }

  async attachSession(): Promise<WorkspaceSessionHandle> {
    return this.#attachSession();
  }

  async getActiveLease(): Promise<WorkspaceSandboxLease | null> {
    return this.#getActiveLease();
  }
}
