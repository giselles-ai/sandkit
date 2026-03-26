import { allowService, codex } from "@giselles-ai/sandkit";
import { NextResponse } from "next/server";

import { sandkit } from "@/lib/sandkit";

type ConnectCodexResponse = {
  workspaceId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  lastMessage: string;
};

type ErrorResponse = {
  error: string;
};

const WORKSPACE_ID = "workflow-hello-git-connect-codex";
const OUTPUT_PATH = "/tmp/workflow-hello-git-connect-codex-last-message.txt";
const EXPECTED_MESSAGE = "CONNECT_CODEX_OK";

function isWorkspaceMissing(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Workspace not found:");
}

async function resolveWorkspace() {
  try {
    return await sandkit.getWorkspace(WORKSPACE_ID);
  } catch (error) {
    if (!isWorkspaceMissing(error)) {
      throw error;
    }

    return sandkit.createWorkspace({
      id: WORKSPACE_ID,
      name: "connect-codex",
      policy: allowService(codex()),
    });
  }
}

export async function POST(): Promise<NextResponse<ConnectCodexResponse | ErrorResponse>> {
  try {
    if (!process.env.CODEX_API_KEY?.trim()) {
      return NextResponse.json({ error: "CODEX_API_KEY is required." }, { status: 500 });
    }

    const workspace = await resolveWorkspace();
    const execResult = await workspace.sandbox.runCommand({
      command: "codex",
      args: [
        "exec",
        "--yolo",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--output-last-message",
        OUTPUT_PATH,
        `Reply with exactly ${EXPECTED_MESSAGE}`,
      ],
    });

    const outputResult = await workspace.sandbox.runCommand("cat", [OUTPUT_PATH]);
    if (outputResult.exitCode !== 0) {
      throw new Error(
        `Failed to read codex output file.\nstdout:\n${outputResult.stdout}\nstderr:\n${outputResult.stderr}`,
      );
    }

    return NextResponse.json({
      workspaceId: workspace.id,
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      lastMessage: outputResult.stdout.trim(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect Codex." },
      { status: 500 },
    );
  }
}
