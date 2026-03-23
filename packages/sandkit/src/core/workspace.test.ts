import { describe, expect, test } from "bun:test";

import { createMemoryAdapter } from "../adapters/memory.ts";
import { internalSandboxProvider, mockSandbox } from "../integrations/mock.ts";
import { codex } from "../policies/codex.ts";
import { allowAll, allowServices } from "../policies/dsl.ts";
import type {
  CommandResult,
  PersistedSandboxState,
  SandboxDriverFactory,
  WorkspacePolicy,
} from "../types.ts";
import { sandkit } from "./sandkit.ts";
import { sharedSetupStateId } from "./workspace.ts";

function createSetupRecoveryDriverFactory(): SandboxDriverFactory {
  class SetupRecoveryDriver {
    readonly provider = "setup-recovery-test";
    readonly #files: Record<string, string>;
    readonly id: string;

    constructor(id: string, files: Record<string, string>) {
      this.id = id;
      this.#files = { ...files };
    }

    async applyPolicy(_policy: WorkspacePolicy): Promise<void> {}

    async getSessionLease() {
      const observedAt = new Date().toISOString();
      return {
        sandboxId: this.id,
        observedAt,
        expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
      };
    }

    async runCommand(command: string, args: string[]): Promise<CommandResult> {
      switch (command) {
        case "echo": {
          const redirectIndex = args.indexOf(">");
          if (redirectIndex === -1) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: `${args.join(" ")}\n`,
            };
          }

          const target = args[redirectIndex + 1];
          if (!target) {
            return { exitCode: 1, stderr: "missing redirect target\n", stdout: "" };
          }

          this.#files[target] = args.slice(0, redirectIndex).join(" ");
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        case "cat": {
          const target = args[0];
          if (!target || this.#files[target] === undefined) {
            return { exitCode: 1, stderr: `cat: ${target}: missing\n`, stdout: "" };
          }

          return {
            exitCode: 0,
            stderr: "",
            stdout: `${this.#files[target]}\n`,
          };
        }
        default:
          return { exitCode: 127, stderr: `unsupported: ${command}\n`, stdout: "" };
      }
    }

    async snapshot(): Promise<PersistedSandboxState> {
      return {
        kind: "setup-recovery-snapshot",
        sessionId: this.id,
        state: {
          files: { ...this.#files },
        },
      };
    }
  }

  let nextId = 0;

  return {
    isSessionUnavailableError(error: unknown): boolean {
      return error instanceof Error && error.message === "setup state unavailable";
    },
    async createSandbox() {
      nextId += 1;
      return new SetupRecoveryDriver(`setup-recovery-${nextId}`, {});
    },
    async resumeSandbox(_workspace, snapshot) {
      if (snapshot.kind === "stale-setup-recovery") {
        throw new Error("setup state unavailable");
      }

      const files =
        snapshot.state &&
        typeof snapshot.state === "object" &&
        !Array.isArray(snapshot.state) &&
        "files" in snapshot.state &&
        snapshot.state.files &&
        typeof snapshot.state.files === "object" &&
        !Array.isArray(snapshot.state.files)
          ? (snapshot.state.files as Record<string, string>)
          : {};

      return new SetupRecoveryDriver(snapshot.sessionId, files);
    },
  };
}

function createMockSandkit(
  input: Omit<Parameters<typeof sandkit>[0], "sandbox"> = {},
): ReturnType<typeof sandkit> {
  return sandkit({
    ...input,
    sandbox: mockSandbox(),
  });
}

