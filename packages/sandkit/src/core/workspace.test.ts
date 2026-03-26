import { describe, expect, test } from "bun:test";

import { createMemoryAdapter } from "../adapters/memory.ts";
import { internalSandboxProvider, mockSandbox } from "../integrations/mock.ts";
import { codex } from "../policies/codex.ts";
import { allowAll, allowServices } from "../policies/dsl.ts";
import type {
  Command,
  CommandResult,
  PersistedSandboxState,
  SandboxDriver,
  SandboxDriverFactory,
  WorkspaceRecord,
  WorkspacePolicy,
  SandkitOptions,
} from "../types.ts";
import type { WorkspaceSessionHandle } from "./sandbox.ts";
import { Sandkit, createSandkit } from "./sandkit.ts";
import { sharedSetupStateId } from "./workspace.ts";

const bootstrapPolicy = allowAll();

interface CaptureCall {
  options: {
    policyMode: WorkspacePolicy["mode"];
    exposedPorts?: readonly number[];
    timeoutMs?: number;
  };
}

function createWorkspaceCreateOptionRecorder() {
  const createCalls: CaptureCall[] = [];
  const resumeCalls: CaptureCall[] = [];

  const factory: SandboxDriverFactory = {
    async createSandbox(_workspace: WorkspaceRecord, options) {
      createCalls.push({
        options: {
          policyMode: options.policy.mode,
          exposedPorts: options.exposedPorts,
          timeoutMs: options.timeoutMs,
        },
      });

      return {
        id: `capture-${createCalls.length}`,
        provider: "capture-test",
        async applyPolicy() {},
        async getSessionLease() {
          const observedAt = new Date().toISOString();
          return {
            sandboxId: `capture-${createCalls.length}`,
            observedAt,
            expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
          };
        },
        async runCommand(): Promise<Command> {
          return {
            wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          };
        },
        async snapshot() {
          return {
            kind: "capture",
            sessionId: `capture-${createCalls.length}`,
            state: {
              setup: false,
            },
          };
        },
      };
    },
    async resumeSandbox(_workspace: WorkspaceRecord, _snapshot: PersistedSandboxState, options) {
      resumeCalls.push({
        options: {
          policyMode: options.policy.mode,
          exposedPorts: options.exposedPorts,
          timeoutMs: options.timeoutMs,
        },
      });

      return {
        id: `capture-resume-${resumeCalls.length}`,
        provider: "capture-test",
        async applyPolicy() {},
        async getSessionLease() {
          const observedAt = new Date().toISOString();
          return {
            sandboxId: `capture-resume-${resumeCalls.length}`,
            observedAt,
            expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
          };
        },
        async runCommand(): Promise<Command> {
          return {
            wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          };
        },
        async snapshot() {
          return {
            kind: "capture",
            sessionId: `capture-resume-${resumeCalls.length}`,
            state: {
              setup: true,
            },
          };
        },
      };
    },
  };

  return {
    factory,
    createCalls,
    resumeCalls,
  };
}

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

    async runCommand(command: string, args: string[]): Promise<Command> {
      let result: CommandResult;
      switch (command) {
        case "echo": {
          const redirectIndex = args.indexOf(">");
          if (redirectIndex === -1) {
            result = {
              exitCode: 0,
              stderr: "",
              stdout: `${args.join(" ")}\n`,
            };
            break;
          }

          const target = args[redirectIndex + 1];
          if (!target) {
            result = { exitCode: 1, stderr: "missing redirect target\n", stdout: "" };
            break;
          }

          this.#files[target] = args.slice(0, redirectIndex).join(" ");
          result = { exitCode: 0, stderr: "", stdout: "" };
          break;
        }
        case "cat": {
          const target = args[0];
          if (!target || this.#files[target] === undefined) {
            result = { exitCode: 1, stderr: `cat: ${target}: missing\n`, stdout: "" };
            break;
          }

          result = {
            exitCode: 0,
            stderr: "",
            stdout: `${this.#files[target]}\n`,
          };
          break;
        }
        default:
          result = { exitCode: 127, stderr: `unsupported: ${command}\n`, stdout: "" };
          break;
      }
      return { wait: async () => result };
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

function createBootstrapRecorderDriverFactory() {
  let createCount = 0;
  let resumeCount = 0;
  let snapshotCount = 0;

  const factory: SandboxDriverFactory = {
    async createSandbox() {
      createCount += 1;
      return {
        id: `bootstrap-create-${createCount}`,
        provider: "bootstrap-recorder",
        async applyPolicy() {},
        async getSessionLease() {
          const observedAt = new Date().toISOString();
          return {
            sandboxId: `bootstrap-create-${createCount}`,
            observedAt,
            expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
          };
        },
        async runCommand(): Promise<Command> {
          return {
            wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          };
        },
        async snapshot() {
          snapshotCount += 1;
          return {
            kind: "bootstrap-recorder",
            sessionId: `bootstrap-create-${createCount}`,
            state: { files: {} },
          };
        },
      };
    },
    async resumeSandbox() {
      resumeCount += 1;
      return {
        id: `bootstrap-resume-${resumeCount}`,
        provider: "bootstrap-recorder",
        async applyPolicy() {},
        async getSessionLease() {
          const observedAt = new Date().toISOString();
          return {
            sandboxId: `bootstrap-resume-${resumeCount}`,
            observedAt,
            expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
          };
        },
        async runCommand(): Promise<Command> {
          return {
            wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          };
        },
        async snapshot() {
          snapshotCount += 1;
          return {
            kind: "bootstrap-recorder",
            sessionId: `bootstrap-resume-${resumeCount}`,
            state: { files: {} },
          };
        },
      };
    },
  };

  return {
    factory,
    get createCount() {
      return createCount;
    },
    get resumeCount() {
      return resumeCount;
    },
    get snapshotCount() {
      return snapshotCount;
    },
  };
}

function createMockSandkit(input: Omit<SandkitOptions, "sandbox"> = {}): Sandkit {
  return createSandkit({
    ...input,
    sandbox: mockSandbox(),
  });
}

describe("Workspace session policy lifecycle", () => {
  test("requires sandbox provider in construction options", async () => {
    expect(() => {
      createSandkit(undefined as unknown as SandkitOptions);
    }).toThrow("SandkitOptions is required");

    expect(() => {
      createSandkit({} as SandkitOptions);
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

    const sandkit = createMockSandkit();
    const workspace = await sandkit.createWorkspace({ policy: defaultPolicy });
    const session = await workspace.sandbox.openSession();

    const before = await session.exec("policy-id", []);
    expect(before.stdout.trim()).toBe("allow-services:bootstrap");

    await session.setPolicy(livePolicy);
    const whileSetLive = await session.exec("policy-id", []);
    expect(whileSetLive.stdout.trim()).toBe("allow-services:live");

    const reloadedWorkspace = await sandkit.getWorkspace(workspace.id);
    const reattachedSession = await reloadedWorkspace.sandbox.attachSession();
    const afterReattach = await reattachedSession.exec("policy-id", []);
    expect(afterReattach.stdout.trim()).toBe("allow-services:live");
  });

  test("persists durable sandbox create options across create/resume", async () => {
    const { factory, createCalls, resumeCalls } = createWorkspaceCreateOptionRecorder();
    const sandkit = createSandkit({
      sandbox: internalSandboxProvider(factory, "vercel-test"),
    });

    const workspace = await sandkit.createWorkspace({
      sandbox: {
        exposedPorts: [3000, 3001],
      },
    });

    const firstRun = await workspace.sandbox.runCommand("cat", ["hello.txt"]);
    expect(firstRun.exitCode).toBe(0);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].options.policyMode).toBe("allow-all");
    expect(createCalls[0].options.exposedPorts).toEqual([3000, 3001]);
    expect(createCalls[0].options.timeoutMs).toBeUndefined();

    const reloadedWorkspace = await sandkit.getWorkspace(workspace.id);
    const secondRun = await reloadedWorkspace.sandbox.runCommand("cat", ["hello.txt"]);
    expect(secondRun.exitCode).toBe(0);
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0].options.exposedPorts).toEqual([3000, 3001]);
  });

  test("passes openSession timeoutMs override to create/restore options", async () => {
    const { factory, createCalls, resumeCalls } = createWorkspaceCreateOptionRecorder();
    const sandkit = createSandkit({
      sandbox: internalSandboxProvider(factory, "vercel-test"),
    });

    const workspace = await sandkit.createWorkspace({
      sandbox: {
        exposedPorts: [8080],
      },
    });

    await workspace.sandbox.openSession({ timeoutMs: 120_000 });
    expect(createCalls).toHaveLength(1);
    expect(resumeCalls).toHaveLength(0);
    expect(createCalls[0].options.timeoutMs).toBe(120_000);
    expect(createCalls[0].options.exposedPorts).toEqual([8080]);
  });
});

