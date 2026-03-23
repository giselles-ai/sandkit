import { NextRequest, NextResponse } from "next/server";

import {
  getReviewDetails,
  resumeReview,
  type MergeReadinessReviewDetails,
} from "@/lib/merge-readiness-service";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{
    reviewId: string;
  }>;
};

type ErrorResponse = {
  error: string;
};

function parseResumeAction(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const action = (raw as Record<string, unknown>).action;
  return action === "resume";
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse<MergeReadinessReviewDetails | ErrorResponse>> {
  const { reviewId } = await params;
  try {
    const details = await getReviewDetails(reviewId);
    return NextResponse.json(details);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Review not found." },
      { status: 404 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse<MergeReadinessReviewDetails | ErrorResponse>> {
  const { reviewId } = await params;
  let shouldResume = false;
  try {
    const raw = (await req.json()) as unknown;
    shouldResume = parseResumeAction(raw);
  } catch {
    shouldResume = false;
  }

  if (!shouldResume) {
    return NextResponse.json({ error: "Invalid action." }, { status: 400 });
  }

  try {
    const review = await resumeReview(reviewId);
    const details = await getReviewDetails(review.id);
    return NextResponse.json(details);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Action failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
