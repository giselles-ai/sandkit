import { NextRequest, NextResponse } from "next/server";

import {
  getSessionState,
  interruptSession,
  resumeSession,
  type MergeReadinessSessionState,
} from "@/lib/merge-readiness-service";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{
    sessionId: string;
  }>;
};

type ErrorResponse = {
  error: string;
};

function parseSessionAction(raw: unknown): "interrupt" | "resume" | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const action = (raw as Record<string, unknown>).action;
  return action === "interrupt" || action === "resume" ? action : null;
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse<MergeReadinessSessionState | ErrorResponse>> {
  const { sessionId } = await params;
  try {
    const session = await getSessionState(sessionId);
    return NextResponse.json(session);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Session not found." },
      { status: 404 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse<MergeReadinessSessionState | ErrorResponse>> {
  const { sessionId } = await params;
  let action: "interrupt" | "resume" | null = null;
  try {
    action = parseSessionAction(await req.json());
  } catch {
    action = null;
  }

  if (!action) {
    return NextResponse.json({ error: "Invalid action." }, { status: 400 });
  }

  try {
    if (action === "interrupt") {
      return NextResponse.json(await interruptSession(sessionId));
    }

    return NextResponse.json(await resumeSession(sessionId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Action failed." },
      { status: 500 },
    );
  }
}
