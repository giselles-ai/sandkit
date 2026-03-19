import type { Database } from "bun:sqlite";
import type {
  SandkitAdapter,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceUpdateInput,
  WorkspaceStatus,
} from "./types.ts";

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

  async createWorkspace(input: WorkspaceCreateInput = {}): Promise<WorkspaceRecord> {
    const now = new Date().toISOString();
    const id = input.id && input.id.trim().length > 0 ? input.id : crypto.randomUUID();

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
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = undefined;
      }
    }

    return {
      id: row.id,
      name: row.name ?? undefined,
      metadata,
      status: row.status,
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
  }
}

export function createBunSqliteAdapter(db: Database): SandkitAdapter {
  return new BunSqliteWorkspaceAdapter(db);
}
