import { describe, expect, test } from "bun:test";
import type { CommandResult } from "sandkit";

import {
  OPENCLAW_STARTUP_LEASE_CUSHION_MS,
  ensureGatewayRunning,
  readSessionToken,
  withRetry,
} from "./openclaw-sandbox";

type FakeCommandCall = {
  command: string;
  args: string[];
};

type FakeExecResult = CommandResult;

type FakeSessionExec = {
  (command: string, args: string[]): Promise<FakeExecResult>;
  (input: { command: string; args?: readonly string[] }): Promise<FakeExecResult>;
};

type FakeSessionHandle = {
  url: (port: number) => Promise<string>;
  exec: FakeSessionExec;
  startProcess: {
    (command: string, args: string[]): Promise<{
      processId: string;
      wait: () => Promise<FakeExecResult>;
    }>;
    (input: {
      command: string;
      args: readonly string[];
      onStdout?: ((chunk: string) => void) | undefined;
      onStderr?: ((chunk: string) => void) | undefined;
    }): Promise<{
      processId: string;
      wait: () => Promise<FakeExecResult>;
    }>;
  };
  extendTimeout: (durationMs: number) => Promise<void>;
  commit: () => Promise<void>;
};

type FakeWorkspaceLease = {
  sandboxId: string;
  remainingMs: number;
  expiresAt: string;
  observedAt: string;
};

type FakeWorkspaceHandle = {
  id: string;
  record: {
    id: string;
    status: "active" | "inactive" | "archived";
    createdAt: string;
    updatedAt: string;
    [key: string]: unknown;
  };
  setPolicy: (..._args: unknown[]) => Promise<void>;
  sandbox: {
    getActiveLease: () => Promise<FakeWorkspaceLease | null>;
    attachSession: () => Promise<FakeSessionHandle>;
    openSession: () => Promise<FakeSessionHandle>;
    runCommand: {
      (command: string, args: string[]): Promise<FakeExecResult>;
      (input: { command: string; args?: readonly string[] }): Promise<FakeExecResult>;
    };
  };
};

function createRuntimeConfig() {
  return {
    installSpec: "openclaw@latest",
    aiGatewayApiUrl: "https://api.example.com",
    aiGatewayModel: "gpt-4o-mini",
    gatewayApiKey: "test-key",
    gatewayPort: 3000,
  };
}