describe("Workspace session policy lifecycle", () => {
  test("requires sandbox provider in construction options", async () => {
    expect(() => {
      sandkit(undefined as unknown as Parameters<typeof sandkit>[0]);
    }).toThrow("SandkitOptions is required");

    expect(() => {
      sandkit({} as Parameters<typeof sandkit>[0]);
    }).toThrow("SandkitOptions.sandbox is required. Set it to a Sandkit sandbox provider");
  });

  test("restores session policy override when reattaching to an active session", async () => {
    const defaultPolicy = allowServices([
      {
        id: "bootstrap",
        name: "Bootstrap",
        domains: ["bootstrap.example.com"],
      },
    ]);
    const livePolicy = allowServices([
      {
        id: "live",
        name: "Live",
        domains: ["live.example.com"],
      },
    ]);

    const app = createMockSandkit();
    const workspace = await app.createWorkspace({ policy: defaultPolicy });
    const session = await workspace.sandbox.openSession();

    const before = await session.exec("policy-id", []);
    expect(before.stdout.trim()).toBe("allow-services:bootstrap");

    await session.setPolicy(livePolicy);
    const whileSetLive = await session.exec("policy-id", []);
    expect(whileSetLive.stdout.trim()).toBe("allow-services:live");

    const reloadedWorkspace = await app.getWorkspace(workspace.id);
    const reattachedSession = await reloadedWorkspace.sandbox.attachSession();
    const afterReattach = await reattachedSession.exec("policy-id", []);
    expect(afterReattach.stdout.trim()).toBe("allow-services:live");
  });
});