describe("Workspace setup lifecycle", () => {
  test("bootstrap() materializes shared setup state when missing", async () => {
    const sandkit = createMockSandkit({
      setup: {
        command: "echo",
        args: ["bootstrapped", ">", "hello.txt"],
        policy: bootstrapPolicy,
      },
    });
    const sharedStateId = sharedSetupStateId(
      sandkit.context.adapter.id,
      sandkit.context.options.setup,
    );
    expect(await sandkit.context.adapter.setupStates.getSetupState(sharedStateId)).toBeNull();

    await sandkit.bootstrap();

    const sharedState = await sandkit.context.adapter.setupStates.getSetupState(sharedStateId);
    expect(sharedState).toBeTruthy();
    const workspace = await sandkit.createWorkspace({ id: "bootstrap-run-command" });
    const result = await workspace.sandbox.runCommand({
      command: "cat",
      args: ["hello.txt"],
    });
    expect(result.stdout.trim()).toBe("bootstrapped");
  });

  test("bootstrap() leaves existing shared setup state unchanged", async () => {
    const sandkit = createSandkit({
      sandbox: internalSandboxProvider(createSetupRecoveryDriverFactory(), "setup-recovery-test"),
      setup: {
        command: "echo",
        args: ["bootstrapped", ">", "hello.txt"],
        policy: bootstrapPolicy,
      },
    });
    await sandkit.context.adapter.setupStates.putSetupState({
      id: sharedSetupStateId(sandkit.context.adapter.id, sandkit.context.options.setup),
      state: {
        kind: "stale-setup-recovery",
        sessionId: "stale-setup",
      },
    });

    await sandkit.bootstrap();

    const reloaded = await sandkit.context.adapter.setupStates.getSetupState(
      sharedSetupStateId(sandkit.context.adapter.id, sandkit.context.options.setup),
    );
    expect(reloaded?.state.kind).toBe("stale-setup-recovery");
  });

  test("bootstrap() is no-op when setup is not configured", async () => {
    const sandkit = createMockSandkit();
    await expect(sandkit.bootstrap()).resolves.toBeUndefined();
  });

  test("bootstrap() does not rerun setup when shared state already exists", async () => {
    const recorder = createBootstrapRecorderDriverFactory();
    const sandkit = createSandkit({
      sandbox: internalSandboxProvider(recorder.factory, "bootstrap-recorder"),
      setup: {
        command: "echo",
        args: ["hello"],
        policy: bootstrapPolicy,
      },
    });

    await sandkit.bootstrap();
    await sandkit.bootstrap();

    expect(recorder.createCount).toBe(1);
    expect(recorder.resumeCount).toBe(0);
    expect(recorder.snapshotCount).toBe(1);
  });

  test("requires setup.policy for bootstrap and workspace setup execution", async () => {
    const sandkit = createSandkit({
      sandbox: mockSandbox(),
      // @ts-expect-error Exercise runtime validation of required setup.policy.
      setup: {
        command: "echo",
        args: ["hello"],
      },
    });

    await expect(sandkit.bootstrap()).rejects.toThrow(/Shared setup policy is required/);
  });

  test("runs setup before the first durable command and does not rerun it once state exists", async () => {
    const sandkit = createMockSandkit({
      setup: {
        command: "echo",
        args: ["hello", ">", "hello.txt"],
        policy: bootstrapPolicy,
      },
    });
    const workspace = await sandkit.createWorkspace({
      id: "shared-setup-command",
    });

    const firstRead = await workspace.sandbox.runCommand({
      command: "cat",
      args: ["hello.txt"],
    });
    expect(firstRead.exitCode).toBe(0);
    expect(firstRead.stdout.trim()).toBe("hello");
    const recordedSetupState = await sandkit.context.adapter.setupStates.getSetupState(
      sharedSetupStateId(sandkit.context.adapter.id, sandkit.context.options.setup),
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
    const sandkit = createMockSandkit({
      setup: {
        command: "echo",
        args: ["ready", ">", "hello.txt"],
        policy: bootstrapPolicy,
      },
    });
    const workspace = await sandkit.createWorkspace();

    const session = await workspace.sandbox.openSession();
    const sessionRead = await session.exec({
      command: "cat",
      args: ["hello.txt"],
    });
    expect(sessionRead.exitCode).toBe(0);
    expect(sessionRead.stdout.trim()).toBe("ready");
    await session.commit();

    const reloaded = await sandkit.getWorkspace(workspace.id);
    const loaded = await sandkit.context.adapter.setupStates.getSetupState(
      sharedSetupStateId(sandkit.context.adapter.id, sandkit.context.options.setup),
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
    const sandkit = createMockSandkit({
      setup: {
        command: "unsupported",
        policy: bootstrapPolicy,
      },
    });
    const workspace = await sandkit.createWorkspace();
    const sharedStateId = sharedSetupStateId(
      sandkit.context.adapter.id,
      sandkit.context.options.setup,
    );

    await expect(
      workspace.sandbox.runCommand({
        command: "cat",
        args: ["hello.txt"],
      }),
    ).rejects.toThrow(/Workspace setup failed with exit code 127/);

    const intermediate = await sandkit.context.adapter.setupStates.getSetupState(sharedStateId);
    expect(intermediate).toBeNull();

    await expect(
      workspace.sandbox.runCommand({
        command: "cat",
        args: ["hello.txt"],
      }),
    ).rejects.toThrow(/Workspace setup failed with exit code 127/);

    const afterRetry = await sandkit.context.adapter.setupStates.getSetupState(sharedStateId);
    expect(afterRetry).toBeNull();
  });

  test("rebuilds stale setup state by rerunning setup", async () => {
    const sandkit = createSandkit({
      sandbox: internalSandboxProvider(createSetupRecoveryDriverFactory(), "setup-recovery-test"),
      setup: {
        command: "echo",
        args: ["bootstrapped", ">", "hello.txt"],
        policy: bootstrapPolicy,
      },
    });
    const workspace = await sandkit.createWorkspace();
    await sandkit.context.adapter.setupStates.putSetupState({
      id: sharedSetupStateId(sandkit.context.adapter.id, sandkit.context.options.setup),
      state: {
        kind: "stale-setup-recovery",
        sessionId: "stale-setup",
      },
    });
    const observed = await sandkit.getWorkspace(workspace.id);

    const result = await observed.sandbox.runCommand({
      command: "cat",
      args: ["hello.txt"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("bootstrapped");

    const reloaded = await sandkit.context.adapter.setupStates.getSetupState(
      sharedSetupStateId(sandkit.context.adapter.id, sandkit.context.options.setup),
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
        policy: bootstrapPolicy,
      },
    });
    const second = createMockSandkit({
      database: adapter,
      setup: {
        command: "echo",
        args: ["second", ">", "hello.txt"],
        policy: bootstrapPolicy,
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
        policy: bootstrapPolicy,
      },
    });
    const second = createMockSandkit({
      database: adapter,
      setup: {
        command: "echo",
        args: ["shared", ">", "hello.txt"],
        policy: allowServices([
          {
            id: "bootstrap-policy",
            name: "Bootstrap Policy",
            domains: ["bootstrap.example.com"],
          },
        ]),
      },
    });

    const firstSetupStateId = sharedSetupStateId(adapter.id, first.context.options.setup);
    const secondSetupStateId = sharedSetupStateId(adapter.id, second.context.options.setup);

    expect(firstSetupStateId).not.toBe(secondSetupStateId);
  });

  test("rejects explicit secret-bearing setup policy", async () => {
    const sandkit = createMockSandkit({
      setup: {
        command: "echo",
        args: ["shared", ">", "hello.txt"],
        policy: allowServices([codex({ apiKey: "top-secret" })]),
      },
    });
    const workspace = await sandkit.createWorkspace();

    await expect(
      workspace.sandbox.runCommand({
        command: "cat",
        args: ["hello.txt"],
      }),
    ).rejects.toThrow(/contains an explicit secret and cannot be stored durably/);
  });

  test("prevents overlapping durable commands and openSession while a durable command is in flight", async () => {
    const releaseCommandWaits: Array<(result: CommandResult) => void> = [];
    const workspaceId = "in-flight-durable-lock";
    const createCountCalls: string[] = [];
    const resumeCountCalls: string[] = [];

    const createDurableLockDriver = (
      id: string,
      runCommandFactory: () => Promise<Command> = () =>
        Promise.resolve({
          wait: async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          }),
        } as Command),
    ): SandboxDriver => ({
      id,
      provider: "durable-lock-test",
      async applyPolicy() {},
      async getSessionLease() {
        const observedAt = new Date().toISOString();
        return {
          sandboxId: id,
          observedAt,
          expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
          remainingMs: 60_000,
        };
      },
      async runCommand(): Promise<Command> {
        return runCommandFactory();
      },
      async snapshot() {
        return {
          kind: "capture",
          sessionId: id,
          state: { files: {} },
        };
      },
    });

    const createDriverFromState = (snapshotState?: PersistedSandboxState) => {
      const resumedId =
        snapshotState && snapshotState.kind === "sandbox-session"
          ? snapshotState.sessionId
          : `durable-lock-resume-${resumeCountCalls.length + 1}`;
      return createDurableLockDriver(resumedId);
    };

    const factory = {
      async createSandbox() {
        createCountCalls.push("create");
        return createDurableLockDriver(`durable-lock-${createCountCalls.length}`, async () => {
          const wait = new Promise<CommandResult>((resolve) => {
            releaseCommandWaits.push(resolve);
          });
          return {
            wait: async () => wait,
          };
        });
      },
      async resumeSandbox(_workspace: WorkspaceRecord, snapshot: PersistedSandboxState) {
        resumeCountCalls.push("resume");
        return createDriverFromState(snapshot);
      },
    };

    const sandkit = createSandkit({
      sandbox: internalSandboxProvider(factory),
    });
    const workspace = await sandkit.createWorkspace({ id: workspaceId });
    const _firstCommand = await workspace.sandbox.runCommand({
      command: "sleep",
      args: ["100"],
      detached: true,
    });

    await expect(
      workspace.sandbox.runCommand({
        command: "echo",
        args: ["another"],
      }),
    ).rejects.toThrow(/durable command is still in flight/i);

    await expect(workspace.sandbox.openSession()).rejects.toThrow(
      /durable command is still in flight/i,
    );

    const attached = await sandkit.getWorkspace(workspace.id);
    await expect(attached.sandbox.openSession()).rejects.toThrow(
      /durable command is still in flight/i,
    );

    // Resolve detached completion without calling firstCommand.wait().
    releaseCommandWaits[0]({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    let sessionAfterCompletion: WorkspaceSessionHandle | undefined;
    for (let i = 0; i < 25; i++) {
      try {
        sessionAfterCompletion = await workspace.sandbox.openSession();
        break;
      } catch (error) {
        if (!/durable command is still in flight/i.test(`${error}`)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    if (!sessionAfterCompletion) {
      throw new Error("Expected durable lock to release after detached completion.");
    }

    await sessionAfterCompletion.commit();

    const againCommand = workspace.sandbox.runCommand({
      command: "echo",
      args: ["again"],
    });
    releaseCommandWaits[1]?.({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    await expect(againCommand).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });
});
