import { allowAll, describeWorkspacePolicy } from "../policies/dsl.ts";
import type { WorkspacePolicy } from "../policies/types.ts";
import type {
  CommandResult,
  PersistedSandboxState,
  SandboxDriver,
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

  constructor(id: string, files: FileMap = {}, policy: WorkspacePolicy = allowAll()) {
    this.id = id;
    this.#files = { ...files };
    this.#policy = policy;
  }

  async applyPolicy(policy: WorkspacePolicy): Promise<void> {
    this.#policy = policy;
  }

  async runCommand(command: string, args: string[]): Promise<CommandResult> {
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

export class MockSandboxDriverFactory implements SandboxDriverFactory {
  async createSandbox(
    _workspace: WorkspaceRecord,
    options: SandboxCreateOptions,
  ): Promise<SandboxDriver> {
    return new MockSandboxDriver(createId("sandbox"), {}, options.policy);
  }

  async resumeSandbox(
    _workspace: WorkspaceRecord,
    snapshot: PersistedSandboxState,
    options: SandboxCreateOptions,
  ): Promise<SandboxDriver> {
    const state = toSnapshotState(snapshot);
    return new MockSandboxDriver(snapshot.sessionId, state.files, options.policy);
  }
}
