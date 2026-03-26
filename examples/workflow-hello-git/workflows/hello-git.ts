import { allowService, allowServices, codex, github } from "@giselles-ai/sandkit";
import { FatalError, getWritable } from "workflow";
import { z } from "zod";

import { sandkit } from "@/lib/sandkit";
import { createWorkflowPrReviewRunEvent } from "@/lib/workflow-hello-git-events";

type ParsedPullRequest = {
  readonly url: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly repoSlug: string;
};

export type WorkflowPrReviewInput = {
  readonly prUrl: string;
  readonly requestedAt?: string;
};

export type ParsedWorkflowPrReviewInput = {
  readonly pr: ParsedPullRequest;
  readonly requestedAt: string;
};

const workflowPrReviewArtifactSchema = z.object({
  path: z.string(),
  description: z.string(),
});

const workflowPrReviewCheckSchema = z.object({
  label: z.string(),
  command: z.string(),
  outcome: z.enum(["succeeded", "failed", "not_run"]),
  note: z.string().nullable(),
});

const workflowPrReviewReportSchema = z.object({
  summary: z.string(),
  checks: z.array(workflowPrReviewCheckSchema),
  notes: z.array(z.string()).nullable(),
  files: z.array(workflowPrReviewArtifactSchema).nullable(),
});

export type WorkflowPrReviewArtifact = z.infer<typeof workflowPrReviewArtifactSchema>;
export type WorkflowPrReviewCheck = z.infer<typeof workflowPrReviewCheckSchema>;
export type WorkflowPrReviewReport = z.infer<typeof workflowPrReviewReportSchema>;

export type WorkflowPrReviewFinalOutput = {
  readonly kind: "prReview";
  readonly workspaceId: string;
  readonly prUrl: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly requestedAt: string;
  readonly clonePerformed: boolean;
  readonly codexExitCode: number;
  readonly report: WorkflowPrReviewReport | null;
  readonly reportFile: string;
  readonly stdoutFile: string;
  readonly stderrFile: string;
  readonly reportExists: boolean;
  readonly stdoutExists: boolean;
  readonly stderrExists: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
};

type ArtifactSnapshot = {
  readonly report: WorkflowPrReviewReport | null;
  readonly reportExists: boolean;
  readonly stdoutExists: boolean;
  readonly stderrExists: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
};

type PrepareRepositoryResult = {
  readonly clonePerformed: boolean;
  readonly headSha: string;
};

type CodexExecutionResult = {
  readonly exitCode: number;
};
const REPORT_PATH = "repo/.codex/pr-verification.report.json";
const STDOUT_PATH = "repo/.codex/codex.stdout.ndjson";
const STDERR_PATH = "repo/.codex/codex.stderr.log";
const SCHEMA_PATH = "repo/.codex/report.schema.json";
const CODEX_RUN_TIMEOUT_MS = 10 * 60 * 1000;

function toStrictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toStrictJsonSchema(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const record = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, toStrictJsonSchema(child)]),
  ) as Record<string, unknown>;

  const anyOf = Array.isArray(record.anyOf) ? record.anyOf : null;
  if (anyOf && anyOf.length === 2) {
    const typeEntries = anyOf
      .map((entry) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const nested = entry as Record<string, unknown>;
          return typeof nested.type === "string" ? nested.type : null;
        }
        return null;
      })
      .filter((entry): entry is string => entry !== null);

    if (typeEntries.length === 2 && typeEntries.includes("null")) {
      const nonNullSchema = anyOf.find((entry) => {
        return (
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).type !== "null"
        );
      });

      if (nonNullSchema && typeof nonNullSchema === "object" && !Array.isArray(nonNullSchema)) {
        const normalized = {
          ...(nonNullSchema as Record<string, unknown>),
          type: typeEntries,
        };
        return normalized;
      }
    }
  }

  return record;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = error.errors
      .map((child, index) => `#${index + 1} ${formatUnknownError(child)}`)
      .join("\n");
    return details ? `${error.message}\n${details}` : error.message;
  }

  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }

  return String(error);
}

function createReviewSchemaJson(): string {
  const jsonSchema = toStrictJsonSchema(z.toJSONSchema(workflowPrReviewReportSchema)) as Record<
    string,
    unknown
  >;
  delete jsonSchema.$schema;
  return JSON.stringify(jsonSchema);
}

const REVIEW_SCHEMA = createReviewSchemaJson();

async function writeStepEvent(
  index: number,
  step:
    | "ensure_workspace"
    | "clone_repository"
    | "fetch_pull_request"
    | "checkout_pull_request"
    | "run_codex_exec"
    | "collect_report",
  status: "started" | "completed",
  detail?: string,
): Promise<void> {
  "use step";

  const writable = getWritable<string>();
  const writer = writable.getWriter();
  await writer.write(
    `${JSON.stringify(
      createWorkflowPrReviewRunEvent(index, {
        type: "step",
        step,
        status,
        detail,
      }),
    )}\n`,
  );
  writer.releaseLock();
}

