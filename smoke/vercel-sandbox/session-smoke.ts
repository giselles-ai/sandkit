import { normalizeCommandLog } from "../../packages/sandkit/src/drivers/vercel-sandbox.ts";
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const baseObservedAtMs = Date.parse(lease.observedAt);
  const baseExpiresAtMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(baseObservedAtMs) || !Number.isFinite(baseExpiresAtMs)) {
    throw new Error("Smoke failed: lease timestamps were not parsable.");
  }
  const extensionMs = 30_000;

  await wait(500);
  const leaseAfterObservation = await workspace.sandbox.getActiveLease();
  if (
    leaseAfterObservation === null ||
    leaseAfterObservation.expiresAt !== lease.expiresAt ||
    leaseAfterObservation.observedAt !== lease.observedAt
  ) {
    throw new Error(
      "Smoke failed: getActiveLease should not refresh lease expiry purely by observation.",
    );
  }

  await session.extendTimeout(extensionMs);
  const leaseAfterExtend = await workspace.sandbox.getActiveLease();
  if (
    leaseAfterExtend === null ||
    Date.parse(leaseAfterExtend.observedAt) <= baseObservedAtMs ||
    Date.parse(leaseAfterExtend.expiresAt) < baseExpiresAtMs + extensionMs
  ) {
    throw new Error("Smoke failed: extendTimeout should advance lease timing.");
  }

  await assertThrows("runCommand with active session", async () => {
    await workspace.sandbox.runCommand("echo", ["hello"]);
  });

  const write = await session.exec("echo", ["session", ">", "hello.txt"]);
  if (write.exitCode !== 0) {
    throw new Error(`Smoke failed: session exec write failed: ${write.stderr}`);
  }

  const attached = await workspace.sandbox.attachSession();
  await wait(500);
  const leaseAfterAttach = await workspace.sandbox.getActiveLease();
  if (
    leaseAfterAttach === null ||
    leaseAfterAttach.expiresAt !== leaseAfterExtend.expiresAt ||
    leaseAfterAttach.observedAt !== leaseAfterExtend.observedAt
  ) {
    throw new Error(
      "Smoke failed: attachSession should not refresh lease expiry purely by observation.",
    );
  }

  const read = await attached.exec("cat", ["hello.txt"]);
  if (read.stdout.trim() !== "session") {
    throw new Error("Smoke failed: attached session could not see command output.");
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const logChunks: string[] = [];
  const startedProcess = await attached.startProcess({
    command: "echo",
    args: ["streaming", "process"],
    onStdout: (chunk) => {
      stdoutChunks.push(chunk);
    },
    onStderr: (chunk) => {
      stderrChunks.push(chunk);
    },
  });
  const startedProcessLogs = startedProcess.logs?.();
  const logCollector = (async () => {
    if (!startedProcessLogs) {
      throw new Error("Smoke failed: expected logs() iterator to be available.");
    }
    for await (const log of startedProcessLogs) {
      if (log.stream === "stdout") {
        logChunks.push(log.chunk);
      }
    }
  })();
  const startProcessResult = await startedProcess.wait();
  if (
    startProcessResult.exitCode !== 0 ||
    startProcessResult.stdout.trim() !== "streaming process"
  ) {
    throw new Error("Smoke failed: startProcess() did not complete with expected output.");
  }
  await logCollector;
  const callbackOutput = stdoutChunks.join("");
  const loggedOutput = logChunks.join("");
  if (!stdoutChunks[0]?.includes("streaming process")) {
    throw new Error("Smoke failed: startProcess onStdout callback did not receive output.");
  }
  if (!loggedOutput.includes("streaming process")) {
    throw new Error(
      "Smoke failed: startProcess logs() did not expose output while callbacks were active.",
    );
  }
  if (!callbackOutput.includes(loggedOutput)) {
    throw new Error(
      "Smoke failed: startProcess callbacks and logs() should observe the same stdout payload.",
    );
  }
  if (stderrChunks.length !== 0) {
    throw new Error(
      "Smoke failed: startProcess onStderr callback should not receive output for successful echo.",
    );
  }

  const normalizedLogChunk = normalizeCommandLog({ stream: "stdout", data: "streamed-via-data" });
  if (!normalizedLogChunk || normalizedLogChunk.chunk !== "streamed-via-data") {
    throw new Error("Smoke failed: normalizeCommandLog should parse Vercel stream/data logs.");
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
