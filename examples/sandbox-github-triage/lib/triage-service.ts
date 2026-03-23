import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { allowServices, codex, createVercelSandboxDriverFactory, github, sandkit } from "sandkit";
import type { PublicWorkspaceHandle } from "sandkit";
import { drizzleAdapter } from "sandkit/adapters/drizzle";

import { triageRepositories, triageRuns, triageSteps } from "../db/schema/triage";
import { sandkitPolicies, sandkitRuns, sandkitWorkspaces } from "../db/schema/sandkit";

type RunStatus = "queued" | "running" | "succeeded" | "failed";
type StepStatus = "queued" | "running" | "succeeded" | "failed";
type StepName = "sync-repo" | "collect-context" | "analyze" | "render-report";
type SubjectType = "issue" | "pull_request";

type TrackedRepository = typeof triageRepositories.$inferSelect;
type TriageRunSummary = {
  id: string;
  tracked_repository_id: string;
  slug: string;
  subject_type: SubjectType;
  subject_number: number;
  status: RunStatus;
  notes: string | null;
  report_path: string | null;
  report_markdown: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
};
type TrackedRepositoryInsert = typeof triageRepositories.$inferInsert;
type TriageRunRecord = typeof triageRuns.$inferSelect;
type TriageRunInsert = typeof triageRuns.$inferInsert;
type TriageStepRecord = typeof triageSteps.$inferSelect;
type TriageRunDetail = TriageRunSummary & {
  steps: readonly TriageStepRecord[];
};

type CreateTriageRunInput = {
  trackedRepositoryId: string;
  subjectType: SubjectType;
  subjectNumber: number;
  notes?: string | null;
};

type Runtime = {
  readonly listTrackedRepositories: () => Promise<TrackedRepository[]>;
  readonly createTrackedRepository: (slug: string) => Promise<TrackedRepository>;
  readonly createTriageRun: (input: CreateTriageRunInput) => Promise<TriageRunSummary>;
  readonly listTriageRuns: () => Promise<TriageRunSummary[]>;
  readonly listTriageRunsByRepo: (repositoryId: string) => Promise<TriageRunSummary[]>;
  readonly getTriageRun: (runId: string) => Promise<TriageRunDetail | null>;
  readonly getRunReport: (runId: string) => Promise<string | null>;
};

const DEFAULT_POLICY = allowServices([github(), codex()]);
const SOURCE_EXAMPLE_ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const CWD_EXAMPLE_ROOT_DIR = process.cwd().endsWith("/examples/sandbox-github-triage")
  ? process.cwd()
  : join(process.cwd(), "examples", "sandbox-github-triage");
const EXAMPLE_ROOT_DIR = existsSync(join(CWD_EXAMPLE_ROOT_DIR, "drizzle.config.ts"))
  ? CWD_EXAMPLE_ROOT_DIR
  : SOURCE_EXAMPLE_ROOT_DIR;
const DATA_DIR = join(EXAMPLE_ROOT_DIR, "data");

const REPO_SLUG_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const HOME_DIR = "/vercel/sandbox/home";
const TRIAGE_REPO_ROOT = `${HOME_DIR}/triage/repositories`;
const TRIAGE_ARTIFACTS_ROOT = `${HOME_DIR}/triage/artifacts`;
const SANDBOX_RUNTIME = process.env.SANDBOX_RUNTIME ?? "node24";
const SANDBOX_TIMEOUT_MS = parsePositiveMs(process.env.SANDBOX_TIMEOUT_MS, 300_000);
const DEFAULT_ANALYSIS_MODEL = process.env.CODEX_MODEL ?? process.env.TRIAGE_CODEX_MODEL ??
  (process.env.CI ? "gpt-5-mini" : "gpt-4o-mini");
const AI_GATEWAY_URL = process.env.AI_GATEWAY_BASE_URL ?? "https://api.openai.com/v1";

let runtimePromise: Promise<Runtime> | null = null;

function parsePositiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function toSubjectType(value: string): SubjectType {
  if (value !== "issue" && value !== "pull_request") {
    throw new Error("subjectType must be issue or pull_request");
  }

  return value;
}

function toPositiveInteger(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function normalizeRepositorySlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!REPO_SLUG_RE.test(normalized)) {
    throw new Error("Invalid repository slug. Use owner/repo.");
  }

  return normalized;
}

function repositoryDirectory(slug: string): string {
  const safeSlug = slug.replaceAll("/", "_");
  return `${TRIAGE_REPO_ROOT}/${safeSlug}`;
}

function runArtifactDirectory(runId: string): string {
  return `${TRIAGE_ARTIFACTS_ROOT}/${runId}`;
}

function isSuccessStatus(status: string): status is RunStatus {
  return status === "running" || status === "succeeded" || status === "failed" || status === "queued";
}

function truncateText(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}...`;
}

function summarizeRun(run: TriageRunRecord, slug: string): TriageRunSummary {
  const status = isSuccessStatus(run.status) ? run.status : "queued";
  return {
    id: run.id,
    tracked_repository_id: run.tracked_repository_id,
    slug,
    subject_type: run.subject_type as SubjectType,
    subject_number: run.subject_number,
    status,
    notes: run.notes ?? null,
    report_path: run.report_path ?? null,
    report_markdown: run.report_markdown ?? null,
    error_message: run.error_message ?? null,
    created_at: new Date(run.created_at),
    updated_at: new Date(run.updated_at),
    finished_at: run.finished_at ? new Date(run.finished_at) : null,
  };
}

function sanitizeReportPath(runId: string, relativePath: string): string {
  const baseDir = runArtifactDirectory(runId);
  const base = basename(relativePath) === relativePath ? relativePath : "report.md";
  return `${baseDir}/${base}`;
}

function buildSyncRepoCommand(repository: TrackedRepository): string {
  const repoDir = repositoryDirectory(repository.slug);
  return [
    "set -euo pipefail",
    `mkdir -p ${shellQuote(TRIAGE_REPO_ROOT)}`,
    `if [ -d ${shellQuote(`${repoDir}/.git`)} ]; then`,
    `  git -C ${shellQuote(repoDir)} fetch --depth 1 origin`,
    `else`,
    `  rm -rf ${shellQuote(repoDir)}`,
    `  mkdir -p ${shellQuote(dirname(repoDir))}`,
    `  git clone --depth 1 ${shellQuote(`https://github.com/${repository.slug}.git`)} ${shellQuote(repoDir)}`,
    `fi`,
  ].join("\n");
}

function buildCollectContextCommand(
  repository: TrackedRepository,
  subjectType: SubjectType,
  subjectNumber: number,
  runId: string,
): string {
  const artifactDir = runArtifactDirectory(runId);
  const scriptPath = `${artifactDir}/collect-context.js`;
  const repoSlug = repository.slug;
  return [
    "set -euo pipefail",
    `mkdir -p ${shellQuote(artifactDir)}`,
    `cat > ${shellQuote(scriptPath)} <<'NODE'`,
    `const fs = require("node:fs/promises");`,
    "",
    `const repoSlug = process.env.TRIAGE_REPO_SLUG ?? "";`,
    `const subjectType = process.env.TRIAGE_SUBJECT_TYPE ?? "";`,
    `const subjectNumberRaw = process.env.TRIAGE_SUBJECT_NUMBER ?? "";`,
    `const artifactDir = process.env.TRIAGE_ARTIFACT_DIR ?? "";`,
    `const token = process.env.GITHUB_TOKEN ?? "";`,
    "",
    `const subjectNumber = Number(subjectNumberRaw);`,
    `if (!repoSlug || !subjectType || !subjectNumberRaw || !artifactDir) {`,
    `  console.error("missing TRIAGE_* environment variables");`,
    `  process.exit(1);`,
    `}`,
    "",
    `const headers = {`,
    `  "Accept": "application/vnd.github+json",`,
    `  "User-Agent": "sandkit-github-triage",`,
    `};`,
    `if (token) {`,
    `  headers["Authorization"] = "Bearer " + token;`,
    `}`,
    "",
    `async function gh(path) {`,
    `  const response = await fetch("https://api.github.com" + path, { headers });`,
    `  if (!response.ok) {`,
    `    const text = await response.text();`,
    `    throw new Error(\`github api failed on \${path}: \${response.status} \${text}\`);`,
    `  }`,
    `  return response.json();`,
    `}`,
    "",
    `async function main() {`,
    `  const subjectPath = subjectType === "pull_request"`,
    `    ? \`/repos/\${repoSlug}/pulls/\${subjectNumber}\``,
    `    : \`/repos/\${repoSlug}/issues/\${subjectNumber}\`;`,
    `  const subject = await gh(subjectPath);`,
    `  const comments = await gh(\`/repos/\${repoSlug}/issues/\${subjectNumber}/comments\`);`,
    `  const files = subjectType === "pull_request" ? await gh(\`/repos/\${repoSlug}/pulls/\${subjectNumber}/files\`) : [];`,
    `  const context = {`,
    `    repoSlug,`,
    `    subjectType,`,
    `    subjectNumber,`,
    `    issue: subject,`,
    `    comments,`,
    `    files,`,
    `    generatedAt: new Date().toISOString(),`,
    `  };`,
    `  await fs.mkdir(artifactDir, { recursive: true });`,
    `  await fs.writeFile(\`\${artifactDir}/context.json\`, JSON.stringify(context, null, 2));`,
    `  await fs.writeFile(\`\${artifactDir}/issue.json\`, JSON.stringify(subject, null, 2));`,
    `  await fs.writeFile(\`\${artifactDir}/comments.json\`, JSON.stringify(comments, null, 2));`,
    `  await fs.writeFile(\`\${artifactDir}/files.json\`, JSON.stringify(files, null, 2));`,
    `  console.log(JSON.stringify({`,
    `    repository: repoSlug,`,
    `    subject: \`\${subjectType} #\${subjectNumber}\`,`,
    `    comments: Array.isArray(comments) ? comments.length : 0,`,
    `    files: Array.isArray(files) ? files.length : 0,`,
    `  }));`,
    `}`,
    "",
    `main().catch((error) => {`,
    `  console.error(error.message);`,
    `  process.exit(1);`,
    `});`,
    "NODE",
    `TRIAGE_REPO_SLUG=${shellQuote(repoSlug)} TRIAGE_SUBJECT_TYPE=${shellQuote(
      subjectType,
    )} TRIAGE_SUBJECT_NUMBER='${subjectNumber}' TRIAGE_ARTIFACT_DIR=${shellQuote(
      artifactDir,
    )} node ${shellQuote(scriptPath)}`,
  ].join("\n");
}

function buildAnalyzeCommand(runId: string): string {
  const artifactDir = runArtifactDirectory(runId);
  const contextPath = `${artifactDir}/context.json`;
  const analysisPath = `${artifactDir}/analysis.json`;
  const scriptPath = `${artifactDir}/analyze.js`;

  return [
    "set -euo pipefail",
    `cat > ${shellQuote(scriptPath)} <<'NODE'`,
    `const fs = require("node:fs/promises");`,
    "",
    `const contextPath = process.env.TRIAGE_CONTEXT_PATH ?? "";`,
    `const analysisPath = process.env.TRIAGE_ANALYSIS_PATH ?? "";`,
    `const token = process.env.CODEX_API_KEY ?? "";`,
    `const apiBase = process.env.TRIAGE_AI_GATEWAY_BASE_URL ?? ${JSON.stringify(AI_GATEWAY_URL)};`,
    `const model = process.env.TRIAGE_CODEX_MODEL ?? ${JSON.stringify(DEFAULT_ANALYSIS_MODEL)};`,
    "",
    `const FALLBACK = {`,
    `  reproducibleChecklist: [`,
    `    "Reproduce issue with latest default branch",`,
    `    "Reopen related comments or PR conversation",`,
    `    "Confirm changed files for regression signals",`,
    `  ],`,
    `  labelCandidates: ["bug", "needs-triage", "priority-review"],`,
    `  priorityCandidates: ["P2", "P3", "normal"],`,
    `  assigneeCandidates: ["triage-reviewer", "team-lead"],`,
    `  shortSummary: "Context collected and queued for deterministic triage synthesis.",`,
    `  verificationSuggestions: [`,
    `    "Inspect touched paths from issue/PR context",`,
    `    "Re-run tests around changed files",`,
    `  ],`,
    `};`,
    "",
    `function fallbackAnalysis(context) {`,
    `  const title = context.issue?.title || context.issue?.name || "Unknown subject";`,
    `  const body = String(context.issue?.body || "");`,
    `  const hasCrash = /crash|fail|panic|exception|error/i.test(body + " " + title);`,
    `  const priorityCandidates = hasCrash ? ["P1", "P2", "P3"] : ["P3", "P2", "P1"];`,
    `  return {`,
    `    ...FALLBACK,`,
    `    shortSummary: \`\\\${title}\\\`.slice(0, 140),`,
    `    priorityCandidates,`,
    `  };`,
    `}`,
    "",
    `async function callCodex(context) {`,
    `  if (!token) {`,
    `    return {`,
    `      ...fallbackAnalysis(context),`,
    `      analysisMode: "fallback-no-codex-key",`,
    `    };`,
    `  }`,
    `  const payload = JSON.stringify(context);`,
    `  const response = await fetch(\`\${apiBase}/chat/completions\`, {`,
    `    method: "POST",`,
    `    headers: {`,
    `      "Content-Type": "application/json",`,
    `      "Authorization": "Bearer " + token,`,
    `    },`,
    `    body: JSON.stringify({`,
    `      model,`,
    `      response_format: { type: "json_object" },`,
    `      messages: [`,
    `        { role: "system", content: "You are a strict triage analyst for GitHub issue / PR context." },`,
    `        { role: "user", content: payload },`,
    `      ],`,
    `    }),`,
    `  });`,
    `  if (!response.ok) {`,
    `    const text = await response.text();`,
    `    throw new Error(\`codex analysis failed: \${response.status} \${text}\`);`,
    `  }`,
    `  const data = await response.json();`,
    `  const content = data?.choices?.[0]?.message?.content ?? "{}";`,
    `  const parsed = JSON.parse(content);`,
    `  if (!parsed || typeof parsed !== "object") {`,
    `    throw new Error("codex analysis returned a non-object payload");`,
    `  }`,
    `  return {`,
    `    analysisMode: "codex",`,
    `    ...parsed,`,
    `  };`,
    `}`,
    "",
    `async function main() {`,
    `  const contextRaw = await fs.readFile(contextPath, "utf8");`,
    `  const context = JSON.parse(contextRaw);`,
    `  const analysis = await callCodex(context);`,
    `  const report = {`,
    `    generatedAt: new Date().toISOString(),`,
    `    subject: {`,
    `      type: context.subjectType,`,
    `      number: context.subjectNumber,`,
    `      repository: context.repoSlug,`,
    `    },`,
    `    ...FALLBACK,`,
    `    ...analysis,`,
    `  };`,
    `  await fs.writeFile(analysisPath, JSON.stringify(report, null, 2));`,
    `  console.log(JSON.stringify(report));`,
    `}`,
    "",
    `main().catch((error) => {`,
    `  console.error(error.message);`,
    `  process.exit(1);`,
    `});`,
    "NODE",
    `TRIAGE_CONTEXT_PATH=${shellQuote(contextPath)} TRIAGE_ANALYSIS_PATH=${shellQuote(analysisPath)} TRIAGE_AI_GATEWAY_BASE_URL=${shellQuote(AI_GATEWAY_URL)} TRIAGE_CODEX_MODEL=${shellQuote(DEFAULT_ANALYSIS_MODEL)} node ${shellQuote(scriptPath)}`,
  ].join("\n");
}

function buildRenderReportCommand(runId: string): string {
  const artifactDir = runArtifactDirectory(runId);
  const scriptPath = `${artifactDir}/render-report.js`;
  const contextPath = `${artifactDir}/context.json`;
  const analysisPath = `${artifactDir}/analysis.json`;
  const reportPath = `${artifactDir}/report.md`;

  return [
    "set -euo pipefail",
    `cat > ${shellQuote(scriptPath)} <<'NODE'`,
    `const fs = require("node:fs/promises");`,
    "",
    `async function main() {`,
    `  const context = JSON.parse(await fs.readFile(${shellQuote(contextPath)}, "utf8"));`,
    `  const analysis = JSON.parse(await fs.readFile(${shellQuote(analysisPath)}, "utf8"));`,
    `  const issue = context.issue || {};`,
    `  const lines = [];`,
    `  const subject = \`\${context.subjectType} #\${context.subjectNumber}\`;`,
    `  const title = issue.title || "Untitled";`,
    `  const labels = Array.isArray(issue.labels) ? issue.labels.map((row) => row.name) : [];`,
    `  const url = issue.html_url || "";`,
    `  lines.push("# GitHub Triage Report");`,
    `  lines.push("");`,
    `  lines.push(\`- Repository: \${context.repoSlug}\`);`,
    `  lines.push(\`- Subject: \${subject}\`);`,
    `  lines.push(\`- Title: \${title}\`);`,
    `  if (labels.length > 0) {`,
    `    lines.push(\`- Labels: \${labels.join(", ")}\`);`,
    `  }`,
    `  if (url) lines.push(\`- URL: \${url}\`);`,
    `  lines.push(\`- Generated: \${new Date().toISOString()}\`);`,
    `  lines.push("");`,
    `  lines.push("## Short Summary");`,
    `  lines.push(analysis.shortSummary || "No summary.");`,
    `  lines.push("");`,
    `  lines.push("## Reproducibility Checklist");`,
    `  for (const item of analysis.reproducibleChecklist || []) {`,
    `    lines.push(\`- \${item}\`);`,
    `  }`,
    `  lines.push("");`,
    `  lines.push("## Label Candidates");`,
    `  for (const item of analysis.labelCandidates || []) {`,
    `    lines.push(\`- \${item}\`);`,
    `  }`,
    `  lines.push("");`,
    `  lines.push("## Priority Candidates");`,
    `  for (const item of analysis.priorityCandidates || []) {`,
    `    lines.push(\`- \${item}\`);`,
    `  }`,
    `  lines.push("");`,
    `  lines.push("## Assignee Candidates");`,
    `  for (const item of analysis.assigneeCandidates || []) {`,
    `    lines.push(\`- \${item}\`);`,
    `  }`,
    `  lines.push("");`,
    `  lines.push("## Verification Suggestions");`,
    `  for (const item of analysis.verificationSuggestions || []) {`,
    `    lines.push(\`- \${item}\`);`,
    `  }`,
    `  lines.push("");`,
    `  lines.push("## Source Body");`,
    `  const body = issue.body || "";`,
    `  lines.push(String(body).split("\\n").slice(0, 80).join("\\n"));`,
    `  const report = lines.join("\\n");`,
    `  await fs.writeFile(${shellQuote(reportPath)}, report);`,
    `  console.log(report);`,
    `}`,
    "",
    `main().catch((error) => {`,
    `  console.error(error.message);`,
    `  process.exit(1);`,
    `});`,
    "NODE",
    `node ${shellQuote(scriptPath)}`,
  ].join("\n");
}

async function withRuntime(): Promise<Runtime> {
  if (runtimePromise) {
    return runtimePromise;
  }

  runtimePromise = createRuntime();
  return runtimePromise;
}

async function createRuntime(): Promise<Runtime> {
  await mkdir(DATA_DIR, { recursive: true });
  const client = createClient({
    url: `file:${join(DATA_DIR, "triage.sqlite")}`,
  });
  const db = drizzle(client, {
    schema: {
      sandkitWorkspaces,
      sandkitRuns,
      sandkitPolicies,
      triageRepositories,
      triageRuns,
      triageSteps,
    },
  });
  const adapter = drizzleAdapter(db, {
    provider: "sqlite",
  });
  const runtime = sandkit({
    database: adapter,
    sandbox: {
      driverFactory: createVercelSandboxDriverFactory({
        runtime: SANDBOX_RUNTIME,
        timeout: SANDBOX_TIMEOUT_MS,
      }),
    },
    policy: DEFAULT_POLICY,
  });

  async function getTrackedRepositoryById(id: string): Promise<TrackedRepository> {
    const rows = await db
      .select()
      .from(triageRepositories)
      .where(eq(triageRepositories.id, id))
      .limit(1);
    if (!rows[0]) {
      throw new Error("Repository not found.");
    }

    return rows[0];
  }

  async function listTrackedRepositories(): Promise<TrackedRepository[]> {
    return db.select().from(triageRepositories).orderBy(desc(triageRepositories.updated_at));
  }

  async function createTrackedRepository(rawSlug: string): Promise<TrackedRepository> {
    const slug = normalizeRepositorySlug(rawSlug);
    const existingRows = await db.select().from(triageRepositories).where(eq(triageRepositories.slug, slug));
    if (existingRows[0]) {
      return existingRows[0];
    }

    const workspace = await runtime.createWorkspace({
      name: `triage:${slug}`,
      metadata: {
        triage: { kind: "repository", slug },
      },
      policy: DEFAULT_POLICY,
    });

    const now = new Date();
    const repository: TrackedRepositoryInsert = {
      id: randomUUID(),
      workspace_id: workspace.id,
      slug,
      default_branch: null,
      last_synced_at: null,
      created_at: now,
      updated_at: now,
    };

    await db.insert(triageRepositories).values(repository);
    const createdRows = await db
      .select()
      .from(triageRepositories)
      .where(eq(triageRepositories.id, repository.id))
      .limit(1);

    if (!createdRows[0]) {
      throw new Error("Failed to create repository row.");
    }

    return createdRows[0];
  }

  async function setRunStatus(
    runId: string,
    status: RunStatus,
    updates: Partial<{
      report_path: string | null;
      report_markdown: string | null;
      error_message: string | null;
    }>,
  ) {
    const now = new Date();
    const patch: Partial<TriageRunInsert> = {
      status,
      updated_at: now,
      ...updates,
    };
    if (status === "succeeded" || status === "failed") {
      patch.finished_at = now;
    }

    await db.update(triageRuns).set(patch).where(eq(triageRuns.id, runId));
  }

  async function createRunStep(
    runId: string,
    stepName: StepName,
    artifactPath: string,
    status: StepStatus,
  ): Promise<string> {
    const now = new Date();
    const row = {
      id: randomUUID(),
      triage_run_id: runId,
      step_name: stepName,
      status,
      artifact_path: artifactPath,
      command_exit_code: null,
      command_stdout: null,
      command_stderr: null,
      started_at: now,
      finished_at: null,
    };
    await db.insert(triageSteps).values(row);

    return row.id;
  }

  async function updateStep(stepId: string, updates: Partial<TriageStepRecord>) {
    await db.update(triageSteps).set(updates).where(eq(triageSteps.id, stepId));
  }

  async function runStep(
    workspace: PublicWorkspaceHandle,
    run: TriageRunRecord,
    stepName: StepName,
    command: string,
    artifactPath: string,
    onComplete?: (stdout: string) => Promise<void> | void,
  ) {
    const stepId = await createRunStep(run.id, stepName, artifactPath, "running");
    await updateStep(stepId, { started_at: new Date(), status: "running" });

    const result = await workspace.sandbox.runCommand("bash", ["-lc", command]);
    const finishedAt = new Date();
    const output = `${result.stdout ?? ""}`;
    const errorText = `${result.stderr ?? ""}`;
    if (result.exitCode !== 0) {
      await updateStep(stepId, {
        status: "failed",
        command_exit_code: result.exitCode,
        command_stdout: truncateText(output, 25000),
        command_stderr: truncateText(errorText, 25000),
        finished_at: finishedAt,
      });
      await setRunStatus(run.id, "failed", {
        error_message: `${stepName} failed: ${truncateText(errorText, 1000)}`,
      });
      throw new Error(`${stepName} failed with exit code ${result.exitCode}`);
    }

    await updateStep(stepId, {
      status: "succeeded",
      command_exit_code: result.exitCode,
      command_stdout: truncateText(output, 25000),
      command_stderr: truncateText(errorText, 25000),
      finished_at: finishedAt,
    });
    if (onComplete) {
      await onComplete(output);
    }
  }

  async function updateRepositorySyncTime(repositoryId: string) {
    const now = new Date();
    await db
      .update(triageRepositories)
      .set({ last_synced_at: now, updated_at: now })
      .where(eq(triageRepositories.id, repositoryId));
  }

  async function runWorkflow(workspace: PublicWorkspaceHandle, repository: TrackedRepository, run: TriageRunRecord) {
    await setRunStatus(run.id, "running", {});
    const artifactDir = runArtifactDirectory(run.id);
    try {
      await runStep(
        workspace,
        run,
        "sync-repo",
        buildSyncRepoCommand(repository),
        `${artifactDir}/repo-sync.log`,
      );

      await updateRepositorySyncTime(repository.id);

      await runStep(
        workspace,
        run,
        "collect-context",
        buildCollectContextCommand(
          repository,
          run.subject_type as SubjectType,
          run.subject_number,
          run.id,
        ),
        `${artifactDir}/context.json`,
      );

      await runStep(
        workspace,
        run,
        "analyze",
        buildAnalyzeCommand(run.id),
        `${artifactDir}/analysis.json`,
      );

      await runStep(
        workspace,
        run,
        "render-report",
        buildRenderReportCommand(run.id),
        `${artifactDir}/report.md`,
        async (stdout) => {
          await setRunStatus(run.id, "running", {
            report_markdown: stdout.trim(),
            report_path: sanitizeReportPath(run.id, "report.md"),
            error_message: null,
          });
        },
      );

      await setRunStatus(run.id, "succeeded", {
        report_path: sanitizeReportPath(run.id, "report.md"),
        error_message: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setRunStatus(run.id, "failed", { error_message: message });
      throw error;
    }
  }

  async function createTriageRun(
    input: CreateTriageRunInput,
  ): Promise<TriageRunSummary> {
    const repository = await getTrackedRepositoryById(input.trackedRepositoryId);
    const workspace = await runtime.getWorkspace(repository.workspace_id);
    const now = new Date();
    const runRecord: TriageRunInsert = {
      id: randomUUID(),
      tracked_repository_id: repository.id,
      subject_type: input.subjectType,
      subject_number: input.subjectNumber,
      status: "queued",
      notes: input.notes ?? null,
      report_path: null,
      report_markdown: null,
      error_message: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };

    await db.insert(triageRuns).values(runRecord);
    const createdRows = await db
      .select()
      .from(triageRuns)
      .where(eq(triageRuns.id, runRecord.id))
      .limit(1);

    const created = createdRows[0];
    if (!created) {
      throw new Error("Failed to create triage run.");
    }

    try {
      await runWorkflow(workspace, repository, created as TriageRunRecord);
    } catch {
      // runWorkflow already persists terminal failure on run row.
    }
    const finalizedRows = await db
      .select()
      .from(triageRuns)
      .where(eq(triageRuns.id, created.id))
      .limit(1);
    if (!finalizedRows[0]) {
      throw new Error("Failed to read triage run after workflow.");
    }

    return summarizeRun(finalizedRows[0], repository.slug);
  }

  async function listTriageRunsByRepo(repositoryId: string): Promise<TriageRunSummary[]> {
    const repository = await getTrackedRepositoryById(repositoryId);
    const runs = await db
      .select()
      .from(triageRuns)
      .where(eq(triageRuns.tracked_repository_id, repository.id))
      .orderBy(desc(triageRuns.created_at))
      .limit(50);

    return runs.map((run) => summarizeRun(run, repository.slug));
  }

  async function listTriageRuns(): Promise<TriageRunSummary[]> {
    const runs = await db.select().from(triageRuns).orderBy(desc(triageRuns.created_at)).limit(100);
    if (!runs.length) {
      return [];
    }

    const repoIds = runs.map((run) => run.tracked_repository_id);
    const repositories = await db
      .select()
      .from(triageRepositories)
      .where(inArray(triageRepositories.id, repoIds));
    const repositoryById = new Map(repositories.map((row) => [row.id, row.slug]));

    return runs.map((run) => summarizeRun(run, repositoryById.get(run.tracked_repository_id) ?? ""));
  }

  async function getTriageRun(runId: string): Promise<TriageRunDetail | null> {
    const runRows = await db.select().from(triageRuns).where(eq(triageRuns.id, runId)).limit(1);
    if (!runRows[0]) {
      return null;
    }

    const run = runRows[0];
    const repositoryRows = await db
      .select()
      .from(triageRepositories)
      .where(eq(triageRepositories.id, run.tracked_repository_id))
      .limit(1);
    if (!repositoryRows[0]) {
      return null;
    }

    const steps = await db
      .select()
      .from(triageSteps)
      .where(eq(triageSteps.triage_run_id, run.id))
      .orderBy(asc(triageSteps.started_at));

    return {
      ...summarizeRun(run, repositoryRows[0].slug),
      steps,
    };
  }

  async function getRunReport(runId: string): Promise<string | null> {
    const run = await getTriageRun(runId);
    if (!run || !run.report_markdown) {
      return null;
    }

    return run.report_markdown;
  }

  return {
    listTrackedRepositories,
    createTrackedRepository,
    createTriageRun,
    listTriageRuns,
    listTriageRunsByRepo,
    getTriageRun,
    getRunReport,
  };
}

export async function listTrackedRepositories(): Promise<TrackedRepository[]> {
  return (await withRuntime()).listTrackedRepositories();
}

export async function createTrackedRepository(slug: string): Promise<TrackedRepository> {
  return (await withRuntime()).createTrackedRepository(slug);
}

export async function createTriageRun(input: {
  trackedRepositoryId: string;
  subjectType: string;
  subjectNumber: number | string;
  notes?: string | null;
}): Promise<TriageRunSummary> {
  const subjectType = toSubjectType(input.subjectType);
  const subjectNumber = toPositiveInteger(input.subjectNumber, "subjectNumber");
  const run: CreateTriageRunInput = {
    trackedRepositoryId: input.trackedRepositoryId,
    subjectType,
    subjectNumber,
    notes: input.notes ?? null,
  };

  return (await withRuntime()).createTriageRun(run);
}

export async function listTriageRuns(): Promise<TriageRunSummary[]> {
  return (await withRuntime()).listTriageRuns();
}

export async function listTriageRunsByRepo(repositoryId: string): Promise<TriageRunSummary[]> {
  return (await withRuntime()).listTriageRunsByRepo(repositoryId);
}

export async function getTriageRun(runId: string): Promise<TriageRunDetail | null> {
  return (await withRuntime()).getTriageRun(runId);
}

export async function getRunReport(runId: string): Promise<string | null> {
  return (await withRuntime()).getRunReport(runId);
}

export type {
  RunStatus,
  SubjectType,
  TriageRunDetail,
  TriageRunSummary,
  TriageStepRecord,
  TrackedRepository,
};
