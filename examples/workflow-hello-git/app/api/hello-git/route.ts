import { NextRequest, NextResponse } from "next/server";
import { start } from "workflow/api";

import { runHelloGitWorkflow, type WorkflowHelloGitInput } from "@/workflows/hello-git";

type StartPayload = {
  repo: string;
};

type StartResponse = {
  runId: string;
};

type ErrorResponse = {
  error: string;
};

function parsePayload(raw: StartPayload | unknown): StartPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const candidate = raw as StartPayload;
  if (typeof candidate.repo !== "string") {
    return null;
  }

  if (!candidate.repo.trim()) {
    return null;
  }

  return {
    repo: candidate.repo.trim(),
  };
}

export async function POST(req: NextRequest): Promise<NextResponse<StartResponse | ErrorResponse>> {
  let input: StartPayload;
  try {
    const payload = (await req.json()) as unknown;
    const parsed = parsePayload(payload);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
    }

    input = parsed;
  } catch {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }

  const runtimeInput: WorkflowHelloGitInput = {
    ...input,
    requestedAt: new Date().toISOString(),
  };

  try {
    const run = await start(runHelloGitWorkflow, [runtimeInput]);
    return NextResponse.json({ runId: run.runId }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "Failed to start hello-git workflow." }, { status: 500 });
  }
}