describe("Workspace setup lifecycle", () => {
  test("runs setup before the first durable command and does not rerun it once state exists", async () => {
    const app = createMockSandkit({
      setup: {
        command: "echo",
        args: ["hello", ">", "hello.txt"],
      },
    });
    const workspace = await app.createWorkspace({
      id: "shared-setup-command",
    });

    const firstRead = await workspace.sandbox.runCommand({
      command: "cat",
      args: ["hello.txt"],
    });
    expect(firstRead.exitCode).toBe(0);
    expect(firstRead.stdout.trim()).toBe("hello");
    const recordedSetupState = await app.context.adapter.setupStates.getSetupState(
      sharedSetupStateId(app.context.adapter.id, app.context.options.setup),
    );
    expect(recordedSetupState?.state).toBeDefined();

    const overwrite = await workspace.sandbox.runCommand({
      command: "echo",
      args: ["changed", ">", "hello.txt"],
    });
    expect(overwrite.exitCode).toBe(0);

    const secondRead = await workspace.sandbox.runCommand({
      command: "cat",
      args: ["hello.txt"],
    });
    expect(secondRead.exitCode).toBe(0);
    expect(secondRead.stdout.trim()).toBe("changed");
  });

  test("runs setup before the first session and persists the successful setup state", async () => {
    const app = createMockSandkit({
      setup: {
        command: "echo",
        args: ["ready", ">", "hello.txt"],
      },
    });
    const workspace = await app.createWorkspace();

    const session = await workspace.sandbox.openSession();
    const sessionRead = await session.exec({
      command: "cat",
      args: ["hello.txt"],
    });
    expect(sessionRead.exitCode).toBe(0);
    expect(sessionRead.stdout.trim()).toBe("ready");
    await session.commit();

    const reloaded = await app.getWorkspace(workspace.id);
    const loaded = await app.context.adapter.setupStates.getSetupState(
      sharedSetupStateId(app.context.adapter.id, app.context.options.setup),
    );
    expect(loaded?.state).toBeDefined();
    const replay = await reloaded.sandbox.runCommand({
      command: "cat",
      args: ["hello.txt"],
    });
    expect(replay.exitCode).toBe(0);
    expect(replay.stdout.trim()).toBe("ready");
  });

  test("does not persist setup state when setup command fails", async () => {
    const app = createMockSandkit({
      setup: {
        command: "unsupported",
      },
    });
    const workspace = await app.createWorkspace();
    const sharedStateId = sharedSetupStateId(app.context.adapter.id, app.context.options.setup);

    await expect(
      workspace.sandbox.runCommand({
        command: "cat",
        args: ["hello.txt"],
      }),
    ).rejects.toThrow(/Workspace setup failed with exit code 127/);

    const intermediate = await app.context.adapter.setupStates.getSetupState(sharedStateId);
    expect(intermediate).toBeNull();

    await expect(
      workspace.sandbox.runCommand({
        command: "cat",
        args: ["hello.txt"],
      }),
    ).rejects.toThrow(/Workspace setup failed with exit code 127/);

    const afterRetry = await app.context.adapter.setupStates.getSetupState(sharedStateId);
    expect(afterRetry).toBeNull();
  });

  test("rebuilds stale setup state by rerunning setup", async () => {
    const app = sandkit({
      sandbox: internalSandboxProvider(createSetupRecoveryDriverFactory(), "setup-recovery-test"),
      setup: {
        command: "echo",
        args: ["bootstrapped", ">", "hello.txt"],
      },
    });
    const workspace = await app.createWorkspace();
    await app.context.adapter.setupStates.putSetupState({
      id: sharedSetupStateId(app.context.adapter.id, app.context.options.setup),
      state: {
        kind: "stale-setup-recovery",
        sessionId: "stale-setup",
      },
    });
    const observed = await app.getWorkspace(workspace.id);

    const result = await observed.sandbox.runCommand({
      command: "cat",
      args: ["hello.txt"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("bootstrapped");

    const reloaded = await app.context.adapter.setupStates.getSetupState(
      sharedSetupStateId(app.context.adapter.id, app.context.options.setup),
    );
    expect(reloaded?.state.kind).toBe("setup-recovery-snapshot");
  });

  test("isolates bootstrap state per setup command shape", async () => {
    const adapter = createMemoryAdapter();
    const first = createMockSandkit({
      database: adapter,
      setup: {
        command: "echo",
        args: ["first", ">", "hello.txt"],
      },
    });
    const second = createMockSandkit({
      database: adapter,
      setup: {
        command: "echo",
        args: ["second", ">", "hello.txt"],
      },
    });

    const firstWorkspace = await first.createWorkspace();
    const firstRead = await firstWorkspace.sandbox.runCommand({
      command: "cat",
      args: ["hello.txt"],
    });
    expect(firstRead.exitCode).toBe(0);
    expect(firstRead.stdout.trim()).toBe("first");

    const secondWorkspace = await second.createWorkspace();
    const secondRead = await secondWorkspace.sandbox.runCommand({
      command: "cat",
      args: ["hello.txt"],
    });
    expect(secondRead.exitCode).toBe(0);
    expect(secondRead.stdout.trim()).toBe("second");

    const firstSetupStateId = sharedSetupStateId(adapter.id, first.context.options.setup);
    const secondSetupStateId = sharedSetupStateId(adapter.id, second.context.options.setup);
    expect(firstSetupStateId).not.toBe(secondSetupStateId);

    const firstSetupState = await adapter.setupStates.getSetupState(firstSetupStateId);
    const secondSetupState = await adapter.setupStates.getSetupState(secondSetupStateId);
    expect(firstSetupState).toBeTruthy();
    expect(secondSetupState).toBeTruthy();
    expect(firstSetupStateId).toMatch(/shared-bootstrap/);
    expect(secondSetupStateId).toMatch(/shared-bootstrap/);
  });

  test("isolates bootstrap state per setup policy shape", async () => {
    const adapter = createMemoryAdapter();
    const first = createMockSandkit({
      database: adapter,
      setup: {
        command: "echo",
        args: ["shared", ">", "hello.txt"],
      },
    });
    const second = createMockSandkit({
      database: adapter,
      setup: {
        command: "echo",
        args: ["shared", ">", "hello.txt"],
        policy: allowAll(),
      },
    });

    const firstSetupStateId = sharedSetupStateId(adapter.id, first.context.options.setup);
    const secondSetupStateId = sharedSetupStateId(adapter.id, second.context.options.setup);

    expect(firstSetupStateId).not.toBe(secondSetupStateId);
  });

  test("rejects explicit secret-bearing setup policy", async () => {
    const app = createMockSandkit({
      setup: {
        command: "echo",
        args: ["shared", ">", "hello.txt"],
        policy: allowServices([codex({ apiKey: "top-secret" })]),
      },
    });
    const workspace = await app.createWorkspace();

    await expect(
      workspace.sandbox.runCommand({
        command: "cat",
        args: ["hello.txt"],
      }),
    ).rejects.toThrow(/contains an explicit secret and cannot be stored durably/);
  });
});
