import { NextRequest, NextResponse } from "next/server";
import { start } from "workflow/api";

import { type OpenClawWorkflowStartInput } from "@/lib/openclaw-workflow-steps";
import { startOpenClawSessionWorkflow } from "@/workflows/openclaw-start-session";

type StartPayload = {
  durationMs?: number;
  requestedAt?: string;
};

type StartResponse = {
  runId: string;
};

type ErrorResponse = {
  error: string;
};

function parsePayload(raw: StartPayload): OpenClawWorkflowStartInput | null {
  if (raw.durationMs !== undefined && (!Number.isFinite(raw.durationMs) || raw.durationMs <= 0)) {
    return null;
  }

  return {
    durationMs: raw.durationMs,
    requestedAt: raw.requestedAt ?? new Date().toISOString(),
  };
}

export async function POST(req: NextRequest): Promise<NextResponse<StartResponse | ErrorResponse>> {
  let payload: StartPayload;
  try {
    payload = (await req.json()) as StartPayload;
  } catch {
    return NextResponse.json({ error: "Invalid start request payload." }, { status: 400 });
  }

  const input = parsePayload(payload);
  if (!input) {
    return NextResponse.json({ error: "Invalid start request payload." }, { status: 400 });
  }

  try {
    const run = await start(startOpenClawSessionWorkflow, [input]);
    return NextResponse.json({ runId: run.runId }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "Failed to start OpenClaw workflow." }, { status: 500 });
  }
}
