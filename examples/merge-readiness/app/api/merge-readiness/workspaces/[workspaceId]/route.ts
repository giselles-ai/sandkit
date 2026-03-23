import { NextRequest, NextResponse } from "next/server";

import {
  getWorkspaceDetail,
  type MergeReadinessWorkspaceDetails,
  requestReview,
} from "@/lib/merge-readiness-service";
import { type MergeReadinessSessionRecord as ServiceMergeReadinessSessionRecord } from "@/lib/merge-readiness-store";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{
    workspaceId: string;
  }>;
};

type WorkspaceResponse = MergeReadinessWorkspaceDetails & {
  sessions: ServiceMergeReadinessSessionRecord[];
};

type ErrorResponse = {
  error: string;
};

type RunResponse = {
  reviewId: string;
  started: boolean;
};

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse<WorkspaceResponse | ErrorResponse>> {
  const { workspaceId } = await params;
  try {
    const workspace = await getWorkspaceDetail(workspaceId);
    return NextResponse.json(workspace);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Workspace not found." },
      { status: 404 },
    );
  }
}

function parseWorkspaceRunPayload(raw: unknown): { prUrl: string } | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const prUrl =
    typeof (raw as Record<string, unknown>).prUrl === "string"
      ? String((raw as Record<string, unknown>).prUrl).trim()
      : "";

  return prUrl ? { prUrl } : null;
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse<RunResponse | ErrorResponse>> {
  const { workspaceId } = await params;
  let prUrl: string | null = null;
  try {
    const payload = parseWorkspaceRunPayload(await req.json());
    if (payload) {
      prUrl = payload.prUrl;
    }
  } catch {
    prUrl = null;
  }

  if (!prUrl) {
    return NextResponse.json({ error: "Invalid run request." }, { status: 400 });
  }

  try {
    const result = await requestReview(prUrl);
    if (result.workspaceId !== workspaceId) {
      return NextResponse.json({ error: "Workspace ID mismatch for PR URL." }, { status: 409 });
    }

    return NextResponse.json({ reviewId: result.review.id, started: result.started });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start investigation." },
      { status: 500 },
    );
  }
}
