import type { CommandResult, SandboxDriver } from "../types.ts";
import { makeSnapshotCommit, type SandboxCommit } from "./workspace-state.ts";

export interface WorkspaceSandboxHandle {
  runCommand(command: string, args: string[]): Promise<CommandResult>;
}

interface RunStartInput {
  readonly command: string;
  readonly args: readonly string[];
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

export class ManagedSandbox {
  readonly #driver: SandboxDriver;
  readonly #onCommit?: CommitHook;
  readonly #runLifecycle?: RunLifecycle;

  constructor(driver: SandboxDriver, onCommit?: CommitHook, runLifecycle?: RunLifecycle) {
    this.#driver = driver;
    this.#onCommit = onCommit;
    this.#runLifecycle = runLifecycle;
  }

  get id(): string {
    return this.#driver.id;
  }

  async runCommand(command: string, args: string[]): Promise<CommandResult> {
    this.ensureCommandShape(command, args);
    return this.runUnitOfWork(command, args, () => this.#driver.runCommand(command, args));
  }

  private ensureCommandShape(command: string, args: string[]): void {
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
    operation: () => Promise<CommandResult>,
  ): Promise<CommandResult> {
    const now = new Date().toISOString();
    const runId = await this.startRun(command, args, now);
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
    at: string,
  ): Promise<string | undefined> {
    if (!this.#runLifecycle?.onRunStart) {
      return undefined;
    }

    return this.#runLifecycle.onRunStart({
      command,
      args,
      startedAt: at,
    });
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

  async runCommand(command: string, args: string[]): Promise<CommandResult> {
    const sandbox = await this.#resolveSandbox();
    return sandbox.runCommand(command, args);
  }
}
