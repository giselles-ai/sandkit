import type { CommandResult, SandboxDriver } from "../types.ts";
import type { SandboxCommit } from "./workspace-state.ts";

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
    try {
      const result = await this.#driver.runCommand(command, args);
      await this.persistDurableState();
      return result;
    } catch (error) {
      await this.persistDurableState();
      throw error;
    }
  }

  private ensureCommandShape(command: string, args: string[]): void {
    if (!command.trim()) {
      throw new Error("Sandbox command must not be empty.");
    }

    if (!Array.isArray(args)) {
      throw new Error("Sandbox command arguments must be an array.");
    }
  }

  private async persistDurableState(): Promise<void> {
    const snapshot = await this.#driver.snapshot();
    const commit: SandboxCommit = {
      kind: "snapshot",
      state: snapshot,
    };
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
