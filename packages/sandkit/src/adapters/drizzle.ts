import { eq } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { createId } from "../core/ids.ts";
import {
  sandkitPolicyExport,
  sandkitRunExport,
  sandkitSetupStateExport,
  sandkitWorkspaceExport,
} from "../schema/model.ts";
import type {
  SandkitAdapter,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceMetadata,
  SharedSetupState,
  SharedSetupStateValue,
  SetupStateRecord,
  SetupStatePutInput,
  WorkspaceStatus,
  WorkspaceUpdateInput,
  RunCreateInput,
  RunFinishInput,
  RunRecord,
  PolicySnapshotCreateInput,
  PolicySnapshotRecord,
  RunStatus,
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

interface DrizzleRunTableShape {
  readonly id: SQLWrapper;
  readonly workspace_id: unknown;
  readonly provider: unknown;
  readonly execution_target_id: unknown;
  readonly command: unknown;
  readonly args: unknown;
  readonly status: unknown;
  readonly policy_snapshot_id: unknown;
  readonly provider_commit: unknown;
  readonly exit_code: unknown;
  readonly stdout: unknown;
  readonly stderr: unknown;
  readonly started_at: unknown;
  readonly finished_at: unknown;
}

interface DrizzlePolicySnapshotTableShape {
  readonly id: SQLWrapper;
  readonly workspace_id: unknown;
  readonly policy_id: unknown;
  readonly config: unknown;
  readonly created_at: unknown;
}

interface DrizzleSetupStateTableShape {
  readonly id: SQLWrapper;
  readonly state: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

interface DrizzleSchemaMap {
  [key: string]: unknown;
}

interface DrizzleMetadata {
  readonly fullSchema?: DrizzleSchemaMap;
}

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
  delete(table: object): {
    where(condition: unknown): Promise<unknown>;
  };
  readonly _?: DrizzleMetadata;
}

interface DrizzleWorkspaceRow {
  id: string;
  name: string | null;
  metadata: unknown;
  status: WorkspaceStatus;
  sandboxId: string | null;
  lastResumedAt: string | number | Date | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

interface DrizzleSetupStateRow {
  id: string;
  state: unknown;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

interface DrizzleRunRow {
  id: string;
  workspace_id: string;
  provider: string;
  execution_target_id: string;
  command: string;
  args: unknown;
  status: string;
  policy_snapshot_id: string | null;
  provider_commit: unknown;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  started_at: string | number | Date;
  finished_at: string | number | Date | null;
}

const defaultWorkspaceStatus = "active";
const defaultWorkspaceName = "default";
const workspaceStatuses = new Set<WorkspaceStatus>(["active", "inactive", "archived"]);
const runStatuses = new Set<RunStatus>(["started", "succeeded", "failed"]);

function corruptionError(table: string, column: string, reason: string): Error {
  return new Error(`Sandkit durable state corruption in ${table}.${column}: ${reason}`);
}

function parseJsonOrThrow(table: string, column: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw corruptionError(table, column, error instanceof Error ? error.message : "invalid JSON");
  }
}

function readJsonColumn(table: string, column: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return parseJsonOrThrow(table, column, value);
  }

  return value;
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

function toWorkspaceRow(workspace: WorkspaceRecord): DrizzleWorkspaceRow {
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

function toDriverTimestamp(value: string | number | Date | null): Date | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    return new Date(value);
  }

  return new Date(value);
}

function toIsoTimestamp(value: string | number | Date): string {
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function toWorkspaceInsertValues(row: DrizzleWorkspaceRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    metadata: row.metadata,
    status: row.status,
    sandboxId: row.sandboxId,
    lastResumedAt: toDriverTimestamp(row.lastResumedAt ?? null),
    createdAt: toDriverTimestamp(row.createdAt),
    updatedAt: toDriverTimestamp(row.updatedAt),
  };
}

function readMetadata(value: unknown): WorkspaceRecord["metadata"] {
  const parsed = readJsonColumn("sandkit_workspaces", "metadata", value);
  if (parsed === undefined) {
    return undefined;
  }

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as WorkspaceMetadata;
  }

  throw corruptionError("sandkit_workspaces", "metadata", "expected JSON object");
}

function readSetupState(value: unknown): SharedSetupState {
  const parsed = readJsonColumn("sandkit_setup_states", "state", value);
  if (parsed === undefined) {
    throw corruptionError(
      "sandkit_setup_states",
      "state",
      "expected persisted sandbox state object",
    );
  }

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const candidate = parsed as { kind?: unknown; sessionId?: unknown; state?: unknown };
    if (typeof candidate.kind === "string" && typeof candidate.sessionId === "string") {
      return {
        kind: candidate.kind,
        sessionId: candidate.sessionId,
        state: candidate.state as SharedSetupStateValue,
      };
    }
  }

  throw corruptionError("sandkit_setup_states", "state", "expected persisted sandbox state object");
}

