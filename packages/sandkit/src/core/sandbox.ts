import type { CommandResult, SandboxDriver } from "../types.ts";
import { makeSnapshotCommit, type SandboxCommit } from "./workspace-state.ts";

export interface WorkspaceSandboxHandle {
  runCommand(command: string, args: string[]): Promise<CommandResult>;
}

export class ManagedSandbox {
  readonly #driver: SandboxDriver;
  readonly #onCommit?: ((commit: SandboxCommit) => Promise<void>) | undefined;

  constructor(driver: SandboxDriver, onCommit?: (commit: SandboxCommit) => Promise<void>) {
    this.#driver = driver;
    this.#onCommit = onCommit;
  }

  get id(): string {
    return this.#driver.id;
  }

  async runCommand(command: string, args: string[]): Promise<CommandResult> {
    this.ensureCommandShape(command, args);
    return this.runUnitOfWork(async () => this.#driver.runCommand(command, args));
  }

  private ensureCommandShape(command: string, args: string[]): void {
    if (!command.trim()) {
      throw new Error("Sandbox command must not be empty.");
    }

    if (!Array.isArray(args)) {
      throw new Error("Sandbox command arguments must be an array.");
    }
  }

  private async runUnitOfWork<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      const commit = await this.createDurableCommit();
      await this.persistCommit(commit);
      return result;
    } catch (error) {
      const commit = await this.createDurableCommit();
      await this.persistCommit(commit);
      throw error;
    }
  }

  private async createDurableCommit(): Promise<SandboxCommit> {
    const snapshot = await this.#driver.snapshot();
    return makeSnapshotCommit(snapshot);
  }

  private async persistCommit(commit: SandboxCommit): Promise<void> {
    if (this.#onCommit) {
      await this.#onCommit(commit);
    }
    return;
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
