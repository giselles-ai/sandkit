import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { drizzleAdapter, sandkit } from "sandkit";

import { runGenerateCommand } from "../../packages/sandkit/src/cli/generate.ts";

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
    CREATE TABLE IF NOT EXISTS sandkit_runs (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT,
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
    });

    const workspace = await app.createWorkspace({ name: expectedName });

    replaySqlite = new Database(SQLITE_PATH);
    const replayDb = drizzle(replaySqlite, { schema });
    const replayApp = sandkit({
      database: drizzleAdapter(replayDb, {
        provider: "sqlite",
      }),
    });

    const reloaded = await replayApp.getWorkspace(workspace.id);
    if (reloaded.id !== workspace.id || reloaded.record.name !== expectedName) {
      throw new Error("Smoke assertion failed: workspace could not be reloaded");
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
