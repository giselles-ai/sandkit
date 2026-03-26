import { NextRequest, NextResponse } from "next/server";

import { getRunOrNull } from "@/lib/workflow-runs";
import type { WorkflowPrReviewFinalOutput } from "@/workflows/hello-git";

type RouteParams = {
  params: Promise<{
    runId: string;
  }>;
};

type RunStatusResponse = {
  runId: string;
  status: "pending" | "running" | "completed" | "succeeded" | "failed" | "cancelled" | "unknown";
  startedAt?: string;
  finishedAt?: string;
  finalOutput?: WorkflowPrReviewFinalOutput;
  error?: {
    code: string;
    message: string;
  };
};

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
    finishedAt: toIsoDate(completedAt),
  };

  const mappedStatus = mapRunStatus(status);
  if (mappedStatus === "completed" || mappedStatus === "succeeded") {
    try {
      response.finalOutput = (await run.returnValue) as WorkflowPrReviewFinalOutput;
      response.finishedAt = toIsoDate(completedAt);
    } catch (error) {
      response.status = "failed";
      response.error = {
        code: "workflow_failed",
        message: error instanceof Error ? error.message : String(error),
      };
      response.finishedAt = toIsoDate(completedAt);
    }
  }

  if (mappedStatus === "failed") {
    try {
      await run.returnValue;
    } catch (error) {
      response.error = {
        code: "workflow_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return NextResponse.json(response);
}
