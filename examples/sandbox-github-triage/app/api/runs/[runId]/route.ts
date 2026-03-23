import { NextResponse } from "next/server";

import { getTriageRun } from "@/lib/triage-service";
import type { TriageRunDetail } from "@/lib/triage-service";

type RouteParams = {
  params: Promise<{
    runId: string;
  }>;
};

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: RouteParams): Promise<NextResponse<TriageRunDetail | { error: string }>> {
  const { runId } = await params;

  try {
    const run = await getTriageRun(runId);
    if (!run) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }

    return NextResponse.json(run);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch run." },
      { status: 500 },
    );
  }
}
