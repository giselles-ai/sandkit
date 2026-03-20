import type { Database } from "bun:sqlite";

import { createId } from "../core/ids.ts";
import type {
  SandkitAdapter,
  WorkspaceCreateInput,
  WorkspaceMetadata,
  WorkspaceRecord,
  WorkspaceUpdateInput,
  RunStatus,
  WorkspaceStatus,
  RunAdapter,
  RunCreateInput,
  RunFinishInput,
  RunRecord,
  PolicySnapshotAdapter,
  PolicySnapshotCreateInput,
  PolicySnapshotRecord,
} from "./types";

const workspaceStatuses = new Set<WorkspaceStatus>(["active", "inactive", "archived"]);
const runStatuses = new Set<RunStatus>(["started", "succeeded", "failed"]);

function corruptionError(table: string, column: string, reason: string): Error {
  return new Error(`Sandkit durable state corruption in ${table}.${column}: ${reason}`);
}

interface SqliteWorkspaceRow {
  id: string;
  name: string | null;
  metadata: string | null;
  status: WorkspaceStatus;
  sandboxId: string | null;
  lastResumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SqliteRunRow {
  id: string;
  workspace_id: string;
  provider: string;
  execution_target_id: string;
  command: string;
  args: string | null;
  status: string;
  policy_snapshot_id: string | null;
  provider_commit: string | null;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  started_at: string;
  finished_at: string | null;
}

function toJsonString(value: unknown): string {
  return JSON.stringify(value);
}

function parseJsonColumn(table: string, column: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw corruptionError(table, column, error instanceof Error ? error.message : "invalid JSON");
  }
}

function readWorkspaceStatus(value: string): WorkspaceStatus {
  if (workspaceStatuses.has(value as WorkspaceStatus)) {
    return value as WorkspaceStatus;
  }
  throw corruptionError("sandkit_workspaces", "status", `unexpected value "${value}"`);
}

function readRunStatus(value: string): RunStatus {
  if (runStatuses.has(value as RunStatus)) {
    return value as RunStatus;
  }
  throw corruptionError("sandkit_runs", "status", `unexpected value "${value}"`);
}

function readRunArgs(value: string | null): readonly string[] | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = parseJsonColumn("sandkit_runs", "args", value);
  if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
    return parsed;
  }

  throw corruptionError("sandkit_runs", "args", "expected JSON string array");
}

function readProviderCommit(value: string | null): unknown {
  if (value === null) {
    return undefined;
  }

  return parseJsonColumn("sandkit_runs", "provider_commit", value);
}

function toRunRecord(row: SqliteRunRow): RunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    executionTargetId: row.execution_target_id,
    command: row.command,
    args: readRunArgs(row.args),
    status: readRunStatus(row.status),
    exitCode: row.exit_code ?? undefined,
    stdout: row.stdout ?? undefined,
    stderr: row.stderr ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    policySnapshotId: row.policy_snapshot_id ?? undefined,
    providerCommit: readProviderCommit(row.provider_commit),
  };
}

