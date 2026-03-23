import { describe, expect, test } from "bun:test";

import { allowAll, allowServices, denyAll } from "../policies/dsl.ts";
import type { WorkspaceSessionProcessStartInput } from "../types.ts";
import { ManagedSession } from "./sandbox.ts";

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
        return { exitCode: 0, stdout: "", stderr: "" };
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
});
