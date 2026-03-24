import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

import { openclawSessions } from "../db/schema/openclaw";
import { sandkitWorkspaces } from "../db/schema/sandkit";

const OPENCLAW_SESSION_SCHEMA_VERSION = 1;

const DURABLE_OPENCLAW_BOOTSTRAP_PHASES: readonly OpenClawSessionRecordPhase[] = [
  "bootstrapped",
  "ready",
] as const;

const RESUMABLE_OPENCLAW_SESSION_PHASES: readonly OpenClawSessionRecordPhase[] = [
  "bootstrapped",
  "degraded",
  "repairing",
  "ready",
  "session_started",
  "server_starting",
] as const;

export type OpenClawSessionRecordPhase =
  | "bootstrapping"
  | "bootstrapped"
  | "session_started"
  | "server_starting"
  | "ready"
  | "degraded"
  | "repairing"
  | "failed";

export type OpenClawPublicPhase = "bootstrapped" | "session_started" | "server_started" | "ready";

export type OpenClawMetadataSummary = {
  version: number;
  phase: OpenClawPublicPhase;
  activeSessionId: string | null;
  lastErrorAt: string | null;
  bootstrapVersion: number | null;
};

type WorkspaceMetadata = {
  openclaw?: OpenClawMetadataSummary;
  [key: string]: unknown;
};

export type OpenClawSessionRecord = typeof openclawSessions.$inferSelect;
export type OpenClawSessionInsert = typeof openclawSessions.$inferInsert;

export type OpenClawSessionUpdate = {
  phase?: OpenClawSessionRecordPhase;
  sandbox_id?: string | null;
  public_url?: string | null;
  last_healthy_at?: Date | null;
  error_code?: string | null;
  error_message?: string | null;
  updated_at?: Date;
  finished_at?: Date | null;
};

export function isOpenClawSessionRecordPhase(value: unknown): value is OpenClawSessionRecordPhase {
  return (
    value === "bootstrapping" ||
    value === "bootstrapped" ||
    value === "session_started" ||
    value === "server_starting" ||
    value === "ready" ||
    value === "degraded" ||
    value === "repairing" ||
    value === "failed"
  );
}

export function isOpenClawPublicPhase(value: unknown): value is OpenClawPublicPhase {
  return (
    value === "bootstrapped" ||
    value === "session_started" ||
    value === "server_started" ||
    value === "ready"
  );
}

function isWorkspaceMetadata(value: unknown): value is WorkspaceMetadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenClawMetadataSummary(value: unknown): value is OpenClawMetadataSummary {
  if (!isWorkspaceMetadata(value)) {
    return false;
  }

  const metadata = value as Record<string, unknown>;
  const version = metadata.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
    return false;
  }

  const phase = metadata.phase;
  if (!isOpenClawPublicPhase(phase)) {
    return false;
  }

  const activeSessionId = metadata.activeSessionId;
  if (typeof activeSessionId !== "string" && activeSessionId !== null) {
    return false;
  }

  const lastErrorAt = metadata.lastErrorAt;
  if (typeof lastErrorAt !== "string" && lastErrorAt !== null) {
    return false;
  }

  const bootstrapVersion = metadata.bootstrapVersion;
  if (typeof bootstrapVersion !== "number" && bootstrapVersion !== null) {
    return false;
  }

  return true;
}

export function normalizeOpenClawMetadataSummary(
  value: WorkspaceMetadata["openclaw"],
): OpenClawMetadataSummary {
  if (isOpenClawMetadataSummary(value)) {
    return value;
  }

  return {
    version: OPENCLAW_SESSION_SCHEMA_VERSION,
    phase: "bootstrapped",
    activeSessionId: null,
    lastErrorAt: null,
    bootstrapVersion: null,
  };
}

export function parseWorkspaceMetadata(raw: unknown): WorkspaceMetadata {
  if (!raw) {
    return {};
  }

  let parsed = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {};
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Workspace metadata is corrupted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!isWorkspaceMetadata(parsed)) {
    throw new Error("Workspace metadata is corrupted: expected a JSON object.");
  }

  return parsed;
}