function createSqliteRunStore(db: Database): RunAdapter {
  return {
    async createRun(input: RunCreateInput): Promise<RunRecord> {
      const now = new Date().toISOString();
      const id = input.id && input.id.trim().length > 0 ? input.id.trim() : createId("run");
      const startedAt = input.startedAt ?? now;

      db.query(
        `
          INSERT INTO sandkit_runs (
            id,
            workspace_id,
            provider,
            execution_target_id,
            command,
            args,
            status,
            policy_snapshot_id,
            provider_commit,
            started_at,
            finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
      ).run(
        id,
        input.workspaceId,
        input.provider,
        input.executionTargetId,
        input.command,
        input.args === null || input.args === undefined ? null : toJsonString(input.args),
        input.status ?? "started",
        input.policySnapshotId ?? null,
        null,
        startedAt,
        null,
      );

      return {
        id,
        workspaceId: input.workspaceId,
        provider: input.provider,
        executionTargetId: input.executionTargetId,
        command: input.command,
        args: input.args ?? [],
        status: input.status ?? "started",
        startedAt,
        policySnapshotId: input.policySnapshotId ?? undefined,
      };
    },
    async finishRun(id: string, input: RunFinishInput): Promise<RunRecord> {
      const current = await getRun(db, id);
      if (!current) {
        throw new Error(`Run with id "${id}" does not exist`);
      }

      const next: RunRecord = {
        ...current,
        status: input.status,
        finishedAt: input.finishedAt,
        exitCode: input.exitCode ?? current.exitCode,
        stdout: input.stdout ?? current.stdout,
        stderr: input.stderr ?? current.stderr,
        providerCommit: input.providerCommit ?? current.providerCommit,
      };

      db.query(
        `
          UPDATE sandkit_runs
          SET status = ?,
              exit_code = ?,
              stdout = ?,
              stderr = ?,
              finished_at = ?,
              provider_commit = ?
          WHERE id = ?
          `,
      ).run(
        next.status,
        next.exitCode ?? null,
        next.stdout ?? null,
        next.stderr ?? null,
        next.finishedAt ?? null,
        next.providerCommit === undefined ? null : toJsonString(next.providerCommit),
        id,
      );

      return next;
    },
  };
}

async function getRun(db: Database, id: string): Promise<RunRecord | null> {
  const row = db
    .query<SqliteRunRow, [string]>(
      `
      SELECT id,
             workspace_id,
             provider,
             execution_target_id,
             command,
             args,
             status,
             policy_snapshot_id,
             provider_commit,
             exit_code,
             stdout,
             stderr,
             started_at,
             finished_at
      FROM sandkit_runs
      WHERE id = ?
      LIMIT 1
      `,
    )
    .get(id);

  return row ? toRunRecord(row) : null;
}

function createPolicySnapshotStore(db: Database): PolicySnapshotAdapter {
  return {
    async createPolicySnapshot(input: PolicySnapshotCreateInput): Promise<PolicySnapshotRecord> {
      const now = new Date().toISOString();
      const id =
        input.id && input.id.trim().length > 0 ? input.id.trim() : createId("policy-snapshot");

      db.query(
        `
          INSERT INTO sandkit_policies (
            id,
            workspace_id,
            policy_id,
            config,
            created_at
          ) VALUES (?, ?, ?, ?, ?)
          `,
      ).run(
        id,
        input.workspaceId,
        input.policyId,
        toJsonString(input.config),
        input.createdAt ?? now,
      );

      return {
        id,
        workspaceId: input.workspaceId,
        policyId: input.policyId,
        config: input.config,
        createdAt: input.createdAt ?? now,
      };
    },
  };
}

class BunSqliteWorkspaceAdapter implements SandkitAdapter {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
    this.#migrate();
  }

  get id(): string {
    return "sqlite-bun";
  }

  get workspaces() {
    return {
      createWorkspace: this.createWorkspace.bind(this),
      getWorkspace: this.getWorkspace.bind(this),
      updateWorkspace: this.updateWorkspace.bind(this),
    };
  }

  get runs() {
    return createSqliteRunStore(this.#db);
  }

  get policySnapshots() {
    return createPolicySnapshotStore(this.#db);
  }

  async createWorkspace(input: WorkspaceCreateInput = {}): Promise<WorkspaceRecord> {
    const now = new Date().toISOString();
    const id = input.id && input.id.trim().length > 0 ? input.id : createId("workspace");

    this.#db
      .query(
        `
        INSERT INTO sandkit_workspaces (
          id,
          name,
          metadata,
          status,
          sandboxId,
          lastResumedAt,
          createdAt,
          updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.name ?? "default",
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.status ?? "active",
        input.sandboxId ?? null,
        input.lastResumedAt ?? null,
        now,
        now,
      );

    return {
      id,
      name: input.name ?? "default",
      metadata: input.metadata,
      status: input.status ?? "active",
      sandboxId: input.sandboxId ?? undefined,
      lastResumedAt: input.lastResumedAt,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    const row = this.#db
      .query<SqliteWorkspaceRow, [string]>(
        `
        SELECT id, name, metadata, status, sandboxId, lastResumedAt, createdAt, updatedAt
        FROM sandkit_workspaces
        WHERE id = ?
        `,
      )
      .get(id);

    if (!row) {
      return null;
    }

    return this.#toRecord(row);
  }

  async updateWorkspace(id: string, input: WorkspaceUpdateInput): Promise<WorkspaceRecord> {
    const current = await this.getWorkspace(id);
    if (!current) {
      throw new Error(`Workspace with id "${id}" does not exist`);
    }

    const next: WorkspaceRecord = {
      ...current,
      name: input.name === undefined ? current.name : input.name,
      metadata:
        input.metadata === undefined
          ? current.metadata
          : {
              ...current.metadata,
              ...input.metadata,
            },
      status: input.status ?? current.status,
      sandboxId: input.sandboxId === null ? undefined : (input.sandboxId ?? current.sandboxId),
      lastResumedAt:
        input.lastResumedAt === null ? undefined : (input.lastResumedAt ?? current.lastResumedAt),
      updatedAt: new Date().toISOString(),
    };

    this.#db
      .query(
        `
        UPDATE sandkit_workspaces
        SET name = ?,
            metadata = ?,
            status = ?,
            sandboxId = ?,
            lastResumedAt = ?,
            updatedAt = ?
        WHERE id = ?
        `,
      )
      .run(
        next.name ?? null,
        next.metadata ? JSON.stringify(next.metadata) : null,
        next.status,
        next.sandboxId ?? null,
        next.lastResumedAt ?? null,
        next.updatedAt,
        id,
      );

    return next;
  }

  #toRecord(row: SqliteWorkspaceRow): WorkspaceRecord {
    let metadata: WorkspaceMetadata | undefined;
    if (row.metadata !== null) {
      const parsed = parseJsonColumn("sandkit_workspaces", "metadata", row.metadata);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        metadata = parsed as WorkspaceMetadata;
      } else {
        throw corruptionError("sandkit_workspaces", "metadata", "expected JSON object");
      }
    }

    return {
      id: row.id,
      name: row.name ?? undefined,
      metadata,
      status: readWorkspaceStatus(row.status),
      sandboxId: row.sandboxId ?? undefined,
      lastResumedAt: row.lastResumedAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  #migrate(): void {
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS sandkit_workspaces (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT,
        metadata TEXT,
        status TEXT NOT NULL,
        sandboxId TEXT,
        lastResumedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS sandkit_policies (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES sandkit_workspaces(id)
      )
    `);
    this.#db.run(`
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
        started_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(workspace_id) REFERENCES sandkit_workspaces(id),
        FOREIGN KEY(policy_snapshot_id) REFERENCES sandkit_policies(id)
      )
    `);
  }
}

export function createBunSqliteAdapter(db: Database): SandkitAdapter {
  return new BunSqliteWorkspaceAdapter(db);
}