async function writeResultEvent(
  index: number,
  finalOutput: WorkflowPrReviewFinalOutput,
): Promise<void> {
  "use step";

  const writable = getWritable<string>();
  const writer = writable.getWriter();
  await writer.write(
    `${JSON.stringify(
      createWorkflowPrReviewRunEvent(index, {
        type: "result",
        finalOutput,
      }),
    )}\n`,
  );
  writer.releaseLock();
}

async function closeEventWriter(): Promise<void> {
  "use step";
  await getWritable<string>().close();
}

function parsePullRequestUrl(raw: string): ParsedPullRequest {
  const trimmed = raw.trim();
  const parsed = new URL(trimmed);
  const parts = parsed.pathname.split("/").filter(Boolean);

  if (parsed.hostname !== "github.com" || parts.length < 4) {
    throw new Error("Invalid GitHub pull request URL.");
  }

  const [owner, repo, route, numberText] = parts;
  if (route !== "pull") {
    throw new Error("URL is not a GitHub pull request URL.");
  }

  const number = Number(numberText);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("Invalid pull request number.");
  }

  parsed.hash = "";
  parsed.search = "";

  return {
    url: parsed.toString(),
    owner,
    repo,
    number,
    repoSlug: `${owner}/${repo}`,
  };
}

function workspaceIdForPullRequest(pr: ParsedPullRequest): string {
  return `workflow-hello-git-${pr.owner}_${pr.repo}_pr_${pr.number}`;
}

function isWorkspaceMissing(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Workspace not found:");
}

function requireVerificationEnv(): void {
  if (!process.env.CODEX_API_KEY?.trim()) {
    throw new Error("CODEX_API_KEY is required for workflow-hello-git.");
  }
}

async function resolveWorkspace(pr: ParsedPullRequest) {
  try {
    return await sandkit.getWorkspace(workspaceIdForPullRequest(pr));
  } catch (error) {
    if (!isWorkspaceMissing(error)) {
      throw error;
    }

    return sandkit.createWorkspace({
      id: workspaceIdForPullRequest(pr),
      name: `${pr.repoSlug}#${pr.number}`,
      policy: allowServices([github(), codex()]),
    });
  }
}

async function createWorkspace(pr: ParsedPullRequest): Promise<{ workspaceId: string }> {
  "use step";

  requireVerificationEnv();
  await writeStepEvent(0, "ensure_workspace", "started", "Resolving durable workspace...");
  const workspace = await resolveWorkspace(pr);
  await writeStepEvent(1, "ensure_workspace", "completed", `Workspace ${workspace.id} ready.`);
  return {
    workspaceId: workspace.id,
  };
}

async function preparePullRequest(pr: ParsedPullRequest): Promise<PrepareRepositoryResult> {
  "use step";

  const workspace = await resolveWorkspace(pr);
  const repoUrl = `https://github.com/${pr.owner}/${pr.repo}.git`;
  const remoteRef = `refs/remotes/origin/codex-pr-${pr.number}`;
  const branchName = `codex-pr-${pr.number}`;

  await writeStepEvent(2, "clone_repository", "started", "Cloning repository if needed...");
  const remove = await workspace.sandbox.runCommand("rm", ["-rf", "repo"]);
  if (remove.exitCode !== 0) {
    throw new Error(`Failed to remove existing checkout: ${remove.stderr || remove.stdout}`);
  }

  const clone = await workspace.sandbox.runCommand({
    command: "git",
    args: ["clone", repoUrl, "repo"],
    policy: allowService(github()),
  });
  if (clone.exitCode !== 0) {
    throw new Error(`Failed to clone repository: ${clone.stderr || clone.stdout}`);
  }
  await writeStepEvent(3, "clone_repository", "completed", `Cloned ${pr.repoSlug}.`);

  await writeStepEvent(
    4,
    "fetch_pull_request",
    "started",
    `Fetching PR #${pr.number} from origin...`,
  );
  const fetch = await workspace.sandbox.runCommand({
    command: "git",
    args: ["-C", "repo", "fetch", "--force", "origin", `pull/${pr.number}/head:${remoteRef}`],
    policy: allowService(github()),
  });
  if (fetch.exitCode !== 0) {
    throw new Error(`Failed to fetch pull request: ${fetch.stderr || fetch.stdout}`);
  }
  await writeStepEvent(5, "fetch_pull_request", "completed", `Fetched PR #${pr.number}.`);

  await writeStepEvent(6, "checkout_pull_request", "started", `Checking out ${branchName}...`);
  const checkout = await workspace.sandbox.runCommand("git", [
    "-C",
    "repo",
    "checkout",
    "--force",
    "-B",
    branchName,
    remoteRef,
  ]);
  if (checkout.exitCode !== 0) {
    throw new Error(`Failed to checkout pull request: ${checkout.stderr || checkout.stdout}`);
  }

  const clean = await workspace.sandbox.runCommand("git", ["-C", "repo", "clean", "-fd"]);
  if (clean.exitCode !== 0) {
    throw new Error(`Failed to clean checkout: ${clean.stderr || clean.stdout}`);
  }

  const head = await workspace.sandbox.runCommand("git", ["-C", "repo", "rev-parse", "HEAD"]);
  if (head.exitCode !== 0) {
    throw new Error(`Failed to read checkout revision: ${head.stderr || head.stdout}`);
  }
  const headSha = head.stdout.trim();
  await writeStepEvent(
    7,
    "checkout_pull_request",
    "completed",
    `Checked out ${branchName} at ${headSha.slice(0, 12)}.`,
  );
  return { clonePerformed: true, headSha };
}