export function makeSummary(
  workspaceMetadata: WorkspaceMetadata,
  phase: OpenClawPublicPhase,
  activeSessionId: string | null,
  lastErrorAt: string | null,
): WorkspaceMetadata {
  return {
    ...workspaceMetadata,
    openclaw: {
      version: OPENCLAW_SESSION_SCHEMA_VERSION,
      phase,
      activeSessionId,
      lastErrorAt,
      bootstrapVersion: 1,
    },
  };
}

export function isOpenClawSessionRecordReusableForStart(
  session: Pick<OpenClawSessionRecord, "phase" | "finished_at">,
): boolean {
  if (session.finished_at !== null) {
    return false;
  }

  return (
    isOpenClawSessionRecordPhase(session.phase) &&
    RESUMABLE_OPENCLAW_SESSION_PHASES.includes(session.phase)
  );
}

type OpenClawDb = ReturnType<typeof drizzle>;

export type OpenClawStore = {
  loadOpenClawSummary: (workspaceId: string) => Promise<OpenClawMetadataSummary>;
  updateOpenClawSummary: (
    workspaceId: string,
    update: Partial<OpenClawMetadataSummary>,
  ) => Promise<void>;
  updateOpenClawSessionRecord: (sessionId: string, update: OpenClawSessionUpdate) => Promise<void>;
  createOpenClawSession: (
    workspaceId: string,
    phase: OpenClawSessionRecordPhase,
    installSpec: string,
  ) => Promise<OpenClawSessionRecord>;
  getOpenClawSessionById: (sessionId: string) => Promise<OpenClawSessionRecord | null>;
  getLatestOpenClawSession: (workspaceId: string) => Promise<OpenClawSessionRecord | null>;
  getLatestUnfinishedSession: (workspaceId: string) => Promise<OpenClawSessionRecord | null>;
  hasDurableOpenClawBootstrap: (workspaceId: string) => Promise<boolean>;
  getOrCreateActiveSession: (
    workspaceId: string,
    installSpec: string,
  ) => Promise<OpenClawSessionRecord>;
  listRecentOpenClawSessions: (
    workspaceId: string,
    limit: number,
  ) => Promise<OpenClawSessionRecord[]>;
};

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function nowDate(): Date {
  return new Date();
}

