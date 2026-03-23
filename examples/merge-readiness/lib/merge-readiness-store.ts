import { desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

import { mergeReadinessReviews, mergeReadinessSessions } from "../db/schema";

export const RESUMABLE_REVIEW_STATUSES = ["requested", "monitoring", "running"] as const;
export const TERMINAL_REVIEW_STATUSES = [
  "ready",
  "blocked",
  "failed",
  "interrupted",
  "cancelled",
] as const;

export type MergeReadinessReviewStatus =
  | "requested"
  | "monitoring"
  | "running"
  | "ready"
  | "blocked"
  | "failed"
  | "interrupted"
  | "cancelled";

export type MergeReadinessSessionStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export type MergeReadinessVerdict =
  | "safe_to_merge"
  | "unsafe_to_merge"
  | "needs_human_review"
  | null;

export type MergeReadinessRecommendation =
  | "approve"
  | "request_changes"
  | "investigate_further"
  | "needs_human"
  | null;

export type MergeReadinessReviewRecord = typeof mergeReadinessReviews.$inferSelect;
export type MergeReadinessSessionRecord = typeof mergeReadinessSessions.$inferSelect;

type MergeReadinessReviewInsert = typeof mergeReadinessReviews.$inferInsert;
type MergeReadinessSessionInsert = typeof mergeReadinessSessions.$inferInsert;

export type MergeReadinessReviewPayload = {
  prUrl: string;
  prTitle?: string | null;
  prRepo?: string | null;
  prOwner?: string | null;
  prNumber?: number | null;
  status?: MergeReadinessReviewStatus;
  verdict?: MergeReadinessVerdict;
  recommendation?: MergeReadinessRecommendation;
  evidence?: unknown[] | null;
  questions?: unknown[] | null;
  nextActions?: unknown[] | null;
  confidence?: number | null;
  errorMessage?: string | null;
};

export type ReviewWithLatestSession = MergeReadinessReviewRecord & {
  latestSession: MergeReadinessSessionRecord | null;
};

export type ReviewDecisionInput = {
  status: MergeReadinessReviewStatus;
  verdict: MergeReadinessVerdict;
  recommendation: MergeReadinessRecommendation;
  evidence: unknown[] | null;
  questions: unknown[] | null;
  nextActions: unknown[] | null;
  confidence: number;
};

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function nowDate(): Date {
  return new Date();
}

function toJsonText(values: unknown[] | null | undefined): string | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const filtered = values.filter((value): value is string => typeof value === "string");
  return JSON.stringify(filtered);
}

