import {
  createMemoryAdapter,
  MockSandboxDriverFactory,
  sandkit,
} from "../../packages/sandkit/src/index.ts";

async function assertThrows(message: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!error) {
      throw new Error(`Smoke assertion failed: ${message} threw an empty error`);
    }
    return;
  }

  throw new Error(`Smoke assertion failed: ${message} did not throw`);
}

async function runSmoke(): Promise<void> {
  const app = sandkit({
    database: createMemoryAdapter(),
    sandbox: {
      driverFactory: new MockSandboxDriverFactory(),
    },
  });

  const workspace = await app.createWorkspace({ name: "session-smoke" });
  const noLease = await workspace.sandbox.getActiveLease();
  if (noLease !== null) {
    throw new Error("Smoke failed: expected no active lease on fresh workspace.");
  }

  const session = await workspace.sandbox.openSession();
  const lease = await workspace.sandbox.getActiveLease();
  if (lease === null || !lease.expiresAt) {
    throw new Error("Smoke failed: expected active lease after openSession().");
  }

  await assertThrows("runCommand with active session", async () => {
    await workspace.sandbox.runCommand("echo", ["hello"]);
  });

  const write = await session.exec("echo", ["session", ">", "hello.txt"]);
  if (write.exitCode !== 0) {
    throw new Error(`Smoke failed: session exec write failed: ${write.stderr}`);
  }

  const attached = await workspace.sandbox.attachSession();
  const read = await attached.exec("cat", ["hello.txt"]);
  if (read.stdout.trim() !== "session") {
    throw new Error("Smoke failed: attached session could not see command output.");
  }

  await attached.commit();
  const afterCommitLease = await workspace.sandbox.getActiveLease();
  if (afterCommitLease !== null) {
    throw new Error("Smoke failed: expected no active lease after session commit.");
  }

  await assertThrows("session methods after commit", async () => {
    await session.exec("echo", ["again"]);
  });

  const replay = await workspace.sandbox.runCommand("cat", ["hello.txt"]);
  if (replay.exitCode !== 0 || replay.stdout.trim() !== "session") {
    throw new Error("Smoke failed: expected durable replay after session commit.");
  }

  const workspaceWithNonAttachable = await app.createWorkspace({
    name: "session-non-attachable-smoke",
  });
  await app.context.adapter.workspaces.updateWorkspace(workspaceWithNonAttachable.id, {
    metadata: {
      "sandkit:sandbox": {
        kind: "command",
        sessionId: "non-attachable-session",
      },
    },
  });

  await assertThrows("attachSession on non-attachable session", async () => {
    await workspaceWithNonAttachable.sandbox.attachSession();
  });

  const recoveredFromLegacy = await workspaceWithNonAttachable.sandbox.runCommand("echo", [
    "stale",
  ]);
  if (recoveredFromLegacy.exitCode !== 0) {
    throw new Error("Smoke failed: expected legacy non-attachable state to clear for runCommand.");
  }

  const expiredSessionWorkspace = await app.createWorkspace({
    name: "session-expired-clear-smoke",
  });
  const observedAt = new Date(Date.now() - 90_000).toISOString();
  await app.context.adapter.workspaces.updateWorkspace(expiredSessionWorkspace.id, {
    metadata: {
      "sandkit:sandbox": {
        kind: "session",
        sessionId: "expired-session",
        lease: {
          observedAt,
          expiresAt: new Date(Date.now() - 30_000).toISOString(),
        },
      },
    },
  });

  const expiredLease = await expiredSessionWorkspace.sandbox.getActiveLease();
  if (expiredLease !== null) {
    throw new Error("Smoke failed: expected expired session lease to clear.");
  }

  const postClearRun = await expiredSessionWorkspace.sandbox.runCommand("echo", ["alive"]);
  if (postClearRun.exitCode !== 0) {
    throw new Error("Smoke failed: expected runCommand to proceed after expired session clear.");
  }

  console.log("smokeSessionWorkspaceId", workspace.id);
}

void runSmoke();
