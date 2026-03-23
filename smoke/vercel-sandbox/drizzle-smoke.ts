import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { sandkit } from "@giselles-ai/sandkit";
import { drizzleAdapter } from "@giselles-ai/sandkit/adapters/drizzle";
import { MockSandboxDriverFactory } from "@giselles-ai/sandkit/integrations/mock";
import { drizzle } from "drizzle-orm/bun-sqlite";
// Internal-seam smoke: generate command is intentionally imported from package internals.

import { runGenerateCommand } from "./internal-seams.ts";

const SQLITE_PATH = process.env.SMOKE_DRIZZLE_DB_PATH ?? "./smoke-drizzle-workspaces.sqlite";
const SCHEMA_PATH = "smoke-schema.generated.ts";

function migrate(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sandkit_workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      metadata TEXT,
      sandboxId TEXT,
      status TEXT NOT NULL,
      name TEXT,
      lastResumedAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sandkit_setup_states (
      id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sandkit_runs (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      execution_target_id TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT,
      status TEXT NOT NULL,
      policy_snapshot_id TEXT,
      provider_commit TEXT,
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      FOREIGN KEY(workspace_id) REFERENCES sandkit_workspaces(id)
    );
    CREATE TABLE IF NOT EXISTS sandkit_policies (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES sandkit_workspaces(id)
    );
  `);
}

async function loadGeneratedSchema(): Promise<Record<string, unknown>> {
  const outputPath = join(process.cwd(), SCHEMA_PATH);
  const generated = runGenerateCommand({ provider: "sqlite", out: outputPath, stdout: false });
  const generatedPath = generated.outputFile;
  if (!generatedPath) {
    throw new Error("Smoke failed: generation did not return an output file path");
  }

  return import(pathToFileURL(generatedPath).href);
}

async function runSmoke(): Promise<void> {
  await rm(SQLITE_PATH, { force: true });
  const sqlite = new Database(SQLITE_PATH);
  const expectedName = "drizzle-smoke";
  const schemaFile = join(process.cwd(), SCHEMA_PATH);
  let replaySqlite: Database | undefined;

  try {
    migrate(sqlite);
    const schemaModule = (await loadGeneratedSchema()) as {
      sandkitSchema: Record<string, unknown>;
      default?: {
        sandkitSchema: Record<string, unknown>;
      };
    };

    const schema = schemaModule.sandkitSchema ?? schemaModule.default?.sandkitSchema;
    if (!schema) {
      throw new Error("Smoke failed: generated schema did not export sandkitSchema");
    }

    const db = drizzle(sqlite, { schema });
    const app = sandkit({
      database: drizzleAdapter(db, {
        provider: "sqlite",
      }),
      sandbox: {
        driverFactory: new MockSandboxDriverFactory(),
      },
    });

    const workspace = await app.createWorkspace({ name: expectedName });
    const writeResult = await workspace.sandbox.runCommand("echo", ["hello"]);
    if (writeResult.exitCode !== 0) {
      throw new Error("Smoke failed: expected successful command exit code 0");
    }
    const failResult = await workspace.sandbox.runCommand("unsupported", ["cmd"]);
    if (failResult.exitCode === 0) {
      throw new Error("Smoke failed: expected failing command exit code != 0");
    }

    replaySqlite = new Database(SQLITE_PATH);
    const replayDb = drizzle(replaySqlite, { schema });
    const replayApp = sandkit({
      database: drizzleAdapter(replayDb, {
        provider: "sqlite",
      }),
      sandbox: {
        driverFactory: new MockSandboxDriverFactory(),
      },
    });

    const reloaded = await replayApp.getWorkspace(workspace.id);
    if (reloaded.id !== workspace.id || reloaded.descriptor.name !== expectedName) {
      throw new Error("Smoke assertion failed: workspace could not be reloaded");
    }

    const completedRuns = replaySqlite
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM sandkit_runs WHERE workspace_id = ? AND status IN ('succeeded', 'failed')",
      )
      .get(workspace.id)?.count;

    if (completedRuns !== 2) {
      throw new Error(
        `Smoke assertion failed: expected 2 completed runs, got ${completedRuns === undefined ? 0 : completedRuns}`,
      );
    }

    const unresolvedRuns = replaySqlite
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM sandkit_runs WHERE workspace_id = ? AND status = 'started'",
      )
      .get(workspace.id)?.count;

    if (unresolvedRuns !== 0) {
      throw new Error(`Smoke assertion failed: expected no started runs, got ${unresolvedRuns}`);
    }

    const runWithMissingFacts = replaySqlite
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM sandkit_runs WHERE workspace_id = ? AND (policy_snapshot_id IS NULL OR provider_commit IS NULL OR execution_target_id IS NULL OR provider IS NULL)",
      )
      .get(workspace.id)?.count;

    if (runWithMissingFacts !== 0) {
      throw new Error(
        `Smoke assertion failed: expected all runs to persist required facts, got ${runWithMissingFacts}`,
      );
    }

    const policySnapshots = replaySqlite
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM sandkit_policies WHERE workspace_id = ?",
      )
      .get(workspace.id)?.count;

    if (policySnapshots !== 2) {
      throw new Error(
        `Smoke assertion failed: expected 2 policy snapshots, got ${policySnapshots === undefined ? 0 : policySnapshots}`,
      );
    }

    console.log("smokeDrizzleWorkspaceId", reloaded.id);
  } finally {
    sqlite.close();
    if (replaySqlite) {
      replaySqlite.close();
    }
    await rm(schemaFile, { force: true });
  }
}

void runSmoke();
