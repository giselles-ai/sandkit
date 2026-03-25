import { NextRequest, NextResponse } from "next/server";
import { start } from "workflow/api";

import {
  parseWorkflowPrReviewInput,
  runPrReviewWorkflow,
  type ParsedWorkflowPrReviewInput,
} from "@/workflows/hello-git";

type StartResponse = {
  runId: string;
};

type ErrorResponse = {
  error: string;
};

export async function POST(req: NextRequest): Promise<NextResponse<StartResponse | ErrorResponse>> {
  let input: ParsedWorkflowPrReviewInput;
  try {
    const payload = (await req.json()) as unknown;
    const parsed = parseWorkflowPrReviewInput(payload);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
    }

    input = parsed;
  } catch {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }

  try {
    const run = await start(runPrReviewWorkflow, [input]);
    return NextResponse.json({ runId: run.runId }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "Failed to start PR review workflow." }, { status: 500 });
  }
}