function toWorkspaceRecord(row: DrizzleWorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name ?? undefined,
    metadata: readMetadata(row.metadata),
    status: readWorkspaceStatus(row.status),
    sandboxId: row.sandboxId ?? undefined,
    lastResumedAt: row.lastResumedAt === null ? undefined : toIsoTimestamp(row.lastResumedAt),
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

function readRunArgs(value: unknown): readonly string[] | undefined {
  const parsed = readJsonColumn("sandkit_runs", "args", value);
  if (parsed === undefined) {
    return undefined;
  }

  if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
    return parsed;
  }

  throw corruptionError("sandkit_runs", "args", "expected JSON string array");
}

function readProviderCommit(value: unknown): unknown {
  return readJsonColumn("sandkit_runs", "provider_commit", value);
}

function toRunRecord(row: DrizzleRunRow): RunRecord {
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
    startedAt: toIsoTimestamp(row.started_at),
    finishedAt: row.finished_at === null ? undefined : toIsoTimestamp(row.finished_at),
    policySnapshotId: row.policy_snapshot_id ?? undefined,
    providerCommit: readProviderCommit(row.provider_commit),
  };
}

function toRunInsertValues(input: RunRecord, workspaceId: string): Record<string, unknown> {
  return {
    id: input.id,
    workspace_id: workspaceId,
    provider: input.provider,
    execution_target_id: input.executionTargetId,
    command: input.command,
    args: input.args ? JSON.stringify(input.args) : null,
    status: input.status,
    policy_snapshot_id: input.policySnapshotId ?? null,
    provider_commit:
      input.providerCommit === undefined ? null : JSON.stringify(input.providerCommit),
    started_at: toDriverTimestamp(input.startedAt),
    exit_code: input.exitCode ?? null,
    stdout: input.stdout ?? null,
    stderr: input.stderr ?? null,
    finished_at: input.finishedAt ? toDriverTimestamp(input.finishedAt) : null,
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

async function selectRunById<TRuns extends DrizzleRunTableShape>(
  db: DrizzleDatabaseLike,
  runs: TRuns,
  id: string,
): Promise<RunRecord | null> {
  const rows = await db
    .select()
    .from(runs as object)
    .where(eq(runs.id, id))
    .limit(1);

  const row = rows[0] as DrizzleRunRow | undefined;
  return row ? toRunRecord(row) : null;
}

async function selectSetupStateById<TSetupStates extends DrizzleSetupStateTableShape>(
  db: DrizzleDatabaseLike,
  setupStates: TSetupStates,
  id: string,
): Promise<SetupStateRecord | null> {
  const rows = await db
    .select()
    .from(setupStates as object)
    .where(eq(setupStates.id, id))
    .limit(1);

  const row = rows[0] as DrizzleSetupStateRow | undefined;
  return row ? toSetupStateRecord(row) : null;
}

function toSetupStateRecord(row: DrizzleSetupStateRow): SetupStateRecord {
  return {
    id: row.id,
    state: readSetupState(row.state),
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

function resolveTable<TTable>(
  db: DrizzleDatabaseLike,
  override: TTable | undefined,
  canonicalName: string,
  fallbackName: string,
): TTable {
  if (override) {
    return override;
  }

  const fullSchema = db._?.fullSchema;
  if (!fullSchema) {
    throw new Error(
      "Sandkit drizzleAdapter requires a Drizzle database with schema metadata to auto-resolve tables.",
    );
  }

  const canonical =
    fullSchema[canonicalName] ??
    fullSchema[fallbackName] ??
    fullSchema[fallbackName.replace("_", "")];
  if (!canonical) {
    throw new Error(
      `Sandkit drizzleAdapter could not find "${canonicalName}" in drizzle schema. ` +
        `Generate schema with Sandkit defaults and pass the canonical table explicitly if auto-resolution fails.`,
    );
  }

  return canonical as TTable;
}

export interface DrizzleAdapterOptions<
  TWorkspaces extends DrizzleWorkspaceTableShape,
  TRuns extends DrizzleRunTableShape,
  TPolicySnapshots extends DrizzlePolicySnapshotTableShape,
  TSetupStates extends DrizzleSetupStateTableShape = DrizzleSetupStateTableShape,
> {
  provider: "sqlite" | "postgresql" | "mysql";
  workspaces?: TWorkspaces;
  runs?: TRuns;
  policySnapshots?: TPolicySnapshots;
  setupStates?: TSetupStates;
  id?: string;
}

export function drizzleAdapter<
  TWorkspaces extends DrizzleWorkspaceTableShape,
  TRuns extends DrizzleRunTableShape,
  TPolicySnapshots extends DrizzlePolicySnapshotTableShape,
  TSetupStates extends DrizzleSetupStateTableShape = DrizzleSetupStateTableShape,
>(
  db: DrizzleDatabaseLike,
  options: DrizzleAdapterOptions<TWorkspaces, TRuns, TPolicySnapshots, TSetupStates>,
): SandkitAdapter {
  const resolvedWorkspaces = resolveTable(
    db,
    options.workspaces,
    sandkitWorkspaceExport,
    "sandkit_workspaces",
  );
  const resolvedRuns = resolveTable(db, options.runs, sandkitRunExport, "sandkit_runs");
  const resolvedPolicySnapshots = resolveTable(
    db,
    options.policySnapshots,
    sandkitPolicyExport,
    "sandkit_policies",
  );
  const resolvedSetupStates = resolveTable(
    db,
    options.setupStates,
    sandkitSetupStateExport,
    "sandkit_setup_states",
  );
  const adapterId = options.id ?? `drizzle-${options.provider}`;

  return {
    id: adapterId,
    workspaces: {
      async createWorkspace(input: WorkspaceCreateInput = {}) {
        const now = new Date().toISOString();
        const id = input.id?.trim() ? input.id.trim() : createId("workspace");

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
          .values(toWorkspaceInsertValues(toWorkspaceRow(workspace)));
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
            lastResumedAt: toDriverTimestamp(next.lastResumedAt ?? null),
            updatedAt: toDriverTimestamp(next.updatedAt),
          })
          .where(eq(resolvedWorkspaces.id, id));

        return next;
      },
    },
    setupStates: {
      async getSetupState(id: string) {
        return selectSetupStateById(db, resolvedSetupStates, id);
      },

      async putSetupState(input: SetupStatePutInput): Promise<SetupStateRecord> {
        const now = new Date().toISOString();
        const existing = await selectSetupStateById(db, resolvedSetupStates, input.id);

        if (existing) {
          await db
            .update(resolvedSetupStates as object)
            .set({
              state: JSON.stringify(input.state),
              updatedAt: toDriverTimestamp(now),
            })
            .where(eq(resolvedSetupStates.id, input.id));

          return {
            id: input.id,
            state: input.state,
            createdAt: existing.createdAt,
            updatedAt: now,
          };
        }

        await db.insert(resolvedSetupStates as object).values({
          id: input.id,
          state: JSON.stringify(input.state),
          createdAt: toDriverTimestamp(now),
          updatedAt: toDriverTimestamp(now),
        });

        return {
          id: input.id,
          state: input.state,
          createdAt: now,
          updatedAt: now,
        };
      },

      async deleteSetupState(id: string): Promise<void> {
        await db.delete(resolvedSetupStates as object).where(eq(resolvedSetupStates.id, id));
      },
    },
    runs: {
      async createRun(input: RunCreateInput): Promise<RunRecord> {
        const now = new Date().toISOString();
        const id = input.id?.trim() ? input.id.trim() : createId("run");
        const run: RunRecord = {
          id,
          workspaceId: input.workspaceId,
          provider: input.provider,
          executionTargetId: input.executionTargetId,
          command: input.command,
          args: input.args ?? [],
          status: input.status ?? "started",
          startedAt: input.startedAt ?? now,
          policySnapshotId: input.policySnapshotId ?? undefined,
          exitCode: undefined,
          stdout: undefined,
          stderr: undefined,
        };

        await db.insert(resolvedRuns as object).values(toRunInsertValues(run, input.workspaceId));
        return run;
      },

      async finishRun(id: string, input: RunFinishInput): Promise<RunRecord> {
        const current = await selectRunById(db, resolvedRuns, id);
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

        await db
          .update(resolvedRuns as object)
          .set({
            status: next.status,
            exit_code: next.exitCode ?? null,
            stdout: next.stdout ?? null,
            stderr: next.stderr ?? null,
            finished_at: toDriverTimestamp(next.finishedAt ?? null),
            provider_commit:
              next.providerCommit === undefined ? null : JSON.stringify(next.providerCommit),
          })
          .where(eq((resolvedRuns as DrizzleRunTableShape).id, id));

        return next;
      },
    },
    policySnapshots: {
      async createPolicySnapshot(input: PolicySnapshotCreateInput): Promise<PolicySnapshotRecord> {
        const now = new Date().toISOString();
        const id = input.id?.trim() ? input.id.trim() : createId("policy-snapshot");
        const createdAt = input.createdAt ?? now;
        const record: Omit<PolicySnapshotRecord, "id"> & { id: string } = {
          id,
          workspaceId: input.workspaceId,
          policyId: input.policyId,
          config: input.config,
          createdAt,
        };

        await db.insert(resolvedPolicySnapshots as object).values({
          id,
          workspace_id: record.workspaceId,
          policy_id: record.policyId,
          config: JSON.stringify(record.config),
          created_at: toDriverTimestamp(createdAt),
        });

        return {
          ...record,
          id,
        };
      },
    },
  };
}

export type DrizzleWorkspaceTable = DrizzleWorkspaceTableShape;
export type DrizzleRunTable = DrizzleRunTableShape;
