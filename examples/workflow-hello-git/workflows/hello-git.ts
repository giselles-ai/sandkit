import { allowServices, github } from "@giselles-ai/sandkit";
import { getWritable } from "workflow";

import { getSandkit } from "@/lib/sandkit";
import { createWorkflowHelloGitRunEvent } from "@/lib/workflow-hello-git-events";

const githubRepoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type WorkflowHelloGitInput = {
  readonly repo: string;
  readonly requestedAt?: string;
};

export type WorkflowHelloGitFinalOutput = {
  readonly kind: "helloGit";
  readonly workspaceId: string;
  readonly repo: string;
  readonly clonePerformed: boolean;
  readonly status: string;
  readonly files: string;
  readonly requestedAt: string;
};

async function writeStepEvent(
  index: number,
  step: "ensure_workspace" | "clone_repository" | "read_repository_status",
  status: "started" | "completed",
  detail?: string,
): Promise<void> {
  "use step";

  const writable = getWritable<string>();
  const writer = writable.getWriter();
  await writer.write(
    `${JSON.stringify(
      createWorkflowHelloGitRunEvent(index, {
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
  finalOutput: WorkflowHelloGitFinalOutput,
): Promise<void> {
  "use step";

  const writable = getWritable<string>();
  const writer = writable.getWriter();
  await writer.write(
    `${JSON.stringify(
      createWorkflowHelloGitRunEvent(index, {
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

function normalizeRepo(rawRepo: string): string {
  const repo = rawRepo.trim();
  if (!githubRepoPattern.test(repo)) {
    throw new Error("Invalid repo format. Use org/name.");
  }
  return repo;
}

function workspaceIdForRepo(repo: string): string {
  return `workflow-hello-git-${repo.replace("/", "_")}`;
}

function isWorkspaceMissing(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Workspace not found:");
}

function requireGithubToken(): void {
  if (!process.env.GITHUB_TOKEN?.trim()) {
    throw new Error("GITHUB_TOKEN is required for workflow-hello-git.");
  }
}

async function resolveWorkspace(repo: string) {
  const sandkit = await getSandkit();

  try {
    return await sandkit.getWorkspace(workspaceIdForRepo(repo));
  } catch (error) {
    if (!isWorkspaceMissing(error)) {
      throw error;
    }

    return sandkit.createWorkspace({
      id: workspaceIdForRepo(repo),
      name: repo,
      policy: allowServices([github()]),
    });
  }
}

async function createWorkspace(repo: string): Promise<{ workspaceId: string }> {
  "use step";

  requireGithubToken();
  await writeStepEvent(0, "ensure_workspace", "started", "Resolving durable workspace...");
  const workspace = await resolveWorkspace(repo);
  await writeStepEvent(1, "ensure_workspace", "completed", `Workspace ${workspace.id} ready.`);
  return {
    workspaceId: workspace.id,
  };
}

async function getRepository(repo: string): Promise<{ clonePerformed: boolean }> {
  "use step";

  requireGithubToken();
  await writeStepEvent(2, "clone_repository", "started", "Cloning repository if needed...");
  const workspace = await resolveWorkspace(repo);
  const existing = await workspace.sandbox.runCommand("test", ["-d", "repo"]);
  if (existing.exitCode === 0) {
    await writeStepEvent(3, "clone_repository", "completed", "Existing checkout reused.");
    return {
      clonePerformed: false,
    };
  }

  const clone = await workspace.sandbox.runCommand({
    command: "git",
    args: ["clone", `https://github.com/${repo}`, "repo"],
    policy: allowServices([github()]),
  });
  if (clone.exitCode !== 0) {
    throw new Error(`Failed to clone https://github.com/${repo}: ${clone.stderr}`);
  }
  await writeStepEvent(3, "clone_repository", "completed", "Repository cloned into workspace.");
  return {
    clonePerformed: true,
  };
}

async function readRepositoryStatus(repo: string): Promise<{ status: string; files: string }> {
  "use step";
  requireGithubToken();
  await writeStepEvent(
    4,
    "read_repository_status",
    "started",
    "Reading git status and repository contents...",
  );
  const workspace = await resolveWorkspace(repo);
  const status = await workspace.sandbox.runCommand("git", [
    "-C",
    "repo",
    "status",
    "--short",
    "--branch",
  ]);
  if (status.exitCode !== 0) {
    throw new Error(`Failed to read git status: ${status.stderr}`);
  }

  const list = await workspace.sandbox.runCommand("ls", ["repo"]);
  if (list.exitCode !== 0) {
    throw new Error(`Failed to list repository files: ${list.stderr}`);
  }

  const details = {
    status: status.stdout || "",
    files: list.stdout || "",
  };
  await writeStepEvent(5, "read_repository_status", "completed", "Repository inspection complete.");
  return details;
}

function normalizeInput(input: WorkflowHelloGitInput): WorkflowHelloGitInput {
  return {
    repo: normalizeRepo(input.repo),
    requestedAt: input.requestedAt ?? new Date().toISOString(),
  };
}

export async function runHelloGitWorkflow(
  input: WorkflowHelloGitInput,
): Promise<WorkflowHelloGitFinalOutput> {
  "use workflow";

  const normalized = normalizeInput(input);
  const repo = normalized.repo;
  const requestedAt = normalized.requestedAt!;
  const workspace = await createWorkspace(repo);
  const repository = await getRepository(repo);
  const details = await readRepositoryStatus(repo);

  const finalOutput: WorkflowHelloGitFinalOutput = {
    kind: "helloGit",
    workspaceId: workspace.workspaceId,
    repo,
    clonePerformed: repository.clonePerformed,
    status: details.status,
    files: details.files,
    requestedAt,
  };

  await writeResultEvent(6, finalOutput);
  await closeEventWriter();
  return finalOutput;
}
