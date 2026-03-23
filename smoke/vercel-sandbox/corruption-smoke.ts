import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  allowAll,
  sandkit,
} from "sandkit";
import { drizzleAdapter } from "sandkit/adapters/drizzle";
import { createMemoryAdapter } from "sandkit/adapters/memory";
import {
  type InternalRunAdapterContract,
  type InternalSandkitAdapterContract,
  type InternalSandboxDriverFactoryContract,
} from "./internal-seams.ts";

// Internal-seam smoke: this file validates public-path contracts against mocked internals.
// The following contracts intentionally mirror provider-adapter shapes without importing
// root-exposed internal implementation types.

const sandkitWorkspaces = sqliteTable("sandkit_workspaces", {
  id: text("id").notNull().primaryKey(),
  metadata: text("metadata"),
  sandboxId: text("sandboxId"),
  status: text("status").notNull(),
  name: text("name"),
  lastResumedAt: integer("lastResumedAt", { mode: "timestamp_ms" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

const sandkitRuns = sqliteTable("sandkit_runs", {
  id: text("id").notNull().primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  provider: text("provider").notNull(),
  execution_target_id: text("execution_target_id").notNull(),
  command: text("command").notNull(),
  args: text("args"),
  status: text("status").notNull(),
  policy_snapshot_id: text("policy_snapshot_id"),
  provider_commit: text("provider_commit"),
  exit_code: integer("exit_code"),
  stdout: text("stdout"),
  stderr: text("stderr"),
  started_at: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finished_at: integer("finished_at", { mode: "timestamp_ms" }),
});

const sandkitPolicies = sqliteTable("sandkit_policies", {
  id: text("id").notNull().primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  policy_id: text("policy_id").notNull(),
  config: text("config").notNull(),
  created_at: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

const schema = {
  sandkitWorkspaces,
  sandkitRuns,
  sandkitPolicies,
};

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

async function expectErrorContaining(
  label: string,
  operation: () => Promise<unknown>,
  parts: readonly string[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = parts.filter((part) => !message.includes(part));
    if (missing.length === 0) {
      return;
    }

    throw new Error(`${label} did not include expected fragments: ${missing.join(", ")}`);
  }

  throw new Error(`${label} did not fail`);
}

async function expectAggregateError(
  label: string,
  operation: () => Promise<unknown>,
  parts: readonly string[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof AggregateError)) {
      throw new Error(`${label} did not throw AggregateError`);
    }

    const messages = error.errors.map((entry) =>
      entry instanceof Error ? entry.message : String(entry),
    );
    const missing = parts.filter((part) => !messages.some((message) => message.includes(part)));
    if (missing.length > 0) {
      throw new Error(`${label} AggregateError was missing: ${missing.join(", ")}`);
    }
    return;
  }

  throw new Error(`${label} did not fail`);
}

function createCorruptingAdapter(
  base: InternalSandkitAdapterContract,
  afterCreateRun: (runId: string) => void,
): InternalSandkitAdapterContract {
  const runs: InternalRunAdapterContract = {
    async createRun(input) {
      const run = await base.runs.createRun(input);
      afterCreateRun(run.id);
      return run;
    },
    async finishRun(id, input) {
      return base.runs.finishRun(id, input);
    },
  };

  return {
    ...base,
    runs,
  };
}

function createFailingDriverFactory(): InternalSandboxDriverFactoryContract {
  return {
    async createSandbox() {
      return {
        id: "broken-sandbox",
        provider: "broken-provider",
        async applyPolicy() {
          return;
        },
        async getSessionLease() {
          const observedAt = new Date().toISOString();
          return {
            sandboxId: "broken-sandbox",
            observedAt,
            expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
          };
        },
        async runCommand() {
          throw new Error("command exploded");
        },
        async snapshot() {
          throw new Error("durability exploded");
        },
      };
    },
    async resumeSandbox() {
      throw new Error("resume not expected in corruption smoke");
    },
  };
}

async function runWorkspaceMetadataCorruptionScenario(): Promise<void> {
  const sqlitePath = "./smoke-corruption-workspace.sqlite";
  await rm(sqlitePath, { force: true });
  const sqlite = new Database(sqlitePath);

  try {
    migrate(sqlite);
    const now = Date.now();

    sqlite
      .query(
        `
        INSERT INTO sandkit_workspaces (id, metadata, sandboxId, status, name, lastResumedAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run("workspace_corrupt_metadata", "{", null, "active", "corrupt", null, now, now);

    const db = drizzle(sqlite, { schema });
    const app = sandkit({
      database: drizzleAdapter(db, {
        provider: "sqlite",
      }),
    });

    await expectErrorContaining(
      "workspace metadata corruption",
      () => app.getWorkspace("workspace_corrupt_metadata"),
      ["Sandkit durable state corruption", "sandkit_workspaces.metadata"],
    );
  } finally {
    sqlite.close();
    await rm(sqlitePath, { force: true });
  }
}

async function runRunArgsCorruptionScenario(corruptedArgs: string, label: string): Promise<void> {
  const sqlitePath = `./smoke-corruption-${label}.sqlite`;
  await rm(sqlitePath, { force: true });
  const sqlite = new Database(sqlitePath);

  try {
    migrate(sqlite);
    const db = drizzle(sqlite, { schema });
    const baseAdapter = drizzleAdapter(db, {
      provider: "sqlite",
    });
    const adapter = createCorruptingAdapter(baseAdapter, (runId) => {
      sqlite.query("UPDATE sandkit_runs SET args = ? WHERE id = ?").run(corruptedArgs, runId);
    });
    const app = sandkit({ database: adapter });
    const workspace = await app.createWorkspace({ name: label });

    await expectErrorContaining(label, () => workspace.sandbox.runCommand("echo", ["hello"]), [
      "Sandkit durable state corruption",
      "sandkit_runs.args",
    ]);
  } finally {
    sqlite.close();
    await rm(sqlitePath, { force: true });
  }
}

async function runProviderCommitCorruptionScenario(): Promise<void> {
  const sqlitePath = "./smoke-corruption-provider-commit.sqlite";
  await rm(sqlitePath, { force: true });
  const sqlite = new Database(sqlitePath);

  try {
    migrate(sqlite);
    const db = drizzle(sqlite, { schema });
    const baseAdapter = drizzleAdapter(db, {
      provider: "sqlite",
    });
    const adapter = createCorruptingAdapter(baseAdapter, (runId) => {
      sqlite.query("UPDATE sandkit_runs SET provider_commit = ? WHERE id = ?").run("{", runId);
    });
    const app = sandkit({ database: adapter });
    const workspace = await app.createWorkspace({ name: "provider-commit-corruption" });

    await expectErrorContaining(
      "provider_commit corruption",
      () => workspace.sandbox.runCommand("echo", ["hello"]),
      ["Sandkit durable state corruption", "sandkit_runs.provider_commit"],
    );
  } finally {
    sqlite.close();
    await rm(sqlitePath, { force: true });
  }
}

async function runAggregateFailureScenario(): Promise<void> {
  const app = sandkit({
    database: createMemoryAdapter(),
    policy: allowAll(),
    sandbox: {
      driverFactory: createFailingDriverFactory(),
    },
  });
  const workspace = await app.createWorkspace({ name: "aggregate-failure" });

  await expectAggregateError(
    "command + durability failure",
    () => workspace.sandbox.runCommand("echo", ["hello"]),
    ["command exploded", "durability exploded"],
  );
}

async function runSmoke(): Promise<void> {
  await runWorkspaceMetadataCorruptionScenario();
  await runRunArgsCorruptionScenario("{", "run-args-invalid-json corruption");
  await runRunArgsCorruptionScenario(
    JSON.stringify({ unexpected: true }),
    "run-args-invalid-shape corruption",
  );
  await runProviderCommitCorruptionScenario();
  await runAggregateFailureScenario();

  console.log("smokeCorruptionPaths", "ok");
}

void runSmoke();
