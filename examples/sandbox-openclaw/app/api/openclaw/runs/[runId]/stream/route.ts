import { NextRequest } from "next/server";

import { getRunOrNull } from "@/lib/openclaw-workflow-runs";

type RouteParams = {
  params: Promise<{
    runId: string;
  }>;
};

function parseStartIndex(value: string | null): number {
  if (value === null) {
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const { runId } = await params;
  let run;
  try {
    run = await getRunOrNull(runId);
  } catch (error) {
    return new Response(
      `Run lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        status: 500,
      },
    );
  }

  if (!run) {
    return new Response("Run not found.", { status: 404 });
  }

  const startIndex = parseStartIndex(req.nextUrl.searchParams.get("startIndex"));
  let readable: ReturnType<typeof run.getReadable>;
  try {
    readable = run.getReadable({
      startIndex,
    });
  } catch (error) {
    return new Response(
      `Run stream unavailable: ${error instanceof Error ? error.message : String(error)}`,
      {
        status: 500,
      },
    );
  }

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
