import { describe, expect, test } from "bun:test";

import { allowAll, allowServices, denyAll } from "../policies/dsl.ts";
import type {
  Command,
  CommandResult,
  WorkspaceRunCommandDetachedOptions,
  WorkspaceRunCommandOptions,
  WorkspaceSessionProcessStartInput,
} from "../types.ts";
import { LazySandboxHandle, ManagedSession, ManagedSandbox } from "./sandbox.ts";

describe("ManagedSession", () => {
  test("setPolicy applies to later exec calls without changing workspace default behavior", async () => {
    const appliedPolicies: string[] = [];
    const runCommands: Array<{ command: string; args: readonly string[] }> = [];

    const defaultPolicy = allowServices([
      {
        id: "default-service",
        name: "Default Service",
        domains: ["default.example.com"],
        headers: [],
      },
    ]);
    const livePolicy = allowServices([
      {
        id: "live-service",
        name: "Live Service",
        domains: ["live.example.com"],
        headers: [],
      },
    ]);

    const driver = {
      id: "session-policy-test",
      provider: "memory",
      async applyPolicy(policy) {
        appliedPolicies.push(policy.services.map((service) => service.id).join("|"));
      },
      async getSessionLease() {
        return {
          sandboxId: "session-policy-test",
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          remainingMs: 60_000,
        };
      },
      async runCommand(command: string, args: string[]) {
        runCommands.push({ command, args: [...args] });
        return { wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
      },
      async snapshot() {
        return { kind: "memory", sessionId: "session-policy-test" };
      },
    };

    const session = new ManagedSession(driver, async () => defaultPolicy);

    await session.exec("bash", ["-lc", "echo from default policy"]);
    await session.setPolicy(livePolicy);
    await session.exec("bash", ["-lc", "echo with live policy"]);
    await session.exec({
      command: "bash",
      args: ["-lc", "echo explicit default policy"],
      policy: defaultPolicy,
    });

    expect(runCommands).toHaveLength(3);
    expect(appliedPolicies).toHaveLength(4);
    expect(appliedPolicies).toEqual([
      "default-service",
      "live-service",
      "live-service",
      "default-service",
    ]);
  });

  test("startProcess resolves session policy override and explicit overrides", async () => {
    const appliedPolicies: string[] = [];
    let processCallCount = 0;
    let processInputPolicyIds: string[] = [];
    let startedArgs: string[] = [];

    const defaultPolicy = allowAll();
    const overridePolicy = denyAll();
    const explicitPolicy = allowServices([
      {
        id: "explicit-service",
        name: "Explicit Service",
        domains: ["explicit.example.com"],
        headers: [],
      },
    ]);

    const driver = {
      id: "session-policy-process-test",
      provider: "memory",
      async applyPolicy(policy) {
        const value =
          policy.mode === "allow-all"
            ? "allow-all"
            : policy.mode === "deny-all"
              ? "deny-all"
              : policy.services.map((service) => service.id).join("|");
        appliedPolicies.push(value);
      },
      async getSessionLease() {
        return {
          sandboxId: "session-policy-process-test",
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          remainingMs: 60_000,
        };
      },
      async runCommand() {
        throw new Error("runCommand should not be used for this test");
      },
      async startProcess(input: WorkspaceSessionProcessStartInput) {
        processCallCount += 1;
        const policyName =
          input.policy === undefined
            ? "missing"
            : input.policy.mode === "allow-all"
              ? "allow-all"
              : input.policy.mode === "deny-all"
                ? "deny-all"
                : input.policy.services.map((service) => service.id).join("|");
        processInputPolicyIds = [...processInputPolicyIds, policyName];
        startedArgs = [...input.args];
        return {
          processId: "proc-1",
          wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        };
      },
      async snapshot() {
        return { kind: "memory", sessionId: "session-policy-process-test" };
      },
    };

    const session = new ManagedSession(driver, async () => defaultPolicy);
    await session.setPolicy(overridePolicy);
    await session.startProcess("bash", ["-lc", "echo from override policy"]);
    await session.startProcess({
      command: "bash",
      args: ["-lc", "echo with explicit override"],
      policy: explicitPolicy,
    });

    expect(processCallCount).toBe(2);
    expect(processInputPolicyIds).toEqual(["deny-all", "explicit-service"]);
    expect(appliedPolicies).toEqual(["deny-all", "deny-all", "explicit-service"]);
    expect(startedArgs).toEqual(["-lc", "echo with explicit override"]);
  });

  test("session exec rejects detached execution", async () => {
    const session = new ManagedSession(
      {
        id: "session-detached-test",
        provider: "memory",
        async applyPolicy() {},
        async getSessionLease() {
          return {
            sandboxId: "session-detached-test",
            observedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            remainingMs: 60_000,
          };
        },
        async runCommand() {
          return { wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
        },
        async snapshot() {
          return { kind: "memory", sessionId: "session-detached-test" };
        },
      },
      async () => allowAll(),
    );

    await expect(
      session.exec({
        // @ts-expect-error Runtime guard intentionally rejects this durable-only flag.
        command: "bash",
        args: ["-lc", "echo should not be allowed"],
        detached: true,
      } as never),
    ).rejects.toThrow(/session exec does not support detached execution/i);
  });
});

describe("WorkspaceSandboxHandle", () => {
  test("runCommand without detached returns CommandResult", async () => {
    const managed = new ManagedSandbox(
      {
        id: "public-command-result",
        provider: "memory",
        async applyPolicy() {},
        async runCommand() {
          return {
            wait: async () => ({ exitCode: 0, stdout: "result", stderr: "" }),
          };
        },
        async snapshot() {
          return { kind: "memory", sessionId: "public-command-result" };
        },
      },
      async () => allowAll(),
    );

    const handle = new LazySandboxHandle(
      async () => managed,
      async () => {
        throw new Error("openSession should not be called");
      },
      async () => {
        throw new Error("attachSession should not be called");
      },
      async () => null,
    );

    const result = await handle.runCommand({
      command: "echo",
      args: ["done"],
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "result",
      stderr: "",
    });
  });

  test("runCommand with detached true returns a live Command", async () => {
    const handle = new LazySandboxHandle(
      async () =>
        new ManagedSandbox(
          {
            id: "public-command-live",
            provider: "memory",
            async applyPolicy() {},
            async runCommand() {
              return {
                wait: async () => ({ exitCode: 0, stdout: "live", stderr: "" }),
                logs: () => {
                  return {
                    async *[Symbol.asyncIterator]() {
                      yield { stream: "stdout", chunk: "live\n" };
                    },
                  };
                },
              };
            },
            async snapshot() {
              return { kind: "memory", sessionId: "public-command-live" };
            },
          },
          async () => allowAll(),
        ),
      async () => {
        throw new Error("openSession should not be called");
      },
      async () => {
        throw new Error("attachSession should not be called");
      },
      async () => null,
    );

    const command = await handle.runCommand({
      command: "echo",
      args: ["detached"],
      detached: true,
    });

    const chunks: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    if (command.logs) {
      for await (const chunk of command.logs()) {
        chunks.push(chunk);
      }
    }

    expect(chunks).toEqual([{ stream: "stdout", chunk: "live\n" }]);
    expect(await command.wait()).toEqual({
      exitCode: 0,
      stdout: "live",
      stderr: "",
    });
  });

  test("runCommand overloads preserve detached typing through variable inputs", async () => {
    const handle = new LazySandboxHandle(
      async () =>
        new ManagedSandbox(
          {
            id: "public-command-typed-overload",
            provider: "memory",
            async applyPolicy() {},
            async runCommand() {
              return {
                wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
              };
            },
            async snapshot() {
              return { kind: "memory", sessionId: "public-command-typed-overload" };
            },
          },
          async () => allowAll(),
        ),
      async () => {
        throw new Error("openSession should not be called");
      },
      async () => {
        throw new Error("attachSession should not be called");
      },
      async () => null,
    );

    const detachedOptions: WorkspaceRunCommandDetachedOptions = {
      command: "echo",
      args: ["hi"],
      detached: true,
    };
    const nonDetachedOptions: WorkspaceRunCommandOptions = {
      command: "echo",
      args: ["again"],
    };

    const detachedResult = handle.runCommand(detachedOptions);
    const nonDetachedResult = handle.runCommand(nonDetachedOptions);

    const detachedAsCommand: Promise<Command> = detachedResult;
    const nonDetachedAsCommandResult: Promise<CommandResult> = nonDetachedResult;

    const detachedCommand = await detachedAsCommand;
    await expect(detachedCommand.wait()).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    await expect(nonDetachedAsCommandResult).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });
});

describe("ManagedSandbox", () => {
  test("runCommand starts durable finalize before caller awaits wait()", async () => {
    const events: string[] = [];
    const snapshotState = { kind: "memory", sessionId: "managed-sandbox-test" };
    let resolveCommandWait:
      | ((result: { exitCode: number; stdout: string; stderr: string }) => void)
      | undefined;
    const commandWait = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolve) => {
        resolveCommandWait = resolve;
      },
    );

    const managed = new ManagedSandbox(
      {
        id: "managed-sandbox-test",
        provider: "memory",
        async applyPolicy() {
          events.push("applyPolicy");
        },
        async runCommand() {
          return {
            wait: async () => {
              events.push("commandWait");
              return commandWait;
            },
          };
        },
        async snapshot() {
          events.push("snapshot");
          return snapshotState;
        },
      },
      async () => allowAll(),
      async () => {
        events.push("persist");
      },
      {
        onRunStart: async () => {
          events.push("runStart");
          return "run-id";
        },
        onRunFinish: async () => {
          events.push("runFinish");
        },
      },
    );

    const command = await managed.runCommand("echo", ["done"]);
    expect(events).toEqual(["runStart", "applyPolicy", "commandWait"]);

    resolveCommandWait?.({ exitCode: 0, stdout: "ok", stderr: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContain("snapshot");

    const result = await command.wait();
    expect(result).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(events).toEqual([
      "runStart",
      "applyPolicy",
      "commandWait",
      "snapshot",
      "persist",
      "runFinish",
    ]);
  });

  test("detached command exposes logs() as an ephemeral stream", async () => {
    const managed = new ManagedSandbox(
      {
        id: "detached-stream-test",
        provider: "memory",
        async applyPolicy() {},
        async runCommand() {
          return {
            wait: async () => ({ exitCode: 0, stdout: "stdout", stderr: "" }),
            logs: () => {
              return {
                async *[Symbol.asyncIterator]() {
                  yield { stream: "stdout", chunk: "hello\n" };
                  yield { stream: "stderr", chunk: "warn\n" };
                },
              };
            },
          };
        },
        async snapshot() {
          return { kind: "memory", sessionId: "detached-stream-test" };
        },
      },
      async () => allowAll(),
    );

    const command = await managed.runCommand({
      command: "echo",
      args: ["-lc", "hi"],
      detached: true,
    });
    if (!command.logs) {
      expect.unreachable("Expected detached command to expose logs()");
    }

    const chunks: Array<{ stream: string; chunk: string }> = [];
    for await (const chunk of command.logs()) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { stream: "stdout", chunk: "hello\n" },
      { stream: "stderr", chunk: "warn\n" },
    ]);

    const result = await command.wait();
    expect(result.stdout).toBe("stdout");
    expect(result.exitCode).toBe(0);
  });

  test("runCommand finalizes a failed run when command start throws before a handle exists", async () => {
    const events: string[] = [];

    const managed = new ManagedSandbox(
      {
        id: "start-failure-test",
        provider: "memory",
        async applyPolicy() {
          events.push("applyPolicy");
        },
        async runCommand() {
          throw new Error("launch failed");
        },
        async snapshot() {
          events.push("snapshot");
          return { kind: "memory", sessionId: "start-failure-test" };
        },
      },
      async () => allowAll(),
      async () => {
        events.push("persist");
      },
      {
        onRunStart: async () => {
          events.push("runStart");
          return "run-id";
        },
        onRunFinish: async () => {
          events.push("runFinish");
        },
      },
    );

    await expect(managed.runCommand("echo", ["done"])).rejects.toThrow("launch failed");
    expect(events).toEqual(["runStart", "applyPolicy", "snapshot", "persist", "runFinish"]);
  });
});
