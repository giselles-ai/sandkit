import { allowService, allowServices, codex, github } from "@giselles-ai/sandkit";
import { FatalError } from "workflow";

import { sandkit } from "@/lib/sandkit";
import {
  collectWorkflowPrReviewArtifacts,
  type WorkflowPrReviewArtifactSnapshot,
} from "@/lib/workflow-hello-git-artifacts";
import {
  closeEventWriter,
  writeResultEvent,
  writeStepEvent,
} from "@/lib/workflow-hello-git-events";
import {
  SCHEMA_PATH,
  STDERR_PATH,
  STDOUT_PATH,
  REPORT_PATH,
  buildWorkflowPrReviewPrompt,
  buildWorkflowPrReviewSchemaJson,
  type WorkflowPrReviewArtifact,
  type WorkflowPrReviewCheck,
  type WorkflowPrReviewReport,
} from "@/lib/workflow-hello-git-report";

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

export type { WorkflowPrReviewArtifact, WorkflowPrReviewCheck, WorkflowPrReviewReport };

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

type PrepareRepositoryResult = {
  readonly clonePerformed: boolean;
  readonly headSha: string;
};

type CodexExecutionResult = {
  readonly exitCode: number;
};
const CODEX_RUN_TIMEOUT_MS = 10 * 60 * 1000;
type CodexRunCommandOptions = Parameters<
  Awaited<ReturnType<typeof sandkit.getWorkspace>>["sandbox"]["runCommand"]
>[0] & {
  readonly timeoutMs?: number;
  readonly provider?: {
    readonly vercel?: {
      readonly runViaDetachedWait?: boolean;
    };
  };
};

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

const REVIEW_SCHEMA = buildWorkflowPrReviewSchemaJson();

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
  const clonePerformed = await ensureCheckoutFromExpectedRemote(workspace, repoUrl);
  await writeStepEvent(
    3,
    "clone_repository",
    "completed",
    clonePerformed
      ? `Cloned ${pr.repoSlug} and prepared repository checkout.`
      : `Reusing existing checkout for ${pr.repoSlug}.`,
  );

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
  return { clonePerformed, headSha };
}

async function ensureCheckoutFromExpectedRemote(
  workspace: Awaited<ReturnType<typeof sandkit.getWorkspace>>,
  repoUrl: string,
): Promise<boolean> {
  const isRepo = await workspace.sandbox.runCommand("git", [
    "-C",
    "repo",
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (isRepo.exitCode !== 0) {
    await removeCheckoutIfPresent(workspace);
    await cloneRepository(workspace, repoUrl);
    return true;
  }

  const remote = await workspace.sandbox.runCommand("git", [
    "-C",
    "repo",
    "config",
    "--get",
    "remote.origin.url",
  ]);
  if (remote.exitCode !== 0 || remote.stdout.trim() !== repoUrl) {
    await removeCheckoutIfPresent(workspace);
    await cloneRepository(workspace, repoUrl);
    return true;
  }

  return false;
}

async function removeCheckoutIfPresent(
  workspace: Awaited<ReturnType<typeof sandkit.getWorkspace>>,
): Promise<void> {
  const pathState = await workspace.sandbox.runCommand("bash", ["-lc", "[ -e repo ]"]);
  if (pathState.exitCode !== 0 && pathState.exitCode !== 1) {
    throw new Error(
      `Failed to inspect existing checkout path: ${pathState.stderr || pathState.stdout}`,
    );
  }

  if (pathState.exitCode === 1) {
    return;
  }

  const remove = await workspace.sandbox.runCommand("rm", ["-rf", "repo"]);
  if (remove.exitCode !== 0) {
    throw new Error(`Failed to remove unexpected checkout: ${remove.stderr || remove.stdout}`);
  }
}

async function cloneRepository(
  workspace: Awaited<ReturnType<typeof sandkit.getWorkspace>>,
  repoUrl: string,
): Promise<void> {
  const clone = await workspace.sandbox.runCommand({
    command: "git",
    args: ["clone", repoUrl, "repo"],
    policy: allowService(github()),
  });
  if (clone.exitCode !== 0) {
    throw new Error(`Failed to clone repository: ${clone.stderr || clone.stdout}`);
  }
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

  const prompt = buildWorkflowPrReviewPrompt(pr);
  let result: CodexExecutionResult & { stdout: string; stderr: string };
  try {
    const commandResult = await workspace.sandbox.runCommand({
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
      provider: {
        vercel: {
          runViaDetachedWait: true,
        },
      },
    } as CodexRunCommandOptions);
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

async function collectReport(pr: ParsedPullRequest): Promise<WorkflowPrReviewArtifactSnapshot> {
  "use step";

  const workspace = await resolveWorkspace(pr);
  await writeStepEvent(
    10,
    "collect_report",
    "started",
    "Reading report file and verifying log files...",
  );
  const snapshot = await collectWorkflowPrReviewArtifacts(workspace);
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
