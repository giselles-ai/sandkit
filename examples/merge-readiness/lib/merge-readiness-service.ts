import { createHash } from "node:crypto";
import { join } from "node:path";

import type { PublicWorkspaceHandle, WorkspaceSessionHandle } from "sandkit";

import {
  getMergeReadinessRuntime,
  getOrCreateWorkspaceById,
  CODEX_BIN_PATH,
  MERGE_READINESS_ROOT,
  NODE_BIN_DIR,
  NPM_PREFIX,
  REVIEW_WORKSPACE_PREFIX,
  summarizeWorkspaceId,
} from "./merge-readiness-app";
import {
  RESUMABLE_REVIEW_STATUSES,
  TERMINAL_REVIEW_STATUSES,
  type MergeReadinessRecommendation,
  type MergeReadinessReviewRecord,
  type MergeReadinessSessionRecord,
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
  baseSha: string;
  headSha: string;
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
  errorDetail: string | null;
};

export type MergeReadinessSessionState = MergeReadinessSessionRecord & {
  review: MergeReadinessReviewRecord | null;
  leaseRemainingMs: number | null;
  sandboxActive: boolean;
  outputSnippet: string | null;
  stderrSnippet: string | null;
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
  resetWorkspaceSandboxState: Awaited<
    ReturnType<typeof getMergeReadinessRuntime>
  >["resetWorkspaceSandboxState"];
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

function createLogStep(step: string, context: Record<string, unknown> = {}) {
  const startedAt = Date.now();
  console.info(`[merge-readiness] ${step} start`, {
    startedAt: new Date(startedAt).toISOString(),
    ...context,
  });

  return {
    success(extra: Record<string, unknown> = {}) {
      console.info(`[merge-readiness] ${step} success`, {
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        ...context,
        ...extra,
      });
    },
    failure(error: unknown, extra: Record<string, unknown> = {}) {
      console.error(`[merge-readiness] ${step} failure`, {
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        ...context,
        ...extra,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

const CURL_CONNECT_TIMEOUT_SECONDS = 10;
const CURL_MAX_TIME_SECONDS = 30;

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

function assertRequiredInvestigationEnv(): void {
  const missing: string[] = [];

  if (!process.env.GITHUB_TOKEN?.trim()) {
    missing.push("GITHUB_TOKEN");
  }

  if (!process.env.CODEX_API_KEY?.trim()) {
    missing.push("CODEX_API_KEY");
  }

  if (missing.length > 0) {
    throw new Error(
      `Merge Readiness requires ${missing.join(" and ")} before it can investigate a PR. See examples/merge-readiness/README.md for setup.`,
    );
  }
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

type GitHubApiResponse = {
  statusCode: number;
  body: string;
  stderr: string;
};

type GitHubPrResponse = {
  title?: string;
  state?: string;
  body?: string;
  draft?: boolean;
  base?: {
    ref?: string;
    sha?: string;
  };
  head?: {
    ref?: string;
    sha?: string;
  };
  additions?: number;
  deletions?: number;
  changed_files?: number;
};

type GitHubCheckRunsResponse = {
  total_count?: number;
  check_runs?: Array<{
    name?: string;
    status?: string;
    conclusion?: string;
    output?: {
      title?: string;
    };
    app?: {
      name?: string;
    };
  }>;
};

type GitHubStatusResponse = {
  state?: string;
  statuses?: Array<{
    context?: string;
    state?: string;
  }>;
};

function resolveRuntime(): Promise<RuntimeFacade> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const runtime = await getMergeReadinessRuntime();
      return {
        app: runtime.app,
        store: runtime.store,
        resetWorkspaceSandboxState: runtime.resetWorkspaceSandboxState,
      };
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

function workspaceArtifactDir(workspaceId: string): string {
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

function parseCurlOutput(raw: string): { statusCode: number; body: string } {
  const marker = "\n__MR_HTTP_STATUS__:";
  const markerIndex = raw.lastIndexOf(marker);
  if (markerIndex < 0) {
    return { statusCode: 0, body: raw };
  }

  const body = raw.slice(0, markerIndex).trimEnd();
  const statusText = raw.slice(markerIndex + marker.length).trim();
  return {
    statusCode: Number.parseInt(statusText, 10),
    body,
  };
}

async function runGitHubApiRequest(
  workspace: PublicWorkspaceHandle,
  path: string,
): Promise<GitHubApiResponse> {
  const command = [
    "set -euo pipefail",
    "payload=$(mktemp)",
    `status_code=$(curl -sS -o "$payload" -w "%{http_code}" \\`,
    `  --connect-timeout ${CURL_CONNECT_TIMEOUT_SECONDS} \\`,
    `  --max-time ${CURL_MAX_TIME_SECONDS} \\`,
    `  -H "Accept: application/vnd.github+json" \\`,
    `  -H "User-Agent: merge-readiness" \\`,
    `  -L -X GET "${path}")`,
    'cat "$payload"',
    'printf "\\n__MR_HTTP_STATUS__:%s\\n" "$status_code"',
    'rm -f "$payload"',
  ].join("\n");

  const result = await runWorkspaceCommand(workspace, "bash", ["-lc", command]);
  const { statusCode, body } = parseCurlOutput(result.stdout);
  return { statusCode, body, stderr: result.stderr };
}

function requireSuccessfulGitHubResponse(target: string, response: GitHubApiResponse): string {
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `${target} request failed: status ${response.statusCode || "unknown"}; ${trimHead(
        safeText(response.body) || safeText(response.stderr),
        1400,
      )}`,
    );
  }

  return response.body;
}

function buildGitHubApiUrl(owner: string, repo: string, route: string): string {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  return `https://api.github.com/repos/${safeOwner}/${safeRepo}/${route.replace(/^\/+/, "")}`;
}

function isRecoverableSandboxProvisionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Status code 400 is not ok");
}

async function withRecoveredWorkspace<T>(
  runtime: RuntimeFacade,
  workspaceId: string,
  action: (workspace: PublicWorkspaceHandle) => Promise<T>,
): Promise<T> {
  const log = createLogStep("with_recovered_workspace", { workspaceId });
  const workspace = await getWorkspace(runtime, workspaceId);

  try {
    const result = await action(workspace);
    log.success({ recovery: false });
    return result;
  } catch (error) {
    if (!isRecoverableSandboxProvisionError(error)) {
      log.failure(error, { recovery: false });
      throw error;
    }

    console.warn(
      "[merge-readiness] recoverable sandbox provisioning error, resetting workspace state",
      {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    await runtime.resetWorkspaceSandboxState(workspaceId);
    const recoveredWorkspace = await getWorkspace(runtime, workspaceId);
    try {
      const result = await action(recoveredWorkspace);
      log.success({ recovery: true });
      return result;
    } catch (retryError) {
      log.failure(retryError, { recovery: true });
      throw retryError;
    }
  }
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
  const artifactDir = workspaceArtifactDir(workspaceId);
  const promptPath = join(artifactDir, `${reviewId}.prompt`);
  const schemaPath = join(artifactDir, `${reviewId}.schema.json`);
  const stdoutPath = join(artifactDir, `${reviewId}.stdout.log`);
  const stderrPath = join(artifactDir, `${reviewId}.stderr.log`);
  const resultPath = join(artifactDir, `${reviewId}.result.json`);
  const promptEncoded = Buffer.from(prompt).toString("base64");
  const schemaEncoded = Buffer.from(DECISION_SCHEMA).toString("base64");

  const command = [
    "set -euo pipefail",
    `export PATH='${NODE_BIN_DIR}:${NPM_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin'`,
    `mkdir -p '${artifactDir}'`,
    `printf '%s' '${schemaEncoded}' | base64 -d > '${schemaPath}'`,
    `printf '%s' '${promptEncoded}' | base64 -d > '${promptPath}'`,
    `prompt=$(cat '${promptPath}')`,
    `'${CODEX_BIN_PATH}' exec --yolo --skip-git-repo-check --color never --json --output-schema '${schemaPath}' --output-last-message '${resultPath}' -C '${repoPath}' "$prompt" > '${stdoutPath}' 2> '${stderrPath}'`,
  ].join("\n");

  return { command, stdoutPath, stderrPath, resultPath };
}

async function readPullRequestContext(
  workspace: PublicWorkspaceHandle,
  pr: ParsedPullRequest,
): Promise<PullRequestContext> {
  const apiResponse = await runGitHubApiRequest(
    workspace,
    buildGitHubApiUrl(pr.owner, pr.repo, `pulls/${pr.number}`),
  );
  const bodyText = requireSuccessfulGitHubResponse("PR metadata", apiResponse);
  const parsed = JSON.parse(bodyText) as GitHubPrResponse;

  return {
    title: safeText(parsed.title, "Untitled PR"),
    state: safeText(parsed.state, "unknown"),
    body: safeText(parsed.body),
    isDraft: parsed.draft === true,
    baseRefName: safeText(parsed.base?.ref, ""),
    headRefName: safeText(parsed.head?.ref, ""),
    baseSha: safeText(parsed.base?.sha),
    headSha: safeText(parsed.head?.sha),
    additions: parseNumber(String(parsed.additions), 0),
    deletions: parseNumber(String(parsed.deletions), 0),
    changedFiles: parseNumber(String(parsed.changed_files), 0),
  };
}

async function runBaselineCommands(
  workspace: PublicWorkspaceHandle,
  pr: ParsedPullRequest,
  context: PullRequestContext,
): Promise<{ checks: string; diffStat: string }> {
  const statusParts: string[] = [];

  try {
    const log = createLogStep("baseline_check_runs", {
      repo: pr.repoSlug,
      headSha: context.headSha ?? null,
    });
    if (!context.headSha) {
      throw new Error("missing head SHA");
    }

    const checkRunsApi = await runGitHubApiRequest(
      workspace,
      buildGitHubApiUrl(pr.owner, pr.repo, `commits/${context.headSha}/check-runs`),
    );

    let checksText = "";
    if (checkRunsApi.statusCode >= 200 && checkRunsApi.statusCode < 300) {
      const checkRuns = JSON.parse(checkRunsApi.body) as GitHubCheckRunsResponse;
      const runs = Array.isArray(checkRuns.check_runs) ? checkRuns.check_runs : [];
      if (runs.length > 0) {
        checksText = runs
          .map(
            (run) =>
              `- ${(run.name || "unknown").trim()} (${
                run.app?.name ?? "checks"
              }): ${run.status || "unknown"} / ${run.conclusion || "pending"}`,
          )
          .join("\n");
      }
    }

    if (checksText) {
      statusParts.push(`check-runs:\n${checksText}`);
    } else if (checkRunsApi.statusCode >= 200 && checkRunsApi.statusCode < 300) {
      statusParts.push("check-runs: no completed check-run records available.");
    } else {
      statusParts.push(
        `check-runs: request failed with status ${checkRunsApi.statusCode} (${trimHead(
          safeText(checkRunsApi.body || safeText(checkRunsApi.stderr)),
        )})`,
      );
    }
    log.success({ statusCode: checkRunsApi.statusCode, bytes: checkRunsApi.body.length });
  } catch (error) {
    statusParts.push(`check-runs failed: ${error instanceof Error ? error.message : `${error}`}`);
    console.error("[merge-readiness] baseline_check_runs failure", {
      repo: pr.repoSlug,
      headSha: context.headSha ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const log = createLogStep("baseline_commit_status", {
      repo: pr.repoSlug,
      headSha: context.headSha ?? null,
    });
    if (!context.headSha) {
      throw new Error("missing head SHA");
    }

    const statusApi = await runGitHubApiRequest(
      workspace,
      buildGitHubApiUrl(pr.owner, pr.repo, `commits/${context.headSha}/status`),
    );
    if (statusApi.statusCode >= 200 && statusApi.statusCode < 300) {
      const status = JSON.parse(statusApi.body) as GitHubStatusResponse;
      statusParts.push(`overall status: ${safeText(status.state, "unknown")}`);
      if (Array.isArray(status.statuses)) {
        for (const item of status.statuses.slice(0, 8)) {
          statusParts.push(
            `- ${safeText(item.context, "context")} => ${safeText(item.state, "unknown")}`,
          );
        }
      }
    } else {
      statusParts.push(
        `commit status: request failed with status ${statusApi.statusCode} (${trimHead(
          safeText(statusApi.body, ""),
          1000,
        )})`,
      );
    }
    log.success({ statusCode: statusApi.statusCode, bytes: statusApi.body.length });
  } catch (error) {
    statusParts.push(
      `commit status failed: ${error instanceof Error ? error.message : `${error}`}`,
    );
    console.error("[merge-readiness] baseline_commit_status failure", {
      repo: pr.repoSlug,
      headSha: context.headSha ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const diffStat = await collectDiffStatFromApi(workspace, pr);
  return {
    checks: trimHead(statusParts.join("\n"), 5000),
    diffStat,
  };
}

async function collectDiffStatFromApi(
  workspace: PublicWorkspaceHandle,
  pr: ParsedPullRequest,
): Promise<string> {
  const log = createLogStep("baseline_diff_stat", { repo: pr.repoSlug, prNumber: pr.number });
  const filesApi = await runGitHubApiRequest(
    workspace,
    buildGitHubApiUrl(pr.owner, pr.repo, `pulls/${pr.number}/files?per_page=100`),
  );
  if (filesApi.statusCode < 200 || filesApi.statusCode >= 300) {
    const result = trimHead(
      `Diff stat request failed with status ${filesApi.statusCode} (${safeText(
        filesApi.body || filesApi.stderr,
      )})`,
      1200,
    );
    log.failure(new Error(result), { statusCode: filesApi.statusCode });
    return result;
  }

  const files = JSON.parse(filesApi.body) as Array<{
    filename?: string;
    status?: string;
    additions?: number;
    deletions?: number;
    changes?: number;
  }>;

  if (!Array.isArray(files) || files.length === 0) {
    log.success({ statusCode: filesApi.statusCode, files: 0 });
    return "Diff stat unavailable: no PR file entries returned.";
  }

  const result = trimHead(
    files
      .slice(0, 100)
      .map((file) => {
        const filename = safeText(file.filename, "unknown");
        const status = safeText(file.status, "modified");
        const additions = parseNumber(String(file.additions), 0);
        const deletions = parseNumber(String(file.deletions), 0);
        const changes = parseNumber(String(file.changes), additions + deletions);
        return `- ${filename} (${status}, +${additions} -${deletions}, ${changes} changes)`;
      })
      .join("\n"),
    2000,
  );
  log.success({ statusCode: filesApi.statusCode, files: files.length });
  return result;
}

async function ensureRepoPrepared(
  workspace: PublicWorkspaceHandle,
  pr: ParsedPullRequest,
  context: PullRequestContext,
): Promise<string> {
  const repoPath = workspaceRepoPath(workspace.id);
  if (!context.headSha) {
    throw new Error("Repository preparation failed: missing PR head SHA.");
  }

  const checkoutScript = [
    "set -euo pipefail",
    "archive=$(mktemp)",
    `repo_url="${buildGitHubApiUrl(pr.owner, pr.repo, `tarball/${context.headSha}`)}"`,
    `status_code=$(curl -sS -o "$archive" -w "%{http_code}" \\`,
    `  --connect-timeout ${CURL_CONNECT_TIMEOUT_SECONDS} \\`,
    `  --max-time ${CURL_MAX_TIME_SECONDS} \\`,
    `  -H "Accept: application/vnd.github+json" \\`,
    `  -H "User-Agent: merge-readiness" \\`,
    '  -L "$repo_url")',
    'if [ "$status_code" -lt 200 ] || [ "$status_code" -ge 300 ]; then',
    '  echo "Failed to download repository tarball." >&2',
    '  echo "HTTP status: ${status_code}" >&2',
    '  rm -f "$archive"',
    "  exit 2",
    "fi",
    `rm -rf '${repoPath}'`,
    `mkdir -p '${repoPath}'`,
    `tar -xzf "$archive" -C '${repoPath}' --strip-components=1`,
    'rm -f "$archive"',
  ].join("\n");

  const prepared = await runWorkspaceCommand(workspace, "bash", ["-lc", checkoutScript]);
  if (prepared.exitCode !== 0) {
    throw new Error(
      `Repository preparation failed:\n${trimHead(prepared.stderr || prepared.stdout)}`,
    );
  }

  return repoPath;
}

async function verifySharedCodexCliSetup(workspace: PublicWorkspaceHandle): Promise<void> {
  const check = await workspace.sandbox.runCommand("bash", [
    "-lc",
    [
      "set -euo pipefail",
      `export PATH='${NODE_BIN_DIR}:${NPM_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin'`,
      `'${CODEX_BIN_PATH}' --version`,
    ].join("\n"),
  ]);

  if (check.exitCode !== 0) {
    throw new Error(
      `Shared Codex CLI setup verification failed:\n${trimHead(check.stderr || check.stdout, 2000)}`,
    );
  }
}

async function finalizeSession(
  review: MergeReadinessReviewRecord,
  session: MergeReadinessSessionRecord,
  decision: CodexDecision | null,
  sessionHandle: WorkspaceSessionHandle | null,
): Promise<void> {
  const runtime = await resolveRuntime();
  const now = nowDate();
  const reviewStateLabel = safeText(review.status, "unknown");
  const isOpenReview =
    reviewStateLabel === "requested" ||
    reviewStateLabel === "monitoring" ||
    reviewStateLabel === "running";

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

  const verdictStatus = isOpenReview && decision.verdict === "safe_to_merge" ? "ready" : "blocked";
  const evidence = [...decision.evidence];

  await runtime.store.updateReview(review.id, {
    status: verdictStatus,
    verdict: decision.verdict,
    recommendation: decision.recommendation,
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
  await finalizeSession(reviewState, latestSession, parsedDecision, sessionHandle);
}

async function startInvestigationSession(
  review: MergeReadinessReviewRecord,
): Promise<MergeReadinessSessionRecord> {
  const runtime = await resolveRuntime();
  const pr = parsePullRequest(review.pr_url);
  return withRecoveredWorkspace(runtime, review.workspace_id, async (workspace) => {
    const sessionLog = createLogStep("start_investigation_session", {
      reviewId: review.id,
      workspaceId: review.workspace_id,
      prUrl: review.pr_url,
    });

    try {
      const prContextLog = createLogStep("read_pr_context", {
        reviewId: review.id,
        workspaceId: review.workspace_id,
      });
      const context = await readPullRequestContext(workspace, pr);
      prContextLog.success({
        title: context.title,
        changedFiles: context.changedFiles,
        draft: context.isDraft,
      });

      const baselineLog = createLogStep("baseline_checks", {
        reviewId: review.id,
        workspaceId: review.workspace_id,
      });
      const baseline = await runBaselineCommands(workspace, pr, context);
      const repoPath = await ensureRepoPrepared(workspace, pr, context);
      baselineLog.success({
        checksBytes: baseline.checks.length,
        diffStatBytes: baseline.diffStat.length,
      });

      const codexSetupVerificationLog = createLogStep("verify_shared_codex_cli_setup", {
        reviewId: review.id,
        workspaceId: review.workspace_id,
      });
      await verifySharedCodexCliSetup(workspace);
      codexSetupVerificationLog.success({ codexBin: CODEX_BIN_PATH });

      const prompt = buildDecisionFromContext(pr, context, {
        checks: baseline.checks,
        diffStat: baseline.diffStat,
      });
      const invocation = buildCodexScript(workspace.id, review.id, repoPath, prompt);

      await runtime.store.updateReview(review.id, {
        status: "running",
        outputPath: invocation.resultPath,
      });

      const processLog = createLogStep("run_codex_exec", {
        reviewId: review.id,
        workspaceId: review.workspace_id,
      });
      const result = await workspace.sandbox.runCommand({
        command: "bash",
        args: ["-lc", invocation.command],
      });
      processLog.success({
        exitCode: result.exitCode,
        stdoutPath: invocation.stdoutPath,
        stderrPath: invocation.stderrPath,
        resultPath: invocation.resultPath,
      });

      const sessionRecord = await runtime.store.createSession(review.id, review.workspace_id, {
        sandboxId: null,
        processId: null,
        status: result.exitCode === 0 ? "completed" : "failed",
        command: `codex exec (durable review ${review.id})`,
        stdoutPath: invocation.stdoutPath,
        stderrPath: invocation.stderrPath,
        resultPath: invocation.resultPath,
      });

      const parsedDecision = await readResultFromSessionFile(
        async (target) =>
          (
            await runWorkspaceCommand(workspace, "bash", [
              "-lc",
              `cat '${target}' 2>/dev/null || true`,
            ])
          ).stdout,
        invocation.resultPath,
      );
      await finalizeSession(review, sessionRecord, parsedDecision, null);

      sessionLog.success({ sessionId: sessionRecord.id });
      return sessionRecord;
    } catch (error) {
      sessionLog.failure(error);
      throw error;
    }
  });
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
  assertRequiredInvestigationEnv();
  const requestLog = createLogStep("request_review", { prUrl });
  const runtime = await resolveRuntime();
  const parsed = parsePullRequest(prUrl);
  const workspaceId = reviewWorkspaceIdFromUrl(parsed.url);
  const existing = await runtime.store.getLatestReviewByPrUrl(parsed.url);

  if (existing && isReviewStatusActive(existing.status)) {
    try {
      const workspace = await getWorkspace(runtime, workspaceId);
      const reconcileLog = createLogStep("reconcile_existing_review", {
        reviewId: existing.id,
        workspaceId,
      });
      await reconcileReviewProgress(workspace, existing.id);
      reconcileLog.success();
      const refreshed = await runtime.store.getReviewById(existing.id);
      if (!refreshed) {
        throw new Error("Review not found while reconciling.");
      }
      requestLog.success({ reviewId: refreshed.id, reused: true, started: false });
      return {
        review: buildSummary(refreshed, refreshed.latestSession),
        workspaceId,
        started: false,
      };
    } catch (error) {
      requestLog.failure(error, { workspaceId, existingReviewId: existing.id, reused: true });
      throw error;
    }
  }

  try {
    const context = await withRecoveredWorkspace(runtime, workspaceId, (workspace) =>
      readPullRequestContext(workspace, parsed),
    );
    const review = await runtime.store.createReview(workspaceId, {
      prUrl: parsed.url,
      prTitle: context.title,
      prRepo: parsed.repo,
      prOwner: parsed.owner,
      prNumber: parsed.number,
      status: "requested",
    });

    const session = await startInvestigationSession(review);
    const refreshed = await runtime.store.getReviewById(review.id);
    if (!refreshed) {
      throw new Error("Review disappeared after start.");
    }

    requestLog.success({ reviewId: review.id, reused: false, started: Boolean(session) });
    return {
      review: buildSummary(refreshed, refreshed.latestSession ?? session),
      workspaceId,
      started: Boolean(session),
    };
  } catch (error) {
    requestLog.failure(error, { workspaceId, reused: false });
    throw error;
  }
}

export async function resumeReview(reviewId: string): Promise<TopReviewSummary> {
  assertRequiredInvestigationEnv();
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
    errorDetail: refreshed.error_message ?? null,
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
  const stderr = trimHead(await readSessionFile(workspace, session, session.stderr_path));

  return {
    ...session,
    review: reviewStateWithSession ? reviewStateWithSession : null,
    leaseRemainingMs,
    sandboxActive,
    outputSnippet: output || null,
    stderrSnippet: stderr || null,
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