export function parseTextList(raw: unknown): string[] {
  if (raw === null || raw === undefined) {
    return [];
  }

  if (typeof raw !== "string") {
    return [];
  }

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function normalizeReviewStatus(value: string): MergeReadinessReviewStatus {
  if (
    value === "requested" ||
    value === "monitoring" ||
    value === "running" ||
    value === "ready" ||
    value === "blocked" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "cancelled"
  ) {
    return value;
  }

  return "failed";
}

function normalizeSessionStatus(value: string): MergeReadinessSessionStatus {
  if (
    value === "starting" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
  ) {
    return value;
  }

  return "failed";
}

export type MergeReadinessStore = {
  createReview: (
    workspaceId: string,
    payload: MergeReadinessReviewPayload,
  ) => Promise<MergeReadinessReviewRecord>;
  listReviews: (limit?: number) => Promise<ReviewWithLatestSession[]>;
  listReviewsByWorkspace: (
    workspaceId: string,
    limit?: number,
  ) => Promise<MergeReadinessReviewRecord[]>;
  getReviewById: (id: string) => Promise<ReviewWithLatestSession | null>;
  getLatestReviewByPrUrl: (prUrl: string) => Promise<MergeReadinessReviewRecord | null>;
  updateReview: (
    id: string,
    update: {
      status?: MergeReadinessReviewStatus;
      verdict?: MergeReadinessVerdict;
      recommendation?: MergeReadinessRecommendation;
      evidence?: unknown[] | null;
      questions?: unknown[] | null;
      nextActions?: unknown[] | null;
      confidence?: number | null;
      errorMessage?: string | null;
      outputPath?: string | null;
      finishedAt?: Date | null;
      updatedAt?: Date;
    },
  ) => Promise<MergeReadinessReviewRecord>;
  createSession: (
    reviewId: string,
    workspaceId: string,
    input: {
      sandboxId?: string | null;
      processId?: string | null;
      status: MergeReadinessSessionStatus;
      command?: string | null;
      stdoutPath?: string | null;
      stderrPath?: string | null;
      resultPath?: string | null;
    },
  ) => Promise<MergeReadinessSessionRecord>;
  getLatestSessionForReview: (reviewId: string) => Promise<MergeReadinessSessionRecord | null>;
  getSessionById: (sessionId: string) => Promise<MergeReadinessSessionRecord | null>;
  listSessionsForWorkspace: (
    workspaceId: string,
    limit?: number,
  ) => Promise<MergeReadinessSessionRecord[]>;
  updateSession: (
    sessionId: string,
    update: {
      status?: MergeReadinessSessionStatus;
      sandboxId?: string | null;
      processId?: string | null;
      command?: string | null;
      stdoutPath?: string | null;
      stderrPath?: string | null;
      resultPath?: string | null;
      finishedAt?: Date | null;
      updatedAt?: Date;
    },
  ) => Promise<MergeReadinessSessionRecord>;
};

function normalizeReview(record: MergeReadinessReviewRecord): MergeReadinessReviewRecord {
  return {
    ...record,
    status: normalizeReviewStatus(record.status),
  };
}

function normalizeSession(record: MergeReadinessSessionRecord): MergeReadinessSessionRecord {
  return {
    ...record,
    status: normalizeSessionStatus(record.status),
  };
}

type MergeReadinessDb = ReturnType<typeof drizzle>;

export function createMergeReadinessStore(db: MergeReadinessDb): MergeReadinessStore {
  async function createReview(
    workspaceId: string,
    payload: MergeReadinessReviewPayload,
  ): Promise<MergeReadinessReviewRecord> {
    const now = nowDate();
    const values: MergeReadinessReviewInsert = {
      id: randomToken(),
      workspace_id: workspaceId,
      pr_url: payload.prUrl,
      pr_title: payload.prTitle ?? null,
      pr_repo: payload.prRepo ?? null,
      pr_owner: payload.prOwner ?? null,
      pr_number: payload.prNumber ?? null,
      status: payload.status ?? "requested",
      verdict: payload.verdict ?? null,
      recommendation: payload.recommendation ?? null,
      evidence: toJsonText(payload.evidence),
      questions: toJsonText(payload.questions),
      next_actions: toJsonText(payload.nextActions),
      confidence: payload.confidence ?? null,
      error_message: payload.errorMessage ?? null,
      output_path: null,
      started_at: now,
      finished_at: null,
      updated_at: now,
    };

    await db.insert(mergeReadinessReviews).values(values);
    const rows = await db
      .select()
      .from(mergeReadinessReviews)
      .where(eq(mergeReadinessReviews.id, values.id))
      .limit(1);
    if (!rows[0]) {
      throw new Error("Failed to create merge readiness review.");
    }

    return rows[0];
  }

  async function listReviews(limit = 40): Promise<ReviewWithLatestSession[]> {
    const reviews = await db
      .select()
      .from(mergeReadinessReviews)
      .orderBy(desc(mergeReadinessReviews.updated_at), desc(mergeReadinessReviews.started_at))
      .limit(limit);

    const latestSessions = await listLatestSessionsForReviewIds(reviews.map((review) => review.id));
    return reviews.map((review) => ({
      ...normalizeReview(review),
      latestSession: latestSessions.find((session) => session.review_id === review.id) ?? null,
    }));
  }

  async function listReviewsByWorkspace(
    workspaceId: string,
    limit = 40,
  ): Promise<MergeReadinessReviewRecord[]> {
    const rows = await db
      .select()
      .from(mergeReadinessReviews)
      .where(eq(mergeReadinessReviews.workspace_id, workspaceId))
      .orderBy(desc(mergeReadinessReviews.updated_at), desc(mergeReadinessReviews.started_at))
      .limit(limit);

    return rows.map((row) => normalizeReview(row));
  }

  async function getLatestReviewByPrUrl(prUrl: string): Promise<MergeReadinessReviewRecord | null> {
    const rows = await db
      .select()
      .from(mergeReadinessReviews)
      .where(eq(mergeReadinessReviews.pr_url, prUrl))
      .orderBy(desc(mergeReadinessReviews.updated_at), desc(mergeReadinessReviews.started_at))
      .limit(1);

    return rows[0] ? normalizeReview(rows[0]) : null;
  }

  async function listLatestSessionsForReviewIds(
    reviewIds: string[],
  ): Promise<MergeReadinessSessionRecord[]> {
    if (reviewIds.length === 0) {
      return [];
    }

    const sessions = await db
      .select()
      .from(mergeReadinessSessions)
      .where(inArray(mergeReadinessSessions.review_id, reviewIds))
      .orderBy(desc(mergeReadinessSessions.started_at), desc(mergeReadinessSessions.id));

    const latestByReview = new Map<string, MergeReadinessSessionRecord>();
    for (const session of sessions) {
      if (!latestByReview.has(session.review_id)) {
        latestByReview.set(session.review_id, session);
      }
    }

    return [...latestByReview.values()].map((session) => normalizeSession(session));
  }

  async function getReviewById(id: string): Promise<ReviewWithLatestSession | null> {
    const rows = await db
      .select()
      .from(mergeReadinessReviews)
      .where(eq(mergeReadinessReviews.id, id))
      .limit(1);

    if (!rows[0]) {
      return null;
    }

    const latestSession = await getLatestSessionForReview(rows[0].id);
    return {
      ...normalizeReview(rows[0]),
      latestSession,
    };
  }

  async function updateReview(
    id: string,
    update: {
      status?: MergeReadinessReviewStatus;
      verdict?: MergeReadinessVerdict;
      recommendation?: MergeReadinessRecommendation;
      evidence?: unknown[] | null;
      questions?: unknown[] | null;
      nextActions?: unknown[] | null;
      confidence?: number | null;
      errorMessage?: string | null;
      outputPath?: string | null;
      finishedAt?: Date | null;
      updatedAt?: Date;
    },
  ): Promise<MergeReadinessReviewRecord> {
    const now = update.updatedAt ?? nowDate();
    const payload: Partial<MergeReadinessReviewInsert> = {
      updated_at: now,
      status: update.status,
      verdict: update.verdict,
      recommendation: update.recommendation,
      confidence: "confidence" in update ? update.confidence : undefined,
      error_message: "errorMessage" in update ? update.errorMessage : undefined,
      evidence: "evidence" in update ? toJsonText(update.evidence) : undefined,
      questions: "questions" in update ? toJsonText(update.questions) : undefined,
      next_actions: "nextActions" in update ? toJsonText(update.nextActions) : undefined,
      output_path: "outputPath" in update ? update.outputPath : undefined,
      finished_at: update.finishedAt,
    };

    await db.update(mergeReadinessReviews).set(payload).where(eq(mergeReadinessReviews.id, id));
    const rows = await db
      .select()
      .from(mergeReadinessReviews)
      .where(eq(mergeReadinessReviews.id, id))
      .limit(1);

    if (!rows[0]) {
      throw new Error("Failed to update merge readiness review.");
    }

    return normalizeReview(rows[0]);
  }

  async function createSession(
    reviewId: string,
    workspaceId: string,
    input: {
      sandboxId?: string | null;
      processId?: string | null;
      status: MergeReadinessSessionStatus;
      command?: string | null;
      stdoutPath?: string | null;
      stderrPath?: string | null;
      resultPath?: string | null;
    },
  ): Promise<MergeReadinessSessionRecord> {
    const now = nowDate();
    const values: MergeReadinessSessionInsert = {
      id: randomToken(),
      review_id: reviewId,
      workspace_id: workspaceId,
      sandbox_id: input.sandboxId ?? null,
      process_id: input.processId ?? null,
      status: input.status,
      command: input.command ?? null,
      stdout_path: input.stdoutPath ?? null,
      stderr_path: input.stderrPath ?? null,
      result_path: input.resultPath ?? null,
      started_at: now,
      finished_at: null,
      updated_at: now,
    };

    await db.insert(mergeReadinessSessions).values(values);
    const rows = await db
      .select()
      .from(mergeReadinessSessions)
      .where(eq(mergeReadinessSessions.id, values.id))
      .limit(1);

    if (!rows[0]) {
      throw new Error("Failed to create merge readiness session.");
    }

    return rows[0];
  }

  async function getLatestSessionForReview(
    reviewId: string,
  ): Promise<MergeReadinessSessionRecord | null> {
    const rows = await db
      .select()
      .from(mergeReadinessSessions)
      .where(eq(mergeReadinessSessions.review_id, reviewId))
      .orderBy(desc(mergeReadinessSessions.started_at), desc(mergeReadinessSessions.id))
      .limit(1);

    return rows[0] ? normalizeSession(rows[0]) : null;
  }

  async function getSessionById(sessionId: string): Promise<MergeReadinessSessionRecord | null> {
    const rows = await db
      .select()
      .from(mergeReadinessSessions)
      .where(eq(mergeReadinessSessions.id, sessionId))
      .limit(1);

    return rows[0] ? normalizeSession(rows[0]) : null;
  }

  async function listSessionsForWorkspace(
    workspaceId: string,
    limit = 80,
  ): Promise<MergeReadinessSessionRecord[]> {
    const rows = await db
      .select()
      .from(mergeReadinessSessions)
      .where(eq(mergeReadinessSessions.workspace_id, workspaceId))
      .orderBy(desc(mergeReadinessSessions.started_at), desc(mergeReadinessSessions.id))
      .limit(limit);

    return rows.map((row) => normalizeSession(row));
  }

  async function updateSession(
    sessionId: string,
    update: {
      status?: MergeReadinessSessionStatus;
      sandboxId?: string | null;
      processId?: string | null;
      command?: string | null;
      stdoutPath?: string | null;
      stderrPath?: string | null;
      resultPath?: string | null;
      finishedAt?: Date | null;
      updatedAt?: Date;
    },
  ): Promise<MergeReadinessSessionRecord> {
    const now = update.updatedAt ?? nowDate();
    const payload: Partial<MergeReadinessSessionInsert> = {
      updated_at: now,
      status: update.status,
      sandbox_id: "sandboxId" in update ? update.sandboxId : undefined,
      process_id: "processId" in update ? update.processId : undefined,
      command: "command" in update ? update.command : undefined,
      stdout_path: "stdoutPath" in update ? update.stdoutPath : undefined,
      stderr_path: "stderrPath" in update ? update.stderrPath : undefined,
      result_path: "resultPath" in update ? update.resultPath : undefined,
      finished_at: update.finishedAt,
    };

    await db
      .update(mergeReadinessSessions)
      .set(payload)
      .where(eq(mergeReadinessSessions.id, sessionId));
    const rows = await db
      .select()
      .from(mergeReadinessSessions)
      .where(eq(mergeReadinessSessions.id, sessionId))
      .limit(1);

    if (!rows[0]) {
      throw new Error("Failed to update merge readiness session.");
    }

    return normalizeSession(rows[0]);
  }

  return {
    createReview,
    listReviews,
    listReviewsByWorkspace,
    getReviewById,
    getLatestReviewByPrUrl,
    updateReview,
    createSession,
    getLatestSessionForReview,
    getSessionById,
    listSessionsForWorkspace,
    updateSession,
  };
}
