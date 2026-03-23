import { NextRequest, NextResponse } from "next/server";

import {
  listTopReviews,
  requestReview,
  resumeReview,
  type TopReviewSummary,
} from "@/lib/merge-readiness-service";

export const dynamic = "force-dynamic";

type ReviewListResponse = {
  reviews: TopReviewSummary[];
};

type TopRequestPayload = {
  action: "request";
  prUrl: string;
};

type TopResumePayload = {
  action: "resume";
  reviewId: string;
};

type TopActionPayload = TopRequestPayload | TopResumePayload;

type TopActionResponse = {
  review: TopReviewSummary;
  workspaceId?: string;
  started?: boolean;
};

type ErrorResponse = {
  error: string;
};

function parseTopPayload(raw: unknown): TopActionPayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const action = candidate.action;
  if (action === "request") {
    const prUrl = typeof candidate.prUrl === "string" ? candidate.prUrl.trim() : "";
    return prUrl ? { action: "request", prUrl } : null;
  }

  if (action === "resume") {
    const reviewId = typeof candidate.reviewId === "string" ? candidate.reviewId.trim() : "";
    return reviewId ? { action: "resume", reviewId } : null;
  }

  return null;
}

export async function GET() {
  const reviews = await listTopReviews(50);
  return NextResponse.json({ reviews } satisfies ReviewListResponse);
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<TopActionResponse | ErrorResponse>> {
  let payload: TopActionPayload;
  try {
    const raw = (await req.json()) as unknown;
    const parsed = parseTopPayload(raw);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
    }

    payload = parsed;
  } catch {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }

  try {
    if (payload.action === "request") {
      const next = await requestReview(payload.prUrl);
      return NextResponse.json(next);
    }

    const review = await resumeReview(payload.reviewId);
    return NextResponse.json({ review });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Action failed." },
      { status: 500 },
    );
  }
}
