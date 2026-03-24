import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";

import { createSandkit } from "@giselles-ai/sandkit";
import type {
  CommandResult,
  PersistedSandboxState,
  SandboxDriver,
  SandboxDriverFactory,
  WorkspacePolicy,
  WorkspaceRecord,
} from "@giselles-ai/sandkit";
import { drizzleAdapter } from "@giselles-ai/sandkit/adapters/drizzle";
import { internalSandboxProvider } from "@giselles-ai/sandkit/integrations/mock";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const SQLITE_PATH = process.env.SMOKE_SHARED_SETUP_DB_PATH ?? "./smoke-shared-setup.sqlite";

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

const sandkitSetupStates = sqliteTable("sandkit_setup_states", {
  id: text("id").notNull().primaryKey(),
  state: text("state").notNull(),
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
  sandkitSetupStates,
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

type SnapshotState = {
  files: Record<string, string>;
};

function readSnapshotFiles(snapshot: PersistedSandboxState): Record<string, string> {
  if (
    snapshot.state &&
    typeof snapshot.state === "object" &&
    !Array.isArray(snapshot.state) &&
    "files" in snapshot.state &&
    snapshot.state.files &&
    typeof snapshot.state.files === "object" &&
    !Array.isArray(snapshot.state.files)
  ) {
    return { ...(snapshot.state.files as Record<string, string>) };
  }

  return {};
}

class SharedSetupSmokeDriver implements SandboxDriver {
  readonly provider = "shared-setup-smoke";
  readonly id: string;
  #stopped = false;
  #files: Record<string, string>;
  readonly #onBootstrap: () => string;

  constructor(id: string, files: Record<string, string>, onBootstrap: () => string) {
    this.id = id;
    this.#files = { ...files };
    this.#onBootstrap = onBootstrap;
  }

  async applyPolicy(_policy: WorkspacePolicy): Promise<void> {}

  async getSessionLease() {
    const observedAt = new Date().toISOString();
    return {
      sandboxId: this.id,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    };
  }

  async runCommand(command: string, args: string[]): Promise<CommandResult> {
    if (this.#stopped) {
      throw new Error("sandbox stopped");
    }

    switch (command) {
      case "bootstrap": {
        const content = this.#onBootstrap();
        this.#files["seed.txt"] = content;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      case "cat": {
        const target = args[0];
        if (!target || this.#files[target] === undefined) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `cat: ${target}: No such file or directory\n`,
          };
        }

        return {
          exitCode: 0,
          stdout: `${this.#files[target]}\n`,
          stderr: "",
        };
      }
      default:
        return {
          exitCode: 127,
          stdout: "",
          stderr: `unsupported command: ${command}\n`,
        };
    }
  }

  async snapshot(): Promise<PersistedSandboxState> {
    this.#stopped = true;
    return {
      kind: "shared-setup-smoke-snapshot",
      sessionId: this.id,
      state: {
        files: { ...this.#files },
      } satisfies SnapshotState,
    };
  }
}

function createSharedSetupSmokeDriverFactory(counter: {
  bootstrapRuns: number;
}): SandboxDriverFactory {
  let nextId = 0;

  const onBootstrap = () => {
    counter.bootstrapRuns += 1;
    return `seed-${counter.bootstrapRuns}`;
  };

  return {
    isSessionUnavailableError(error: unknown): boolean {
      return error instanceof Error && error.message.includes("sandbox stopped");
    },
    async createSandbox(_workspace: WorkspaceRecord): Promise<SandboxDriver> {
      nextId += 1;
      return new SharedSetupSmokeDriver(`shared-setup-${nextId}`, {}, onBootstrap);
    },
    async resumeSandbox(
      _workspace: WorkspaceRecord,
      snapshot: PersistedSandboxState,
    ): Promise<SandboxDriver> {
      nextId += 1;
      return new SharedSetupSmokeDriver(
        `shared-setup-${nextId}`,
        readSnapshotFiles(snapshot),
        onBootstrap,
      );
    },
  };
}

async function runSmoke(): Promise<void> {
  await rm(SQLITE_PATH, { force: true });
  const sqlite = new Database(SQLITE_PATH);

  try {
    migrate(sqlite);
    const db = drizzle(sqlite, { schema });
    const counter = { bootstrapRuns: 0 };
    const sandkit = createSandkit({
      database: drizzleAdapter(db, { provider: "sqlite" }),
      sandbox: internalSandboxProvider(
        createSharedSetupSmokeDriverFactory(counter),
        "shared-setup",
      ),
      setup: {
        command: "bootstrap",
        args: [],
      },
    });

    const firstWorkspace = await sandkit.createWorkspace({ id: "workspace-a" });
    const secondWorkspace = await sandkit.createWorkspace({ id: "workspace-b" });

    const first = await firstWorkspace.sandbox.runCommand({
      command: "cat",
      args: ["seed.txt"],
    });
    const second = await secondWorkspace.sandbox.runCommand({
      command: "cat",
      args: ["seed.txt"],
    });

    if (first.exitCode !== 0 || second.exitCode !== 0) {
      throw new Error(
        "Smoke failed: expected both workspaces to read bootstrap file successfully.",
      );
    }

    if (first.stdout.trim() !== "seed-1" || second.stdout.trim() !== "seed-1") {
      throw new Error(
        `Smoke failed: expected both workspaces to reuse the same bootstrap state, got "${first.stdout.trim()}" and "${second.stdout.trim()}".`,
      );
    }

    if (counter.bootstrapRuns !== 1) {
      throw new Error(
        `Smoke failed: expected shared setup to run once, got ${counter.bootstrapRuns}.`,
      );
    }

    const setupStateRows = sqlite
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM sandkit_setup_states")
      .get()?.count;

    if (setupStateRows !== 1) {
      throw new Error(
        `Smoke failed: expected exactly one shared setup state row, got ${setupStateRows ?? 0}.`,
      );
    }

    console.log("smokeSharedSetupBootstrapRuns", counter.bootstrapRuns);
  } finally {
    sqlite.close();
    await rm(SQLITE_PATH, { force: true });
  }
}

void runSmoke();
