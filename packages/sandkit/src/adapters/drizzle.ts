import { eq } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { sandkitWorkspaceExport } from "../schema/model.ts";
import type {
  SandkitAdapter,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceStatus,
  WorkspaceUpdateInput,
} from "./types.ts";

interface DrizzleWorkspaceTableShape {
  readonly id: SQLWrapper;
  readonly name: unknown;
  readonly metadata: unknown;
  readonly status: unknown;
  readonly sandboxId: unknown;
  readonly lastResumedAt: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

interface DrizzleSchemaMap {
  [key: string]: unknown;
}

interface DrizzleMetadata {
  readonly fullSchema?: DrizzleSchemaMap;
}

type DatabaseQueryApi = {
  readonly [key: string]: unknown;
};

interface DrizzleDatabaseLike {
  select(): {
    from(table: object): {
      where(condition: unknown): {
        limit(limit: number): Promise<unknown[]>;
      };
    };
  };
  insert(table: object): {
    values(value: Record<string, unknown>): Promise<unknown>;
  };
  update(table: object): {
    set(value: Record<string, unknown>): {
      where(condition: unknown): Promise<unknown>;
    };
  };
  readonly _?: DrizzleMetadata;
  readonly query?: DatabaseQueryApi;
}

interface DrizzleWorkspaceRow {
  id: string;
  name: string | null;
  metadata: string | null;
  status: WorkspaceStatus;
  sandboxId: string | null;
  lastResumedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DrizzleAdapterOptions<TWorkspaces extends DrizzleWorkspaceTableShape> {
  provider: "sqlite" | "postgresql" | "mysql";
  workspaces?: TWorkspaces;
  id?: string;
}

const defaultWorkspaceStatus = "active";
const defaultWorkspaceName = "default";

function toRowRecord(workspace: WorkspaceRecord): DrizzleWorkspaceRow {
  return {
    id: workspace.id,
    name: workspace.name ?? defaultWorkspaceName,
    metadata: workspace.metadata ? JSON.stringify(workspace.metadata) : null,
    status: workspace.status,
    sandboxId: workspace.sandboxId ?? null,
    lastResumedAt: workspace.lastResumedAt ?? null,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function toInsertValues(row: DrizzleWorkspaceRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    metadata: row.metadata,
    status: row.status,
    sandboxId: row.sandboxId,
    lastResumedAt: row.lastResumedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function readMetadata(value: string | null): WorkspaceRecord["metadata"] {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as WorkspaceRecord["metadata"];
  } catch {
    return undefined;
  }
}

function toWorkspaceRecord(row: DrizzleWorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name ?? undefined,
    metadata: readMetadata(row.metadata),
    status: row.status,
    sandboxId: row.sandboxId ?? undefined,
    lastResumedAt: row.lastResumedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function selectWorkspaceById<TWorkspaces extends DrizzleWorkspaceTableShape>(
  db: DrizzleDatabaseLike,
  workspaces: TWorkspaces,
  id: string,
): Promise<WorkspaceRecord | null> {
  const rows = await db
    .select()
    .from(workspaces as object)
    .where(eq(workspaces.id, id))
    .limit(1);

  const row = rows[0] as DrizzleWorkspaceRow | undefined;
  return row ? toWorkspaceRecord(row) : null;
}

function resolveWorkspaceTable(
  db: DrizzleDatabaseLike,
  workspaceOverride?: DrizzleWorkspaceTableShape,
): DrizzleWorkspaceTableShape {
  if (workspaceOverride) {
    return workspaceOverride;
  }

  const fullSchema = db._?.fullSchema;
  if (!fullSchema) {
    throw new Error(
      "Sandkit drizzleAdapter requires a Drizzle database with schema metadata to auto-resolve workspaces.",
    );
  }

  const canonical = fullSchema[sandkitWorkspaceExport];
  if (!canonical) {
    throw new Error(
      `Sandkit drizzleAdapter could not find "${sandkitWorkspaceExport}" in drizzle schema. ` +
        `Generate schema with Sandkit defaults and pass the canonical workspace table as \`workspaces\`.`,
    );
  }

  return canonical as DrizzleWorkspaceTableShape;
}

export function drizzleAdapter<TWorkspaces extends DrizzleWorkspaceTableShape>(
  db: DrizzleDatabaseLike,
  options: DrizzleAdapterOptions<TWorkspaces>,
): SandkitAdapter {
  const resolvedWorkspaces = resolveWorkspaceTable(db, options.workspaces);
  const adapterId = options.id ?? `drizzle-${options.provider}`;

  return {
    id: adapterId,
    workspaces: {
      async createWorkspace(input: WorkspaceCreateInput = {}) {
        const now = new Date().toISOString();
        const id = input.id?.trim() ? input.id.trim() : crypto.randomUUID();

        const workspace: WorkspaceRecord = {
          id,
          name: input.name ?? defaultWorkspaceName,
          metadata: input.metadata ? { ...input.metadata } : undefined,
          status: input.status ?? defaultWorkspaceStatus,
          sandboxId: input.sandboxId === "" ? undefined : input.sandboxId?.trim() || undefined,
          lastResumedAt: input.lastResumedAt,
          createdAt: now,
          updatedAt: now,
        };

        await db
          .insert(resolvedWorkspaces as object)
          .values(toInsertValues(toRowRecord(workspace)));
        return workspace;
      },

      async getWorkspace(id: string) {
        return selectWorkspaceById(db, resolvedWorkspaces, id);
      },

      async updateWorkspace(id: string, input: WorkspaceUpdateInput) {
        const current = await selectWorkspaceById(db, resolvedWorkspaces, id);
        if (!current) {
          throw new Error(`Workspace with id "${id}" does not exist`);
        }

        const next: WorkspaceRecord = {
          ...current,
          name: input.name ?? current.name,
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
            input.lastResumedAt === null
              ? undefined
              : (input.lastResumedAt ?? current.lastResumedAt),
          updatedAt: new Date().toISOString(),
        };

        await db
          .update(resolvedWorkspaces as object)
          .set({
            name: next.name ?? null,
            metadata: next.metadata ? JSON.stringify(next.metadata) : null,
            status: next.status,
            sandboxId: next.sandboxId ?? null,
            lastResumedAt: next.lastResumedAt ?? null,
            updatedAt: next.updatedAt,
          })
          .where(eq(resolvedWorkspaces.id, id));

        return next;
      },
    },
  };
}

export type DrizzleWorkspaceTable = DrizzleWorkspaceTableShape;
