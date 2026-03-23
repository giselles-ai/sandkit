import { NextRequest, NextResponse } from "next/server";

import { createTriageRun, listTriageRuns, listTriageRunsByRepo } from "@/lib/triage-service";
import { type TriageRunSummary } from "@/lib/triage-service";

export const dynamic = "force-dynamic";

type ListRunsResponse = {
  runs: readonly TriageRunSummary[];
};

type CreateRunRequest = {
  trackedRepositoryId: string;
  subjectType: string;
  subjectNumber: number;
  notes?: string | null;
};

export async function GET(req: NextRequest): Promise<NextResponse<ListRunsResponse | { error: string }>> {
  const repositoryId = req.nextUrl.searchParams.get("repositoryId");
  try {
    const runs = repositoryId
      ? await listTriageRunsByRepo(repositoryId)
      : await listTriageRuns();
    return NextResponse.json({ runs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load runs." },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<
  NextResponse<
    | {
        run: TriageRunSummary;
      }
    | { error: string }
  >
> {
  let payload: CreateRunRequest;
  try {
    const parsed = (await req.json()) as CreateRunRequest;
    if (
      !parsed ||
      typeof parsed.trackedRepositoryId !== "string" ||
      !parsed.trackedRepositoryId.trim() ||
      typeof parsed.subjectType !== "string" ||
      !parsed.subjectType.trim() ||
      typeof parsed.subjectNumber !== "number" ||
      !Number.isInteger(parsed.subjectNumber) ||
      parsed.subjectNumber <= 0
    ) {
      return NextResponse.json({ error: "Invalid triage input." }, { status: 400 });
    }
    payload = parsed;
  } catch {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }

  try {
    const run = await createTriageRun({
      trackedRepositoryId: payload.trackedRepositoryId,
      subjectType: payload.subjectType,
      subjectNumber: payload.subjectNumber,
      notes: payload.notes,
    });
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create triage run." },
      { status: 400 },
    );
  }
}
