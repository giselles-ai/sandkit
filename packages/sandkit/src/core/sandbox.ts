import type { WorkspacePolicy } from "../policies/types.ts";
import type { CommandResult, SandboxDriver, SandboxRunCommandOptions } from "../types.ts";
import { makeSnapshotCommit, type SandboxCommit } from "./workspace-state.ts";

export interface WorkspaceSandboxHandle {
  runCommand(command: string, args: string[]): Promise<CommandResult>;
  runCommand(input: SandboxRunCommandOptions): Promise<CommandResult>;
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

  async runCommand(command: string, args: string[]): Promise<CommandResult>;
  async runCommand(input: SandboxRunCommandOptions): Promise<CommandResult>;
  async runCommand(
    inputOrCommand: string | SandboxRunCommandOptions,
    args: string[] = [],
  ): Promise<CommandResult> {
    const normalized = await this.normalizeRunCommandInput(inputOrCommand, args);
    this.ensureCommandShape(normalized.command, normalized.args);
    return this.runUnitOfWork(normalized.command, normalized.args, normalized.policy, () =>
      this.executeCommand(normalized.command, normalized.args, normalized.policy),
    );
  }

  private async normalizeRunCommandInput(
    inputOrCommand: string | SandboxRunCommandOptions,
    args: readonly string[],
  ): Promise<Required<SandboxRunCommandOptions>> {
    if (typeof inputOrCommand === "string") {
      return {
        command: inputOrCommand,
        args,
        policy: await this.#resolveDefaultPolicy(),
      };
    }

    return {
      command: inputOrCommand.command,
      args: inputOrCommand.args ?? [],
      policy: inputOrCommand.policy ?? (await this.#resolveDefaultPolicy()),
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
    operation: () => Promise<CommandResult>,
  ): Promise<CommandResult> {
    const now = new Date().toISOString();
    const runId = await this.startRun(command, args, effectivePolicy, now);
    let commandError: unknown | undefined;
    let commandResult: CommandResult | undefined;

    try {
      commandResult = await operation();
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
  ): Promise<CommandResult> {
    await this.#driver.applyPolicy(policy);
    return this.#driver.runCommand(command, [...args]);
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

export class LazySandboxHandle implements WorkspaceSandboxHandle {
  readonly #resolveSandbox: () => Promise<ManagedSandbox>;

  constructor(resolveSandbox: () => Promise<ManagedSandbox>) {
    this.#resolveSandbox = resolveSandbox;
  }

  async runCommand(command: string, args: string[]): Promise<CommandResult>;
  async runCommand(input: SandboxRunCommandOptions): Promise<CommandResult>;
  async runCommand(
    inputOrCommand: string | SandboxRunCommandOptions,
    args: string[] = [],
  ): Promise<CommandResult> {
    const sandbox = await this.#resolveSandbox();
    if (typeof inputOrCommand === "string") {
      return sandbox.runCommand(inputOrCommand, args);
    }
    return sandbox.runCommand(inputOrCommand);
  }
}
