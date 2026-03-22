import { NextRequest, NextResponse } from "next/server";

import { getRunOrNull } from "@/lib/openclaw-workflow-runs";

type RouteParams = {
  params: Promise<{
    runId: string;
  }>;
};

type RunOutput = {
  openclawSessionId?: string;
  sandboxId?: string;
  openclawUrl?: string;
};

type RunStatusResponse = {
  runId: string;
  status: "pending" | "running" | "completed" | "succeeded" | "failed" | "cancelled" | "unknown";
  startedAt?: string;
  finishedAt?: string;
  finalOutput?: RunOutput;
  error?: {
    code: string;
    message: string;
  };
};

function errorFromRunFailure(error: unknown): { code: string; message: string } {
  return {
    code: "run_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function toIsoDate(value: Date | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse<RunStatusResponse | { error: string }>> {
  const { runId } = await params;
  let run;
  try {
    run = await getRunOrNull(runId);
  } catch (error) {
    return NextResponse.json(
      { error: `Run lookup failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }

  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  const [status, startedAt, completedAt] = await Promise.all([
    run.status,
    run.startedAt,
    run.completedAt,
  ]);

  const response: RunStatusResponse = {
    runId,
    status: mapRunStatus(status),
    startedAt: toIsoDate(startedAt),
  };

  if (completedAt) {
    response.finishedAt = completedAt.toISOString();
  }

  const mappedStatus = mapRunStatus(status);
  if (mappedStatus === "completed" || mappedStatus === "succeeded") {
    try {
      const output = await run.returnValue;
      response.finalOutput = output as RunOutput;
      if (completedAt) {
        response.finishedAt = completedAt.toISOString();
      }
    } catch (error) {
      response.status = "failed";
      response.error = errorFromRunFailure(error);
    }
  }

  if (mappedStatus === "failed") {
    try {
      await run.returnValue;
    } catch (error) {
      response.error = errorFromRunFailure(error);
    }
  }

  return NextResponse.json(response);
}

function mapRunStatus(status: string | undefined): RunStatusResponse["status"] {
  if (
    status === "pending" ||
    status === "running" ||
    status === "completed" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }

  return "unknown";
}