function buildPrompt(pr: ParsedPullRequest): string {
  return [
    `You are verifying GitHub pull request ${pr.url} inside an isolated sandbox.`,
    "",
    "Goal:",
    "- Find and run reasonable CI-like commands for this repository.",
    "- Install dependencies when needed.",
    "- Attempt formatter, linter, type-check, and test checks where they exist.",
    "- You are running with codex exec --yolo, so the outer sandbox is the real execution boundary.",
    "- Return a strict JSON object matching this schema:",
    "  - summary: string",
    "  - checks: array of objects with label, command, outcome, and note (use null when there is no note)",
    "  - notes: array of caveats, or null when there are none",
    "  - files: array of interesting file paths with description, or null when there are none",
    "",
    "Rules:",
    "- Do not ask for confirmation and do not request more input from the user.",
    "- Each check must include the actual shell command you decided to run or attempted to run.",
    "- If a command cannot be run, record a failed or not_run check with a short note.",
    "- Do work directly in this checkout and keep a brief, truthful summary.",
    "",
    "The repository checkout is the current working tree.",
  ].join("\n");
}

async function runCodexExec(pr: ParsedPullRequest): Promise<CodexExecutionResult> {
  "use step";

  const workspace = await resolveWorkspace(pr);
  await writeStepEvent(8, "run_codex_exec", "started", "Running codex exec --yolo...");

  const schemaEncoded = Buffer.from(REVIEW_SCHEMA).toString("base64");

  const prepareFiles = await workspace.sandbox.runCommand("bash", [
    "-lc",
    [
      "set -euo pipefail",
      "mkdir -p repo/.codex",
      `printf '%s' '${schemaEncoded}' | base64 -d > '${SCHEMA_PATH}'`,
    ].join("\n"),
  ]);
  if (prepareFiles.exitCode !== 0) {
    throw new Error(
      `Failed to prepare codex inputs: ${prepareFiles.stderr || prepareFiles.stdout}`,
    );
  }

  const prompt = buildPrompt(pr);
  let result: CodexExecutionResult & { stdout: string; stderr: string };
  try {
    const command = await workspace.sandbox.runCommand({
      command: "codex",
      args: [
        "exec",
        "--yolo",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--json",
        "--output-schema",
        SCHEMA_PATH,
        "--output-last-message",
        REPORT_PATH,
        "-C",
        "repo",
        prompt,
      ],
      policy: allowService(codex()),
      timeoutMs: CODEX_RUN_TIMEOUT_MS,
      detached: true,
    });
    const commandResult = await command.wait();
    result = {
      exitCode: commandResult.exitCode,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
    };
  } catch (error) {
    throw new FatalError(`codex exec failed:\n${formatUnknownError(error)}`);
  }

  const storeLogs = await workspace.sandbox.runCommand("bash", [
    "-lc",
    [
      "set -euo pipefail",
      `cat > '${STDOUT_PATH}' <<'__CODEX_STDOUT__'`,
      result.stdout,
      "__CODEX_STDOUT__",
      `cat > '${STDERR_PATH}' <<'__CODEX_STDERR__'`,
      result.stderr,
      "__CODEX_STDERR__",
    ].join("\n"),
  ]);
  if (storeLogs.exitCode !== 0) {
    throw new Error(`Failed to store codex logs: ${storeLogs.stderr || storeLogs.stdout}`);
  }

  const parsed = { exitCode: result.exitCode } satisfies CodexExecutionResult;
  await writeStepEvent(
    9,
    "run_codex_exec",
    "completed",
    parsed.exitCode === 0
      ? "Codex execution finished successfully."
      : `Codex execution finished with exit code ${parsed.exitCode}.`,
  );
  return parsed;
}

runCodexExec.maxRetries = 0;

