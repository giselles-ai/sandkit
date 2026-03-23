import { NextRequest, NextResponse } from "next/server";

import {
  createTrackedRepository,
  listTrackedRepositories,
  type TrackedRepository,
} from "@/lib/triage-service";

export const dynamic = "force-dynamic";

type CreateRepositoryRequest = {
  slug: string;
};

export async function GET() {
  const repositories = await listTrackedRepositories();
  return NextResponse.json({ repositories });
}

export async function POST(req: NextRequest): Promise<NextResponse<{ repository: TrackedRepository } | { error: string }>> {
  let payload: CreateRepositoryRequest;
  try {
    const parsed = (await req.json()) as CreateRepositoryRequest;
    if (!parsed || typeof parsed.slug !== "string" || !parsed.slug.trim()) {
      return NextResponse.json({ error: "Invalid repository slug." }, { status: 400 });
    }
    payload = parsed;
  } catch {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }

  try {
    const repository = await createTrackedRepository(payload.slug);
    return NextResponse.json({ repository });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create repository." },
      { status: 400 },
    );
  }
}
