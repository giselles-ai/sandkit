import { createHash } from "node:crypto";
import { join } from "node:path";

import type { PublicWorkspaceHandle, WorkspaceSessionHandle } from "sandkit";

import {
  getMergeReadinessRuntime,
  getOrCreateWorkspaceById,
  MERGE_READINESS_ROOT,
  REVIEW_WORKSPACE_PREFIX,
  summarizeWorkspaceId,
} from "./merge-readiness-app";
import {
  RESUMABLE_REVIEW_STATUSES,
  TERMINAL_REVIEW_STATUSES,
  type MergeReadinessRecommendation,
  type MergeReadinessReviewRecord,
  type MergeReadinessReviewStatus,
  type MergeReadinessSessionRecord,
  type MergeReadinessSessionStatus,
  type MergeReadinessStore,
  type MergeReadinessVerdict,
  parseTextList,
} from "./merge-readiness-store";

export type ParsedPullRequest = {
  url: string;
  owner: string;
  repo: string;
  number: number;
  repoSlug: string;
};

type PullRequestContext = {
  title: string;
  state: string;
  body: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
};

type CodexDecision = {
  verdict: MergeReadinessVerdict;
  recommendation: MergeReadinessRecommendation;
  evidence: string[];
  questions: string[];
  next_actions: string[];
  confidence: number;
};

export type TopReviewSummary = MergeReadinessReviewRecord & {
  workspaceId: string;
  lastSession: MergeReadinessSessionRecord | null;
  evidenceItems: string[];
  questions: string[];
  nextActions: string[];
};

export type MergeReadinessReviewDetails = MergeReadinessReviewRecord & {
  evidenceItems: string[];
  questions: string[];
  nextActions: string[];
  latestSession: MergeReadinessSessionRecord | null;
};

export type MergeReadinessSessionState = MergeReadinessSessionRecord & {
  review: MergeReadinessReviewRecord | null;
  leaseRemainingMs: number | null;
  sandboxActive: boolean;
  outputSnippet: string | null;
};

export type MergeReadinessWorkspaceDetails = {
  workspaceId: string;
  descriptor: PublicWorkspaceHandle["descriptor"];
  activeLease: Awaited<ReturnType<PublicWorkspaceHandle["sandbox"]["getActiveLease"]>>;
  reviews: TopReviewSummary[];
  sessions: MergeReadinessSessionRecord[];
};

const DEFAULT_DASHBOARD_LIMIT = 25;
const DECISION_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["safe_to_merge", "unsafe_to_merge", "needs_human_review"],
      },
      recommendation: {
        type: "string",
        enum: ["approve", "request_changes", "investigate_further", "needs_human"],
      },
      evidence: {
        type: "array",
        items: { type: "string" },
      },
      questions: {
        type: "array",
        items: { type: "string" },
      },
      next_actions: {
        type: "array",
        items: { type: "string" },
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 100,
      },
    },
    required: ["verdict", "recommendation", "evidence", "questions", "next_actions", "confidence"],
    additionalProperties: false,
  },
  null,
  2,
);

type RuntimeFacade = {
  app: Awaited<ReturnType<typeof getMergeReadinessRuntime>>["app"];
  store: MergeReadinessStore;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

let runtimePromise: Promise<RuntimeFacade> | null = null;

function nowDate(): Date {
  return new Date();
}

function normalizePrUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw.trim();
  }
}

function parseNumber(value: string | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeText(value: string | undefined, fallback = ""): string {
  return value?.trim() || fallback;
}

function trimHead(value: string, maxLen = 5000): string {
  const text = safeText(value);
  return text.length > maxLen ? `${text.slice(-maxLen)}…` : text;
}

function isReviewStatusActive(status: string): boolean {
  return (RESUMABLE_REVIEW_STATUSES as readonly string[]).includes(status);
}

function isReviewStatusTerminal(status: string): boolean {
  return (TERMINAL_REVIEW_STATUSES as readonly string[]).includes(status);
}

function isSessionStatusActive(status: string): boolean {
  return status === "starting" || status === "running";
}

function resolveRuntime(): Promise<RuntimeFacade> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const runtime = await getMergeReadinessRuntime();
      return { app: runtime.app, store: runtime.store };
    })();
  }

  return runtimePromise;
}