function parseReport(raw: string): WorkflowPrReviewReport | null {
  if (!raw.trim()) {
    return null;
  }

  try {
    return workflowPrReviewReportSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

type RawArtifactSnapshot = {
  reportBase64: string;
  reportExists: boolean;
  stdoutExists: boolean;
  stderrExists: boolean;
  stdoutTailBase64: string;
  stderrTailBase64: string;
};

async function collectReport(pr: ParsedPullRequest): Promise<ArtifactSnapshot> {
  "use step";

  const workspace = await resolveWorkspace(pr);
  await writeStepEvent(
    10,
    "collect_report",
    "started",
    "Reading report file and verifying log files...",
  );
  const result = await workspace.sandbox.runCommand("bash", [
    "-lc",
    [
      "set -euo pipefail",
      `report_exists=false; [ -f '${REPORT_PATH}' ] && report_exists=true`,
      `stdout_exists=false; [ -f '${STDOUT_PATH}' ] && stdout_exists=true`,
      `stderr_exists=false; [ -f '${STDERR_PATH}' ] && stderr_exists=true`,
      `report_base64=$(cat '${REPORT_PATH}' 2>/dev/null | base64 | tr -d '\\n')`,
      `stdout_tail_base64=$(tail -n 40 '${STDOUT_PATH}' 2>/dev/null | base64 | tr -d '\\n')`,
      `stderr_tail_base64=$(tail -n 40 '${STDERR_PATH}' 2>/dev/null | base64 | tr -d '\\n')`,
      'printf \'{"reportBase64":"%s","reportExists":%s,"stdoutExists":%s,"stderrExists":%s,"stdoutTailBase64":"%s","stderrTailBase64":"%s"}\n\' "$report_base64" "$report_exists" "$stdout_exists" "$stderr_exists" "$stdout_tail_base64" "$stderr_tail_base64"',
    ].join("\n"),
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to read workflow artifacts: ${result.stderr || result.stdout}`);
  }

  const rawSnapshot = JSON.parse(result.stdout.trim()) as RawArtifactSnapshot;
  const reportRaw = rawSnapshot.reportBase64
    ? Buffer.from(rawSnapshot.reportBase64, "base64").toString("utf8")
    : "";
  const snapshot = {
    report: parseReport(reportRaw),
    reportExists: rawSnapshot.reportExists,
    stdoutExists: rawSnapshot.stdoutExists,
    stderrExists: rawSnapshot.stderrExists,
    stdoutTail: rawSnapshot.stdoutTailBase64
      ? Buffer.from(rawSnapshot.stdoutTailBase64, "base64").toString("utf8")
      : "",
    stderrTail: rawSnapshot.stderrTailBase64
      ? Buffer.from(rawSnapshot.stderrTailBase64, "base64").toString("utf8")
      : "",
  };
  await writeStepEvent(
    11,
    "collect_report",
    "completed",
    snapshot.reportExists
      ? "Report file loaded and log files checked."
      : "No structured report was produced; log files were still checked.",
  );
  return snapshot;
}

export function parseWorkflowPrReviewInput(
  input: WorkflowPrReviewInput | unknown,
): ParsedWorkflowPrReviewInput | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const candidate = input as WorkflowPrReviewInput;
  if (typeof candidate.prUrl !== "string") {
    return null;
  }

  if (candidate.requestedAt !== undefined && typeof candidate.requestedAt !== "string") {
    return null;
  }

  try {
    return {
      pr: parsePullRequestUrl(candidate.prUrl),
      requestedAt: candidate.requestedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function runPrReviewWorkflow(
  input: ParsedWorkflowPrReviewInput,
): Promise<WorkflowPrReviewFinalOutput> {
  "use workflow";

  const workspace = await createWorkspace(input.pr);
  const repository = await preparePullRequest(input.pr);
  const codexExecution = await runCodexExec(input.pr);
  const artifacts = await collectReport(input.pr);

  const finalOutput: WorkflowPrReviewFinalOutput = {
    kind: "prReview",
    workspaceId: workspace.workspaceId,
    prUrl: input.pr.url,
    repo: input.pr.repoSlug,
    pullNumber: input.pr.number,
    headSha: repository.headSha,
    requestedAt: input.requestedAt,
    clonePerformed: repository.clonePerformed,
    codexExitCode: codexExecution.exitCode,
    reportFile: REPORT_PATH,
    stdoutFile: STDOUT_PATH,
    stderrFile: STDERR_PATH,
    reportExists: artifacts.reportExists,
    stdoutExists: artifacts.stdoutExists,
    stderrExists: artifacts.stderrExists,
    stdoutTail: artifacts.stdoutTail,
    stderrTail: artifacts.stderrTail,
    report: artifacts.report,
  };

  await writeResultEvent(12, finalOutput);
  await closeEventWriter();
  return finalOutput;
}
