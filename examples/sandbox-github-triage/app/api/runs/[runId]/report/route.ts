import { NextResponse } from "next/server";

import { getRunReport } from "@/lib/triage-service";

type RouteParams = {
  params: Promise<{
    runId: string;
  }>;
};

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: RouteParams) {
  const { runId } = await params;
  const report = await getRunReport(runId);
  if (!report) {
    return NextResponse.json({ error: "Report not available." }, { status: 404 });
  }

  return new Response(report, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
