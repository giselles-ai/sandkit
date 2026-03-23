import { Database } from "bun:sqlite";

import { sandkit } from "@giselles-ai/sandkit";
import { createBunSqliteAdapter } from "@giselles-ai/sandkit/adapters/sqlite-bun";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

const SQLITE_PATH = process.env.SMOKE_WORKSPACE_DB_PATH ?? "./smoke-workspaces.sqlite";
const SANDBOX_TIMEOUT_MS = 60_000;

function assertVercelAuthEnv(): void {
  // Local runs need `VERCEL_OIDC_TOKEN` (`vercel env pull`), CI needs `VERCEL_ACCESS_TOKEN`.
  if (!process.env.VERCEL_OIDC_TOKEN && !process.env.VERCEL_ACCESS_TOKEN) {
    throw new Error(
      "Set VERCEL_OIDC_TOKEN (local) or VERCEL_ACCESS_TOKEN (CI) before running the smoke app.",
    );
  }
}

async function runSmoke(): Promise<void> {
  assertVercelAuthEnv();

  const database = new Database(SQLITE_PATH);
  const workspaceAdapter = createBunSqliteAdapter(database);

  const app = sandkit({
    database: workspaceAdapter,
    sandbox: vercelSandbox({
      timeout: SANDBOX_TIMEOUT_MS,
    }),
  });

  const workspace = await app.createWorkspace({
    name: "smoke-vercel-workspace",
  });

  const writeResult = await workspace.sandbox.runCommand("sh", [
    "-lc",
    "echo 'hello from sandkit' > ./hello.txt",
  ]);

  if (writeResult.exitCode !== 0) {
    database.close();
    throw new Error(writeResult.stderr || "Failed to write hello.txt in Vercel sandbox.");
  }

  database.close();

  const replayDatabase = new Database(SQLITE_PATH);
  const replayWorkspaceAdapter = createBunSqliteAdapter(replayDatabase);
  const replayKit = sandkit({
    database: replayWorkspaceAdapter,
    sandbox: vercelSandbox({
      timeout: SANDBOX_TIMEOUT_MS,
    }),
  });

  const replayWorkspace = await replayKit.getWorkspace(workspace.id);
  const readResult = await replayWorkspace.sandbox.runCommand("cat", ["./hello.txt"]);

  console.log("workspaceId", replayWorkspace.id);
  console.log("writeExitCode", writeResult.exitCode);
  console.log("catExitCode", readResult.exitCode);
  console.log("catStdout", readResult.stdout.trim());

  replayDatabase.close();
}

void runSmoke();