export function createOpenClawStore(db: OpenClawDb): OpenClawStore {
  async function loadWorkspaceMetadata(workspaceId: string): Promise<WorkspaceMetadata> {
    const rows = await db
      .select({ metadata: sandkitWorkspaces.metadata })
      .from(sandkitWorkspaces)
      .where(eq(sandkitWorkspaces.id, workspaceId))
      .limit(1);

    if (rows.length === 0) {
      return {};
    }

    return parseWorkspaceMetadata(rows[0].metadata);
  }

  async function loadOpenClawSummary(workspaceId: string): Promise<OpenClawMetadataSummary> {
    const metadata = await loadWorkspaceMetadata(workspaceId);
    return normalizeOpenClawMetadataSummary(metadata.openclaw);
  }

  async function updateOpenClawSummary(
    workspaceId: string,
    update: Partial<OpenClawMetadataSummary>,
  ): Promise<void> {
    const metadata = await loadWorkspaceMetadata(workspaceId);
    const current = normalizeOpenClawMetadataSummary(metadata.openclaw);
    const nextSummary = makeSummary(
      metadata,
      update.phase ?? current.phase,
      update.activeSessionId ?? metadata.openclaw?.activeSessionId ?? null,
      update.lastErrorAt === undefined
        ? (metadata.openclaw?.lastErrorAt ?? null)
        : update.lastErrorAt,
    );

    if (update.phase !== undefined) {
      nextSummary.phase = update.phase;
    }

    if (update.activeSessionId !== undefined) {
      nextSummary.activeSessionId = update.activeSessionId;
    }

    if (update.bootstrapVersion !== undefined) {
      nextSummary.bootstrapVersion = update.bootstrapVersion;
    }

    if (update.lastErrorAt !== undefined) {
      nextSummary.lastErrorAt = update.lastErrorAt;
    }

    await db
      .update(sandkitWorkspaces)
      .set({
        metadata: nextSummary,
      })
      .where(eq(sandkitWorkspaces.id, workspaceId));
  }

  async function updateOpenClawSessionRecord(
    sessionId: string,
    update: OpenClawSessionUpdate,
  ): Promise<void> {
    await db
      .update(openclawSessions)
      .set({
        ...update,
        updated_at: update.updated_at ?? nowDate(),
      })
      .where(eq(openclawSessions.id, sessionId));
  }

  async function createOpenClawSession(
    workspaceId: string,
    phase: OpenClawSessionRecordPhase,
    installSpec: string,
  ): Promise<OpenClawSessionRecord> {
    const createdAt = nowDate();
    const sessionId = randomToken();
    const values: OpenClawSessionInsert = {
      id: sessionId,
      workspace_id: workspaceId,
      sandbox_id: null,
      phase,
      install_spec: installSpec,
      public_url: null,
      last_healthy_at: null,
      error_code: null,
      error_message: null,
      started_at: createdAt,
      updated_at: createdAt,
      finished_at: null,
    };

    await db.insert(openclawSessions).values(values);

    const rows = await db
      .select()
      .from(openclawSessions)
      .where(eq(openclawSessions.id, sessionId))
      .limit(1);

    if (!rows[0]) {
      throw new Error("Failed to create OpenClaw session record.");
    }

    return rows[0];
  }

  async function getOpenClawSessionById(sessionId: string): Promise<OpenClawSessionRecord | null> {
    const rows = await db
      .select()
      .from(openclawSessions)
      .where(eq(openclawSessions.id, sessionId))
      .limit(1);

    return rows[0] ?? null;
  }

  async function getLatestOpenClawSession(
    workspaceId: string,
  ): Promise<OpenClawSessionRecord | null> {
    const rows = await db
      .select()
      .from(openclawSessions)
      .where(eq(openclawSessions.workspace_id, workspaceId))
      .orderBy(desc(openclawSessions.started_at), desc(openclawSessions.id))
      .limit(1);

    return rows[0] ?? null;
  }

  async function getLatestUnfinishedSession(
    workspaceId: string,
  ): Promise<OpenClawSessionRecord | null> {
    const rows = await listRecentOpenClawSessions(workspaceId, 10);

    for (const row of rows) {
      if (row.finished_at === null) {
        return row;
      }
    }

    return null;
  }

  async function listRecentOpenClawSessions(
    workspaceId: string,
    limit: number,
  ): Promise<OpenClawSessionRecord[]> {
    return db
      .select()
      .from(openclawSessions)
      .where(eq(openclawSessions.workspace_id, workspaceId))
      .orderBy(desc(openclawSessions.started_at), desc(openclawSessions.id))
      .limit(limit);
  }

  async function hasDurableOpenClawBootstrap(workspaceId: string): Promise<boolean> {
    const rows = await db
      .select({ phase: openclawSessions.phase })
      .from(openclawSessions)
      .where(eq(openclawSessions.workspace_id, workspaceId))
      .orderBy(desc(openclawSessions.started_at), desc(openclawSessions.id))
      .limit(10);

    return rows.some(({ phase }) => {
      if (!isOpenClawSessionRecordPhase(phase)) {
        return false;
      }

      return DURABLE_OPENCLAW_BOOTSTRAP_PHASES.includes(phase);
    });
  }

  async function getOrCreateActiveSession(
    workspaceId: string,
    installSpec: string,
  ): Promise<OpenClawSessionRecord> {
    const latest = await getLatestOpenClawSession(workspaceId);
    if (!latest) {
      return createOpenClawSession(workspaceId, "bootstrapping", installSpec);
    }

    if (latest.phase === "bootstrapping") {
      await updateOpenClawSessionRecord(latest.id, {
        phase: "failed",
        error_code: "stale_bootstrap",
        error_message: "Previous bootstrap session was incomplete.",
        updated_at: nowDate(),
      });
    }

    if (isOpenClawSessionRecordReusableForStart(latest)) {
      return latest;
    }

    return createOpenClawSession(workspaceId, "bootstrapping", installSpec);
  }

  return {
    loadOpenClawSummary,
    updateOpenClawSummary,
    updateOpenClawSessionRecord,
    createOpenClawSession,
    getOpenClawSessionById,
    getLatestOpenClawSession,
    getLatestUnfinishedSession,
    hasDurableOpenClawBootstrap,
    getOrCreateActiveSession,
    listRecentOpenClawSessions,
  };
}