function workspaceRoot(workspaceId: string): string {
  return join(MERGE_READINESS_ROOT, summarizeWorkspaceId(workspaceId));
}

function workspaceRepoPath(workspaceId: string): string {
  return join(workspaceRoot(workspaceId), "repo");
}

function workspaceArtifactDir(workspaceId: string, reviewId: string): string {
  return join(workspaceRepoPath(workspaceId), ".merge-readiness");
}

function reviewWorkspaceIdFromUrl(prUrl: string): string {
  const normalized = normalizePrUrl(prUrl);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `${REVIEW_WORKSPACE_PREFIX}-${hash}`;
}

function parsePullRequest(raw: string): ParsedPullRequest {
  const normalized = normalizePrUrl(raw);
  const parsed = new URL(normalized);
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parsed.hostname !== "github.com" || parts.length < 4) {
    throw new Error("Invalid GitHub pull request URL.");
  }

  const [owner, repo, route, numberText] = parts;
  if (route !== "pull") {
    throw new Error("URL is not a GitHub pull request URL.");
  }

  const number = parseNumber(numberText, Number.NaN);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("Invalid pull request number.");
  }

  return {
    url: normalized,
    owner,
    repo,
    number,
    repoSlug: `${owner}/${repo}`,
  };
}

async function runWorkspaceCommand(
  workspace: PublicWorkspaceHandle,
  command: string,
  args: string[],
): Promise<CommandResult> {
  const result = await workspace.sandbox.runCommand(command, args);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runSessionCommand(
  session: WorkspaceSessionHandle,
  command: string,
  args: string[],
): Promise<CommandResult> {
  const result = await session.exec(command, args);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function mapRecommendationFromRaw(
  recommendation: string | null | undefined,
  verdict: MergeReadinessVerdict,
): MergeReadinessRecommendation {
  if (
    recommendation === "approve" ||
    recommendation === "request_changes" ||
    recommendation === "investigate_further" ||
    recommendation === "needs_human"
  ) {
    return recommendation;
  }

  return verdict === "safe_to_merge" ? "approve" : "needs_human";
}

function parseTextListFromDb(value: unknown): string[] {
  return parseTextList(value);
}

function extractLinkedIssues(body: string): string[] {
  const matches = safeText(body).match(/#[0-9]+/g);
  if (!matches) {
    return [];
  }

  return [...new Set(matches)];
}

function buildSummary(
  review: MergeReadinessReviewRecord,
  lastSession: MergeReadinessSessionRecord | null,
): TopReviewSummary {
  return {
    ...review,
    workspaceId: review.workspace_id,
    lastSession,
    evidenceItems: parseTextListFromDb(review.evidence),
    questions: parseTextListFromDb(review.questions),
    nextActions: parseTextListFromDb(review.next_actions),
  };
}

function toDecisionResult(raw: string): CodexDecision | null {
  try {
    const parsed = JSON.parse(raw) as CodexDecision;
    if (
      parsed.verdict !== "safe_to_merge" &&
      parsed.verdict !== "unsafe_to_merge" &&
      parsed.verdict !== "needs_human_review"
    ) {
      return null;
    }
    if (
      !Array.isArray(parsed.evidence) ||
      !Array.isArray(parsed.questions) ||
      !Array.isArray(parsed.next_actions)
    ) {
      return null;
    }

    return {
      verdict: parsed.verdict,
      recommendation: mapRecommendationFromRaw(parsed.recommendation, parsed.verdict),
      evidence: parsed.evidence.filter((value): value is string => typeof value === "string"),
      questions: parsed.questions.filter((value): value is string => typeof value === "string"),
      next_actions: parsed.next_actions.filter(
        (value): value is string => typeof value === "string",
      ),
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0,
    };
  } catch {
    return null;
  }
}

function buildDecisionFromContext(
  pr: ParsedPullRequest,
  context: PullRequestContext,
  sessionArtifacts: {
    checks: string;
    diffStat: string;
  },
): string {
  const issues = extractLinkedIssues(context.body);

  return [
    `You are reviewing merge-readiness for GitHub PR ${pr.url}.`,
    `Repository: ${pr.repoSlug}`,
    `Title: ${context.title}`,
    `State: ${context.state}`,
    `Draft: ${context.isDraft ? "yes" : "no"}`,
    `Base: ${context.baseRefName}`,
    `Head: ${context.headRefName}`,
    `Changed files: ${context.changedFiles}`,
    `Lines: +${context.additions} -${context.deletions}`,
    "",
    "Decision output format must be strict JSON with:",
    "verdict, recommendation, evidence, questions, next_actions, confidence",
    "",
    "Rules:",
    "- Use available repository + PR context and do not invent data.",
    "- Include blockers and caveats in evidence.",
    "- If linked issues appear, cite them explicitly.",
    "- If uncertain, set verdict = needs_human_review.",
    "",
    "Linked issue refs found in PR body:",
    ...issues.map((item) => `- ${item}`),
    "",
    "Latest checks:",
    trimHead(sessionArtifacts.checks, 2000),
    "",
    "Diff stat:",
    trimHead(sessionArtifacts.diffStat, 1500),
  ].join("\n");
}

function buildCodexScript(
  workspaceId: string,
  reviewId: string,
  repoPath: string,
  prompt: string,
): {
  command: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
} {
  const artifactDir = workspaceArtifactDir(workspaceId, reviewId);
  const promptPath = join(artifactDir, `${reviewId}.prompt`);
  const schemaPath = join(artifactDir, `${reviewId}.schema.json`);
  const stdoutPath = join(artifactDir, `${reviewId}.stdout.log`);
  const stderrPath = join(artifactDir, `${reviewId}.stderr.log`);
  const resultPath = join(artifactDir, `${reviewId}.result.json`);
  const promptEncoded = Buffer.from(prompt).toString("base64");
  const schemaEncoded = Buffer.from(DECISION_SCHEMA).toString("base64");

  const command = [
    "set -euo pipefail",
    `mkdir -p '${artifactDir}'`,
    `printf '%s' '${schemaEncoded}' | base64 -d > '${schemaPath}'`,
    `printf '%s' '${promptEncoded}' | base64 -d > '${promptPath}'`,
    `cat '${promptPath}' | codex exec --skip-git-repo-check --json --output-schema '${schemaPath}' --output-last-message '${resultPath}' -C '${repoPath}' > '${stdoutPath}' 2> '${stderrPath}'`,
  ].join("\n");

  return { command, stdoutPath, stderrPath, resultPath };
}

async function readPullRequestContext(
  workspace: PublicWorkspaceHandle,
  pr: ParsedPullRequest,
): Promise<PullRequestContext> {
  const result = await runWorkspaceCommand(workspace, "gh", [
    "pr",
    "view",
    pr.url,
    "--json",
    "title,state,isDraft,body,baseRefName,headRefName,additions,deletions,changedFiles",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to read PR metadata for ${pr.url}:\n${trimHead(safeText(result.stderr || result.stdout), 1000)}`,
    );
  }

  const parsed = JSON.parse(result.stdout) as {
    title?: string;
    state?: string;
    isDraft?: boolean;
    body?: string;
    baseRefName?: string;
    headRefName?: string;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
  };

  return {
    title: safeText(parsed.title, "Untitled PR"),
    state: safeText(parsed.state, "unknown"),
    body: safeText(parsed.body),
    isDraft: parsed.isDraft === true,
    baseRefName: safeText(parsed.baseRefName, ""),
    headRefName: safeText(parsed.headRefName, ""),
    additions: parseNumber(String(parsed.additions), 0),
    deletions: parseNumber(String(parsed.deletions), 0),
    changedFiles: parseNumber(String(parsed.changedFiles), 0),
  };
}

async function runBaselineCommands(
  workspace: PublicWorkspaceHandle,
  pr: ParsedPullRequest,
): Promise<{ checks: string; diffStat: string }> {
  const checks = await runWorkspaceCommand(workspace, "gh", [
    "pr",
    "checks",
    pr.url,
    "--json",
    "status,conclusion,name",
  ]).catch((error) => ({
    exitCode: -1,
    stdout: "",
    stderr: error instanceof Error ? error.message : `${error}`,
  }));

  const diff = await runWorkspaceCommand(workspace, "gh", ["pr", "diff", pr.url, "--stat"]);
  return {
    checks:
      checks.exitCode === 0 ? checks.stdout : trimHead(`${checks.stderr || checks.stdout}`, 2000),
    diffStat: trimHead(diff.stdout || diff.stderr, 1200),
  };
}

async function ensureRepoPrepared(
  workspace: PublicWorkspaceHandle,
  pr: ParsedPullRequest,
): Promise<string> {
  const repoPath = workspaceRepoPath(workspace.id);
  const branch = `pr-${pr.number}-${pr.repo}`;
  const checkoutScript = [
    "set -euo pipefail",
    `mkdir -p '${repoPath}'`,
    `if [ ! -d '${repoPath}/.git' ]; then`,
    `  gh repo clone '${pr.repoSlug}' '${repoPath}'`,
    "fi",
    `cd '${repoPath}'`,
    "git fetch origin",
    `git fetch origin "refs/pull/${pr.number}/head:${branch}" || true`,
    `if ! gh pr checkout '${pr.number}' --repo '${pr.repoSlug}' --force; then`,
    `  git checkout -f '${branch}' 2>/dev/null || git checkout -f -b '${branch}'`,
    "fi",
    "git clean -fd",
  ].join("\n");

  const prepared = await runWorkspaceCommand(workspace, "bash", ["-lc", checkoutScript]);
  if (prepared.exitCode !== 0) {
    throw new Error(
      `Repository preparation failed:\n${trimHead(prepared.stderr || prepared.stdout)}`,
    );
  }

  return repoPath;
}

async function finalizeSession(
  workspace: PublicWorkspaceHandle,
  review: MergeReadinessReviewRecord,
  session: MergeReadinessSessionRecord,
  decision: CodexDecision | null,
  sessionHandle: WorkspaceSessionHandle | null,
): Promise<void> {
  const runtime = await resolveRuntime();
  const parsed = parsePullRequest(review.pr_url);
  const context = await readPullRequestContext(workspace, parsed);
  const now = nowDate();

  if (!decision) {
    await runtime.store.updateReview(review.id, {
      status: "failed",
      verdict: null,
      recommendation: null,
      evidence: ["No parseable Codex decision output was produced."],
      questions: ["Inspect codex output logs for the exact failure details."],
      nextActions: ["Rerun from UI with same PR."],
      confidence: 0,
      outputPath: session.stderr_path ?? session.stdout_path ?? session.result_path,
      errorMessage:
        "Structured Codex decision output was not available. Check stdout/stderr artifacts for details.",
      finishedAt: now,
      updatedAt: now,
    });
    await runtime.store.updateSession(session.id, {
      status: "failed",
      finishedAt: now,
      updatedAt: now,
    });
    if (sessionHandle) {
      await sessionHandle.commit().catch(() => undefined);
    }
    return;
  }

  const verdictStatus =
    context.state.toLowerCase() === "open"
      ? decision.verdict === "safe_to_merge"
        ? "ready"
        : "blocked"
      : "blocked";
  const blockedByState =
    context.state.toLowerCase() !== "open" ? [`PR state is ${context.state}.`] : [];
  const evidence = [...blockedByState, ...decision.evidence];

  await runtime.store.updateReview(review.id, {
    status: verdictStatus,
    verdict: decision.verdict,
    recommendation:
      context.isDraft && decision.verdict !== "safe_to_merge"
        ? "needs_human"
        : decision.recommendation,
    evidence: evidence,
    questions: decision.questions,
    nextActions: decision.next_actions,
    confidence: decision.confidence,
    outputPath: session.result_path,
    finishedAt: now,
    updatedAt: now,
  });

  await runtime.store.updateSession(session.id, {
    status: "completed",
    finishedAt: now,
    updatedAt: now,
  });

  if (sessionHandle) {
    await sessionHandle.commit().catch(() => undefined);
  }
}

async function readResultFromSessionFile(
  executor: (path: string) => Promise<string>,
  pathValue: string | null,
): Promise<CodexDecision | null> {
  if (!pathValue) {
    return null;
  }

  const raw = await executor(pathValue);
  if (!raw) {
    return null;
  }

  return toDecisionResult(raw);
}

async function readSessionFile(
  workspace: PublicWorkspaceHandle,
  session: MergeReadinessSessionRecord,
  pathValue: string | null,
): Promise<string> {
  if (!pathValue) {
    return "";
  }

  if (isSessionStatusActive(session.status)) {
    try {
      const attached = await workspace.sandbox.attachSession();
      const output = await runSessionCommand(attached, "bash", [
        "-lc",
        `cat '${pathValue}' 2>/dev/null || true`,
      ]);
      return output.stdout;
    } catch {
      return "";
    }
  }

  const output = await runWorkspaceCommand(workspace, "bash", [
    "-lc",
    `cat '${pathValue}' 2>/dev/null || true`,
  ]);
  return output.stdout;
}

async function reconcileReviewProgress(
  workspace: PublicWorkspaceHandle,
  reviewId: string,
): Promise<void> {
  const runtime = await resolveRuntime();
  const reviewState = await runtime.store.getReviewById(reviewId);
  if (!reviewState || !reviewState.latestSession) {
    return;
  }

  const latestSession = reviewState.latestSession;
  if (!isSessionStatusActive(latestSession.status)) {
    return;
  }
  if (isReviewStatusTerminal(reviewState.status)) {
    return;
  }

  const lease = await workspace.sandbox.getActiveLease();
  const matchingSession = lease && lease.sandboxId === latestSession.sandbox_id;
  let processRunning = false;
  let sessionHandle: WorkspaceSessionHandle | null = null;
  if (matchingSession) {
    sessionHandle = await workspace.sandbox.attachSession();
    if (latestSession.process_id) {
      const check = await runSessionCommand(sessionHandle, "bash", [
        "-lc",
        `kill -0 '${latestSession.process_id}' >/dev/null 2>&1; echo $?`,
      ]);
      processRunning = check.stdout.trim() === "0";
    }
  }

  if (processRunning) {
    return;
  }

  const parseDecisionFromFile = async (pathValue: string | null): Promise<CodexDecision | null> => {
    if (!pathValue) {
      return null;
    }
    if (sessionHandle) {
      return readResultFromSessionFile(
        async (target) =>
          (
            await runSessionCommand(sessionHandle, "bash", [
              "-lc",
              `cat '${target}' 2>/dev/null || true`,
            ])
          ).stdout,
        pathValue,
      );
    }
    return readResultFromSessionFile(
      async (target) =>
        (
          await runWorkspaceCommand(workspace, "bash", [
            "-lc",
            `cat '${target}' 2>/dev/null || true`,
          ])
        ).stdout,
      pathValue,
    );
  };

  const parsedDecision = await parseDecisionFromFile(latestSession.result_path);
  await finalizeSession(workspace, reviewState, latestSession, parsedDecision, sessionHandle);
}

async function startInvestigationSession(
  review: MergeReadinessReviewRecord,
): Promise<MergeReadinessSessionRecord> {
  const runtime = await resolveRuntime();
  const workspace = await getWorkspace(runtime, review.workspace_id);
  const pr = parsePullRequest(review.pr_url);
  const context = await readPullRequestContext(workspace, pr);
  const baseline = await runBaselineCommands(workspace, pr);
  const repoPath = await ensureRepoPrepared(workspace, pr);
  const prompt = buildDecisionFromContext(pr, context, baseline);
  const invocation = buildCodexScript(workspace.id, review.id, repoPath, prompt);

  const session = await workspace.sandbox.openSession();
  const lease = await workspace.sandbox.getActiveLease();
  const process = await session.startProcess("bash", ["-lc", invocation.command]);
  const sessionRecord = await runtime.store.createSession(review.id, review.workspace_id, {
    sandboxId: lease?.sandboxId ?? null,
    processId: process.processId,
    status: "running",
    command: `bash -lc (review ${review.id})`,
    stdoutPath: invocation.stdoutPath,
    stderrPath: invocation.stderrPath,
    resultPath: invocation.resultPath,
  });

  await runtime.store.updateReview(review.id, {
    status: "monitoring",
    outputPath: invocation.resultPath,
  });

  return sessionRecord;
}

async function getWorkspace(
  runtime: RuntimeFacade,
  workspaceId: string,
): Promise<PublicWorkspaceHandle> {
  return getOrCreateWorkspaceById(workspaceId, runtime.app);
}

export async function requestReview(prUrl: string): Promise<{
  review: TopReviewSummary;
  workspaceId: string;
  started: boolean;
}> {
  const runtime = await resolveRuntime();
  const parsed = parsePullRequest(prUrl);
  const workspaceId = reviewWorkspaceIdFromUrl(parsed.url);
  const workspace = await getWorkspace(runtime, workspaceId);
  const existing = await runtime.store.getLatestReviewByPrUrl(parsed.url);

  if (existing && isReviewStatusActive(existing.status)) {
    await reconcileReviewProgress(workspace, existing.id);
    const refreshed = await runtime.store.getReviewById(existing.id);
    if (!refreshed) {
      throw new Error("Review not found while reconciling.");
    }
    return {
      review: buildSummary(refreshed, refreshed.latestSession),
      workspaceId,
      started: false,
    };
  }

  const context = await readPullRequestContext(workspace, parsed);
  const review = await runtime.store.createReview(workspaceId, {
    prUrl: parsed.url,
    prTitle: context.title,
    prRepo: parsed.repo,
    prOwner: parsed.owner,
    prNumber: parsed.number,
    status: "requested",
  });

  const session = await startInvestigationSession(review);
  await reconcileReviewProgress(workspace, review.id);
  const refreshed = await runtime.store.getReviewById(review.id);
  if (!refreshed) {
    throw new Error("Review disappeared after start.");
  }

  return {
    review: buildSummary(refreshed, refreshed.latestSession ?? session),
    workspaceId,
    started: Boolean(session),
  };
}

export async function resumeReview(reviewId: string): Promise<TopReviewSummary> {
  const runtime = await resolveRuntime();
  const review = await runtime.store.getReviewById(reviewId);
  if (!review) {
    throw new Error("Review not found.");
  }

  const workspace = await getWorkspace(runtime, review.workspace_id);
  await reconcileReviewProgress(workspace, review.id);
  const refreshed = await runtime.store.getReviewById(reviewId);
  if (!refreshed) {
    throw new Error("Review not found.");
  }

  if (isReviewStatusTerminal(refreshed.status)) {
    throw new Error("Review already finished; create a new request to re-run.");
  }

  if (refreshed.latestSession && isSessionStatusActive(refreshed.latestSession.status)) {
    return buildSummary(refreshed, refreshed.latestSession);
  }

  const session = await startInvestigationSession(refreshed);
  const reloaded = await runtime.store.getReviewById(reviewId);
  if (!reloaded) {
    throw new Error("Review not found after resume.");
  }

  return buildSummary(reloaded, reloaded.latestSession ?? session);
}

export async function listTopReviews(limit = DEFAULT_DASHBOARD_LIMIT): Promise<TopReviewSummary[]> {
  const runtime = await resolveRuntime();
  const rows = await runtime.store.listReviews(limit);
  return rows.map((row) => buildSummary(row, row.latestSession));
}

export async function getReviewDetails(reviewId: string): Promise<MergeReadinessReviewDetails> {
  const runtime = await resolveRuntime();
  const row = await runtime.store.getReviewById(reviewId);
  if (!row) {
    throw new Error("Review not found.");
  }

  const workspace = await getWorkspace(runtime, row.workspace_id);
  await reconcileReviewProgress(workspace, row.id);
  const refreshed = await runtime.store.getReviewById(reviewId);
  if (!refreshed) {
    throw new Error("Review not found.");
  }

  return {
    ...refreshed,
    evidenceItems: parseTextListFromDb(refreshed.evidence),
    questions: parseTextListFromDb(refreshed.questions),
    nextActions: parseTextListFromDb(refreshed.next_actions),
    latestSession: refreshed.latestSession,
  };
}

export async function getWorkspaceDetail(
  workspaceId: string,
): Promise<MergeReadinessWorkspaceDetails> {
  const runtime = await resolveRuntime();
  const workspace = await getWorkspace(runtime, workspaceId);
  const activeLease = await workspace.sandbox.getActiveLease();
  const [reviews, sessions] = await Promise.all([
    runtime.store.listReviewsByWorkspace(workspaceId),
    runtime.store.listSessionsForWorkspace(workspaceId),
  ]);

  return {
    workspaceId,
    descriptor: workspace.descriptor,
    activeLease,
    reviews: reviews.map((review) => ({
      ...review,
      workspaceId: review.workspace_id,
      lastSession: null,
      evidenceItems: parseTextListFromDb(review.evidence),
      questions: parseTextListFromDb(review.questions),
      nextActions: parseTextListFromDb(review.next_actions),
    })),
    sessions,
  };
}

export async function getSessionState(sessionId: string): Promise<MergeReadinessSessionState> {
  const runtime = await resolveRuntime();
  let session = await runtime.store.getSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found.");
  }

  const reviewStateWithSession = await runtime.store.getReviewById(session.review_id);
  const workspace = await getWorkspace(runtime, session.workspace_id);

  if (isSessionStatusActive(session.status)) {
    await reconcileReviewProgress(workspace, session.review_id);
    const refreshed = await runtime.store.getSessionById(sessionId);
    if (!refreshed) {
      throw new Error("Session not found after reconciliation.");
    }
    session = refreshed;
  }

  const lease = await workspace.sandbox.getActiveLease();
  const sandboxActive = Boolean(lease && lease.sandboxId === session.sandbox_id);
  const leaseRemainingMs = lease?.remainingMs ?? null;
  const output = trimHead(await readSessionFile(workspace, session, session.stdout_path));

  return {
    ...session,
    review: reviewStateWithSession ? reviewStateWithSession : null,
    leaseRemainingMs,
    sandboxActive,
    outputSnippet: output || null,
  };
}

export async function interruptSession(sessionId: string): Promise<MergeReadinessSessionState> {
  const runtime = await resolveRuntime();
  const session = await runtime.store.getSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found.");
  }

  const workspace = await getWorkspace(runtime, session.workspace_id);
  const lease = await workspace.sandbox.getActiveLease();
  if (lease && lease.sandboxId === session.sandbox_id) {
    const attached = await workspace.sandbox.attachSession();
    if (session.process_id) {
      await attached.exec("bash", ["-lc", `kill -TERM '${session.process_id}' || true`]);
    }
    await attached.commit().catch(() => undefined);
  }

  const now = nowDate();
  await runtime.store.updateSession(session.id, {
    status: "interrupted",
    finishedAt: now,
    updatedAt: now,
  });
  await runtime.store.updateReview(session.review_id, {
    status: "interrupted",
    finishedAt: now,
    updatedAt: now,
    errorMessage: "Session interrupted by user.",
  });

  return getSessionState(sessionId);
}

export async function resumeSession(sessionId: string): Promise<MergeReadinessSessionState> {
  const runtime = await resolveRuntime();
  const session = await runtime.store.getSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found.");
  }

  const review = await runtime.store.getReviewById(session.review_id);
  if (!review) {
    throw new Error("Review not found for session.");
  }

  await resumeReview(review.id);
  const refreshedReview = await runtime.store.getReviewById(review.id);
  if (!refreshedReview) {
    throw new Error("Review not found after resume.");
  }

  const nextSessionId = refreshedReview.latestSession?.id;
  if (!nextSessionId) {
    throw new Error("Resume did not activate a session.");
  }

  return getSessionState(nextSessionId);
}
