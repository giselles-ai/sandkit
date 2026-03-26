import { allowAll, describeWorkspacePolicy } from "../policies/dsl.ts";
import type { WorkspacePolicy } from "../policies/types.ts";
import type {
  CommandResult,
  SandboxSessionLease,
  PersistedSandboxState,
  SandboxDriver,
  SandboxRunCommandOptions,
  WorkspaceSessionLog,
  WorkspaceSessionProcessStartInput,
  SandboxCreateOptions,
  SandboxDriverFactory,
  WorkspaceRecord,
} from "../types.ts";
import { createId } from "./ids.ts";

type FileMap = Record<string, string>;

interface MockSandboxSnapshotState {
  files: FileMap;
}

function toSnapshotState(snapshot: PersistedSandboxState): MockSandboxSnapshotState {
  const files =
    snapshot.state &&
    typeof snapshot.state === "object" &&
    !Array.isArray(snapshot.state) &&
    "files" in snapshot.state &&
    snapshot.state.files &&
    typeof snapshot.state.files === "object" &&
    !Array.isArray(snapshot.state.files)
      ? (snapshot.state.files as FileMap)
      : {};
  return { files: { ...files } };
}

class MockSandboxDriver implements SandboxDriver {
  readonly #files: FileMap;
  #policy: WorkspacePolicy;
  readonly id: string;
  readonly provider = "mock";
  #timeoutMs: number;
  #expiresAtMs: number | null = null;

  constructor(id: string, files: FileMap = {}, policy: WorkspacePolicy = allowAll()) {
    this.id = id;
    this.#files = { ...files };
    this.#policy = policy;
    this.#timeoutMs = 60_000 * 60;
  }

  async applyPolicy(policy: WorkspacePolicy): Promise<void> {
    this.#policy = policy;
  }

  async getSessionLease(): Promise<SandboxSessionLease> {
    const observedAt = new Date().toISOString();
    const observedAtMs = Date.parse(observedAt);
    if (this.#expiresAtMs === null) {
      this.#expiresAtMs = observedAtMs + this.#timeoutMs;
    }
    if (this.#expiresAtMs < observedAtMs) {
      this.#expiresAtMs = observedAtMs;
    }

    return {
      sandboxId: this.id,
      observedAt,
      expiresAt: new Date(this.#expiresAtMs).toISOString(),
    };
  }

  async extendTimeout(durationMs: number): Promise<void> {
    const observedAtMs = Date.now();
    if (this.#expiresAtMs === null || this.#expiresAtMs < observedAtMs) {
      this.#expiresAtMs = observedAtMs;
    }
    this.#expiresAtMs = this.#expiresAtMs + durationMs;
  }

  async startProcess(input: WorkspaceSessionProcessStartInput): Promise<{
    processId: string;
    wait: () => Promise<CommandResult>;
    logs: () => AsyncIterable<WorkspaceSessionLog>;
  }> {
    const commandResult = await this.runCommand(input.command, [...input.args]);
    if (input.onStdout && commandResult.stdout) {
      input.onStdout(commandResult.stdout);
    }
    if (input.onStderr && commandResult.stderr) {
      input.onStderr(commandResult.stderr);
    }

    return {
      processId: `${this.id}-${Date.now()}`,
      wait: async () => commandResult,
      logs: () => {
        const chunks: WorkspaceSessionLog[] = [];
        if (commandResult.stdout) {
          chunks.push({ stream: "stdout", chunk: commandResult.stdout });
        }
        if (commandResult.stderr) {
          chunks.push({ stream: "stderr", chunk: commandResult.stderr });
        }
        return toAsyncIterable(chunks);
      },
    };
  }

  async runCommand(
    command: string,
    args: string[],
    _options?: SandboxRunCommandOptions["provider"],
  ): Promise<CommandResult> {
    switch (command) {
      case "echo":
        return this.runEcho(args);
      case "cat":
        return this.runCat(args);
      case "pwd":
        return this.ok("/workspace\n");
      case "ls":
        return this.ok(`${Object.keys(this.#files).sort().join("\n")}\n`);
      case "policy":
        return this.ok(`${JSON.stringify(this.#policy)}\n`);
      case "policy-id":
        return this.ok(`${describeWorkspacePolicy(this.#policy)}\n`);
      default:
        return {
          exitCode: 127,
          stderr: `Unsupported mock command: ${command}\n`,
          stdout: "",
        };
    }
  }

  async snapshot(): Promise<PersistedSandboxState> {
    return {
      kind: "mock",
      sessionId: this.id,
      state: {
        files: { ...this.#files },
      },
    };
  }

  private ok(stdout: string): CommandResult {
    return {
      exitCode: 0,
      stderr: "",
      stdout,
    };
  }

  private runCat(args: string[]): CommandResult {
    const target = args[0];
    if (!target) {
      return {
        exitCode: 1,
        stderr: "cat: missing file operand\n",
        stdout: "",
      };
    }

    const content = this.#files[target];
    if (typeof content !== "string") {
      return {
        exitCode: 1,
        stderr: `cat: ${target}: No such file or directory\n`,
        stdout: "",
      };
    }

    return this.ok(content.endsWith("\n") ? content : `${content}\n`);
  }

  private runEcho(args: string[]): CommandResult {
    const redirectIndex = args.indexOf(">");
    if (redirectIndex === -1) {
      return this.ok(`${args.join(" ")}\n`);
    }

    const target = args[redirectIndex + 1];
    if (!target) {
      return {
        exitCode: 1,
        stderr: "echo: missing redirect target\n",
        stdout: "",
      };
    }

    const content = args.slice(0, redirectIndex).join(" ");
    this.#files[target] = content;
    return this.ok("");
  }
}

function toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

export class MockSandboxDriverFactory implements SandboxDriverFactory {
  readonly #sessions = new Map<string, MockSandboxDriver>();

  async createSandbox(
    _workspace: WorkspaceRecord,
    options: SandboxCreateOptions,
  ): Promise<SandboxDriver> {
    const driver = new MockSandboxDriver(createId("sandbox"), {}, options.policy);
    this.#sessions.set(driver.id, driver);
    return driver;
  }

  isSessionUnavailableError(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith("Mock sandbox session not found:");
  }

  async resumeSandbox(
    _workspace: WorkspaceRecord,
    snapshot: PersistedSandboxState,
    options: SandboxCreateOptions,
  ): Promise<SandboxDriver> {
    if (snapshot.kind === "sandbox-session") {
      const existing = this.#sessions.get(snapshot.sessionId);
      if (!existing) {
        throw new Error(`Mock sandbox session not found: ${snapshot.sessionId}`);
      }

      await existing.applyPolicy(options.policy);
      return existing;
    }

    const state = toSnapshotState(snapshot);
    const driver = new MockSandboxDriver(snapshot.sessionId, state.files, options.policy);
    this.#sessions.set(driver.id, driver);
    return driver;
  }
}