function createFakeSession() {
  const commandLog: FakeCommandCall[] = [];
  let bootstrapCheckCalls = 0;
  const extendTimeoutCalls: number[] = [];

  const exec: FakeSessionExec = (async (
    commandOrInput: string | { command: string; args?: readonly string[] },
    argsInput: readonly string[] = [],
  ) => {
    const command =
      typeof commandOrInput === "string" ? commandOrInput : commandOrInput.command;
    const args = typeof commandOrInput === "string" ? argsInput ?? [] : commandOrInput.args ?? [];

    const commandLine = `${command} ${args.join(" ")}`;
    commandLog.push({ command, args: [...args] });

    if (commandLine.includes("test -x '/vercel/sandbox/npm-global/bin/openclaw'")) {
      bootstrapCheckCalls += 1;
      return {
        exitCode: bootstrapCheckCalls === 1 ? 1 : 0,
        stdout: "",
        stderr: bootstrapCheckCalls === 1 ? "missing artifacts" : "",
      };
    }

    if (commandLine.includes("npm install -g --prefix /vercel/sandbox/npm-global")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (commandLine.includes("openclaw.json")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (commandLine.includes("start-openclaw-gateway.sh")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (commandLine.includes("cat '/vercel/sandbox/home/.openclaw/auth-token.txt'")) {
      return { exitCode: 0, stdout: "abc123", stderr: "" };
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  }) as FakeSessionExec;

  const session: FakeSessionHandle = {
    url: async (_port?: number) => "https://sb-2f9avnd8iah9.vercel.run",
    exec,
    startProcess: async (_commandOrInput) => ({
      processId: "123",
      wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }),
    extendTimeout: async (durationMs) => {
      extendTimeoutCalls.push(durationMs);
    },
    commit: async () => undefined,
  };

  return {
    commandLog,
    session,
    getBootstrapCheckCalls: () => bootstrapCheckCalls,
    getExtendTimeoutCalls: () => extendTimeoutCalls.slice(),
  };
}

function createWorkspaceHarness(
  firstLease: FakeWorkspaceLease | null,
  options?: {
    leaseAfterOpenSession?: FakeWorkspaceLease | null;
    shouldAttachSession?: boolean;
    shouldOpenSession?: boolean;
  },
) {
  const { commandLog, session, getBootstrapCheckCalls, getExtendTimeoutCalls } = createFakeSession();
  let activeLease: FakeWorkspaceLease | null = firstLease;
  let getActiveLeaseCalls = 0;
  let attachSessionCalls = 0;
  let openSessionCalls = 0;

  const workspace: FakeWorkspaceHandle = {
    id: "openclaw-production",
    record: {
      id: "openclaw-production",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    setPolicy: async () => undefined,
    sandbox: {
      getActiveLease: async () => {
        getActiveLeaseCalls += 1;
        const current = activeLease;
        if (getActiveLeaseCalls === 1 && firstLease === null) {
          activeLease = options?.leaseAfterOpenSession ?? activeLease;
        }
        return current;
      },
      attachSession: async () => {
        attachSessionCalls += 1;
      if (options?.shouldAttachSession === false) {
        throw new Error("attachSession was not expected for this fixture");
      }
        return session;
      },
      openSession: async () => {
        openSessionCalls += 1;
        if (options?.shouldOpenSession === false) {
          throw new Error("openSession was not expected for this fixture");
        }
        if (firstLease === null && options?.leaseAfterOpenSession) {
          activeLease = options.leaseAfterOpenSession;
        }
        return session;
      },
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
  };

  return {
    commandLog,
    workspace,
    session,
    getBootstrapCheckCalls,
    getExtendTimeoutCalls,
    calls: {
      getActiveLease: () => getActiveLeaseCalls,
      attachSession: () => attachSessionCalls,
      openSession: () => openSessionCalls,
    },
  };
}

function hasCommand(commandLog: FakeCommandCall[], needle: string): boolean {
  return commandLog.some(({ command, args }) => `${command} ${args.join(" ")}`.includes(needle));
}

function getCommandCount(commandLog: FakeCommandCall[], needle: string): number {
  return commandLog.filter(({ command, args }) =>
    `${command} ${args.join(" ")}`.includes(needle),
  ).length;
}

describe("openclaw sandbox retry behavior", () => {
  test("withRetry executes attempts sequentially", async () => {
    let activeAttempts = 0;
    let maxConcurrentAttempts = 0;
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;
        activeAttempts += 1;
        maxConcurrentAttempts = Math.max(maxConcurrentAttempts, activeAttempts);
        if (attempts < 3) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          activeAttempts -= 1;
          throw new Error(`retry-${attempts}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
        activeAttempts -= 1;
        return "ok";
      },
      5,
      1,
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(maxConcurrentAttempts).toBe(1);
  });

  test("readSessionToken reads token file through bash -lc and trims output", async () => {
    const exec: FakeSessionExec = (async (
      commandOrInput: string | { command: string; args?: readonly string[] },
      argsInput: readonly string[] = [],
    ) => {
      const command = typeof commandOrInput === "string" ? commandOrInput : commandOrInput.command;
      const args = typeof commandOrInput === "string" ? argsInput : commandOrInput.args ?? [];
      expect(command).toBe("bash");
      expect(args).toEqual(["-lc", "cat '/vercel/sandbox/home/.openclaw/auth-token.txt'"]);
      return {
        exitCode: 0,
        stdout: "abc123\n",
        stderr: "",
      };
    }) as FakeSessionExec;

  const session: FakeSessionHandle = {
    url: async (_port?: number) => "",
    exec,
    startProcess: async (_commandOrInput: string | { command: string; args?: readonly string[] }) => ({
      processId: "",
      wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }),
      extendTimeout: async () => undefined,
      commit: async () => undefined,
    };

    const token = await readSessionToken(session);

    expect(token).toBe("abc123");
  });

  test("readSessionToken returns empty string when token read fails", async () => {
  const session: FakeSessionHandle = {
    url: async (_port?: number) => "",
    exec: (async () => {
      throw new Error("missing token file");
    }) as FakeSessionExec,
    startProcess: async (_commandOrInput) => ({
      processId: "",
      wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }),
      extendTimeout: async () => undefined,
      commit: async () => undefined,
    };

    const token = await readSessionToken(session);

    expect(token).toBe("");
  });

  test("ensureGatewayRunning repairs bootstrap artifacts even when bootstrap is initially missing", async () => {
    const updates: Record<string, unknown>[] = [];
    const existingLease: FakeWorkspaceLease = {
      sandboxId: "sbx_abc123",
      remainingMs: 30_000,
      expiresAt: "2026-03-23T09:00:00.000Z",
      observedAt: "2026-03-23T08:59:00.000Z",
    };
    const { workspace, commandLog, getBootstrapCheckCalls, getExtendTimeoutCalls, calls } =
      createWorkspaceHarness(existingLease, {
        shouldAttachSession: true,
        shouldOpenSession: false,
      });
    const requiredLeaseMs = 240_000;

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("ready", { status: 200 })) as unknown as typeof fetch;
      const { url } = await ensureGatewayRunning(
        workspace,
        { id: "session-1" },
        async (_id, update) => {
          updates.push(update);
        },
        createRuntimeConfig(),
        requiredLeaseMs,
      );

      expect(url).toBe("https://sb-2f9avnd8iah9.vercel.run");
      expect(calls.attachSession()).toBe(1);
      expect(calls.openSession()).toBe(0);
      expect(calls.getActiveLease()).toBe(2);
      expect(getBootstrapCheckCalls()).toBe(2);
      expect(getExtendTimeoutCalls()).toEqual([requiredLeaseMs - existingLease.remainingMs]);
      expect(getCommandCount(commandLog, "mkdir -p '/vercel/sandbox/home/.openclaw'")).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        getCommandCount(commandLog, "npm install -g --prefix /vercel/sandbox/npm-global"),
      ).toBeGreaterThanOrEqual(1);
      expect(getCommandCount(commandLog, "openclaw.json")).toBeGreaterThanOrEqual(1);
      expect(getCommandCount(commandLog, "start-openclaw-gateway.sh")).toBeGreaterThanOrEqual(1);
      expect(hasCommand(commandLog, "cat '/vercel/sandbox/home/.openclaw/auth-token.txt'")).toBe(true);
      expect(
        hasCommand(commandLog, "test -x '/vercel/sandbox/npm-global/bin/openclaw'"),
      ).toBe(true);

      expect(updates.some((update) => update.phase === "repairing")).toBe(true);
      expect(updates.some((update) => update.phase === "ready")).toBe(true);
      expect(
        updates.find((update) => update.phase === "repairing")?.error_code,
      ).toBe("bootstrap_missing");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("ensureGatewayRunning repairs bootstrap artifacts for a fresh lease", async () => {
    const updates: Record<string, unknown>[] = [];
    const leaseAfterOpenSession: FakeWorkspaceLease = {
      sandboxId: "sbx_abc123",
      remainingMs: 45_000,
      expiresAt: "2026-03-23T09:00:00.000Z",
      observedAt: "2026-03-23T08:59:00.000Z",
    };
    const { workspace, commandLog, getBootstrapCheckCalls, getExtendTimeoutCalls, calls } =
      createWorkspaceHarness(null, {
        leaseAfterOpenSession,
        shouldAttachSession: false,
        shouldOpenSession: true,
      });

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("ready", { status: 200 })) as unknown as typeof fetch;
      const { url } = await ensureGatewayRunning(
        workspace,
        { id: "session-fresh" },
        async (_id, update) => {
          updates.push(update);
        },
        createRuntimeConfig(),
        OPENCLAW_STARTUP_LEASE_CUSHION_MS,
      );

      expect(url).toBe("https://sb-2f9avnd8iah9.vercel.run");
      expect(calls.openSession()).toBe(1);
      expect(calls.attachSession()).toBe(0);
      expect(calls.getActiveLease()).toBe(3);
      expect(getBootstrapCheckCalls()).toBe(2);
      expect(getExtendTimeoutCalls()).toEqual([
        OPENCLAW_STARTUP_LEASE_CUSHION_MS - leaseAfterOpenSession.remainingMs,
      ]);

      expect(getCommandCount(commandLog, "mkdir -p '/vercel/sandbox/home/.openclaw'")).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        getCommandCount(commandLog, "npm install -g --prefix /vercel/sandbox/npm-global"),
      ).toBeGreaterThanOrEqual(1);
      expect(getCommandCount(commandLog, "openclaw.json")).toBeGreaterThanOrEqual(1);
      expect(getCommandCount(commandLog, "start-openclaw-gateway.sh")).toBeGreaterThanOrEqual(1);

      expect(updates.some((update) => update.phase === "repairing")).toBe(true);
      expect(updates.some((update) => update.phase === "ready")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("ensureGatewayRunning reports session-specific message when bootstrap repair still fails", async () => {
    let bootstrapCheckCalls = 0;
    const extendTimeoutCalls: number[] = [];
    const session: FakeSessionHandle = {
      url: async (_port?: number) => "https://sb-2f9avnd8iah9.vercel.run",
      exec: (async (
        commandOrInput: string | { command: string; args?: readonly string[] },
        argsInput: readonly string[] = [],
      ) => {
        const command = typeof commandOrInput === "string" ? commandOrInput : commandOrInput.command;
        const args = typeof commandOrInput === "string" ? argsInput : commandOrInput.args ?? [];
        const commandLine = `${command} ${args.join(" ")}`;
        if (commandLine.includes("test -x '/vercel/sandbox/npm-global/bin/openclaw'")) {
          bootstrapCheckCalls += 1;
          return { exitCode: 1, stdout: "", stderr: "missing artifacts" };
        }

        if (commandLine.includes("npm install -g --prefix /vercel/sandbox/npm-global")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }) as FakeSessionExec,
      startProcess: async (_commandOrInput: string | { command: string; args?: readonly string[] }) => ({
        processId: "123",
        wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
      extendTimeout: async (durationMs) => {
        extendTimeoutCalls.push(durationMs);
      },
      commit: async () => undefined,
    };
  const workspace: FakeWorkspaceHandle = {
    id: "openclaw-production",
    record: {
      id: "openclaw-production",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    setPolicy: async () => undefined,
    sandbox: {
        getActiveLease: async () => ({
          sandboxId: "sbx_abc123",
          remainingMs: 60_000,
          expiresAt: "2026-03-23T09:00:00.000Z",
          observedAt: "2026-03-23T08:59:00.000Z",
        }),
        attachSession: async () => session,
        openSession: async () => session,
      },
    };

    const updates: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("ready", { status: 200 })) as unknown as typeof fetch;
      const start = ensureGatewayRunning(
        workspace,
        { id: "session-fresh-failed-bootstrap" },
        async (_id, update) => {
          updates.push(update);
        },
        createRuntimeConfig(),
        OPENCLAW_STARTUP_LEASE_CUSHION_MS,
      );

      await expect(start).rejects.toThrow(
        "OpenClaw bootstrap artifacts are still missing for session session-fresh-failed-bootstrap after repair attempt.",
      );
      expect(extendTimeoutCalls).toEqual([OPENCLAW_STARTUP_LEASE_CUSHION_MS - 60_000]);
      expect(updates.some((update) => update.phase === "failed")).toBe(true);
      const failed = updates.find((update) => update.phase === "failed") as {
        error_code?: string | null;
        error_message?: string | null;
      } | undefined;
      expect(failed?.error_code).toBe("bootstrap_missing");
      expect(failed?.error_message).toBe(
        "OpenClaw bootstrap artifacts are still missing for session session-fresh-failed-bootstrap after repair attempt.",
      );
      expect(bootstrapCheckCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("ensureGatewayRunning does not extend when the current lease already satisfies the target", async () => {
    const existingLease: FakeWorkspaceLease = {
      sandboxId: "sbx_abc123",
      remainingMs: 300_000,
      expiresAt: "2026-03-23T09:00:00.000Z",
      observedAt: "2026-03-23T08:59:00.000Z",
    };
    const { workspace, getExtendTimeoutCalls } = createWorkspaceHarness(existingLease, {
      shouldAttachSession: true,
      shouldOpenSession: false,
    });

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("ready", { status: 200 })) as unknown as typeof fetch;
      await ensureGatewayRunning(
        workspace,
        { id: "session-no-extend-needed" },
        async () => undefined,
        createRuntimeConfig(),
        240_000,
      );

      expect(getExtendTimeoutCalls()).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
