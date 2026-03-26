import { Database } from "bun:sqlite";

import { createSandkit } from "@giselles-ai/sandkit";
import { createBunSqliteAdapter } from "@giselles-ai/sandkit/adapters/sqlite-bun";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

const SQLITE_PATH = process.env.SMOKE_LOGS_WORKSPACE_DB_PATH ?? "./smoke-workspaces.sqlite";
const SANDBOX_TIMEOUT_MS = 60_000 * 2;

function hasVercelAuth(): boolean {
  return Boolean(process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_ACCESS_TOKEN);
}

function shouldSkip(): string | null {
  if (!hasVercelAuth()) {
    return "missing VERCEL_OIDC_TOKEN or VERCEL_ACCESS_TOKEN";
  }
  return null;
}

async function runSmoke(): Promise<void> {
  const skipReason = shouldSkip();
  if (skipReason) {
    console.log("smokeLogs", "skipped", skipReason);
    return;
  }

  const database = new Database(SQLITE_PATH);
  try {
    const sandkit = createSandkit({
      database: createBunSqliteAdapter(database),
      sandbox: vercelSandbox({
        timeout: SANDBOX_TIMEOUT_MS,
      }),
    });

    const workspace = await sandkit.createWorkspace({
      name: "smoke-vercel-detached-logs",
    });

    const command = await workspace.sandbox.runCommand({
      command: "sh",
      args: [
        "-lc",
        "echo 'smoke-stdout-1'; sleep 1; echo 'smoke-stderr-1' 1>&2; sleep 1; echo 'smoke-stdout-2'; sleep 1; echo 'smoke-stderr-2' 1>&2",
      ],
      detached: true,
    });

    const logs = command.logs?.();
    if (!logs) {
      throw new Error("Smoke failed: detached command logs() was unavailable.");
    }

    let stdout = "";
    let stderr = "";
    let firstLogTs: number | null = null;
    let waitCompletedAt: number | null = null;

    const logCollector = (async () => {
      for await (const chunk of logs) {
        if (firstLogTs === null) {
          firstLogTs = Date.now();
        }
        if (chunk.stream === "stdout") {
          stdout += chunk.chunk;
          process.stdout.write(`[logs-smoke][stdout] ${chunk.chunk}`);
        } else if (chunk.stream === "stderr") {
          stderr += chunk.chunk;
          process.stdout.write(`[logs-smoke][stderr] ${chunk.chunk}`);
        }
      }
    })();

    const completion = command.wait().then((result) => {
      waitCompletedAt = Date.now();
      return result;
    });

    const result = await Promise.all([logCollector, completion]).then(([, waited]) => waited);
    if (result.exitCode !== 0) {
      throw new Error(
        `Smoke failed: detached command exited non-zero.\nexitCode: ${result.exitCode}`,
      );
    }

    if (firstLogTs === null || waitCompletedAt === null) {
      throw new Error(
        "Smoke failed: expected log stream and completion events from detached command.",
      );
    }

    if (firstLogTs > waitCompletedAt) {
      throw new Error("Smoke failed: log chunks were observed only after durable completion.");
    }

    if (
      !stdout.includes("smoke-stdout-1") ||
      !stdout.includes("smoke-stdout-2") ||
      !stderr.includes("smoke-stderr-1") ||
      !stderr.includes("smoke-stderr-2")
    ) {
      throw new Error(
        `Smoke failed: missing expected chunks from detached logs.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }

    console.log("smokeLogs", "ok", workspace.id);
  } finally {
    database.close();
  }
}

void runSmoke();
