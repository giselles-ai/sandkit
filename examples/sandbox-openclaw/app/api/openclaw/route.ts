import { NextRequest, NextResponse } from "next/server";

import {
  commitSession,
  createWorkspace,
  extendSession,
  readState,
  type OpenClawState,
} from "@/lib/openclaw-service";

export const dynamic = "force-dynamic";

type ActionPayload = {
  action: "createWorkspace" | "extendSession" | "commitSession";
  durationMs?: number;
};

function parseDurationMs(raw: number | undefined): number {
  if (!Number.isFinite(raw ?? NaN) || raw === undefined) {
    return 10 * 60_000;
  }

  return raw;
}

type StateResponse = {
  state: OpenClawState;
  error?: string;
};

async function responseFromState(state: OpenClawState) {
  return NextResponse.json({ state });
}

export async function GET() {
  const state = await readState();
  return responseFromState(state);
}

export async function POST(req: NextRequest) {
  let payload: ActionPayload;
  let baseState: OpenClawState;

  try {
    const parsed = (await req.json()) as ActionPayload;
    if (
      parsed.action !== "createWorkspace" &&
      parsed.action !== "extendSession" &&
      parsed.action !== "commitSession"
    ) {
      throw new Error("Invalid action");
    }
    payload = parsed;
  } catch {
    baseState = await readState().catch(() => ({
      hasWorkspace: false,
      hasActiveSession: false,
    }));
    return NextResponse.json(
      { state: baseState, error: "Invalid request payload." },
      { status: 400 },
    );
  }

  try {
    const state =
      payload.action === "createWorkspace"
        ? await createWorkspace()
        : payload.action === "extendSession"
          ? await extendSession(parseDurationMs(payload.durationMs))
          : await commitSession();
    return responseFromState(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const currentState = await readState().catch(() => null);
    const response: StateResponse = {
      state: currentState ?? {
        hasWorkspace: false,
        hasActiveSession: false,
      },
      error: message,
    };

    return NextResponse.json(response, { status: 400 });
  }
}
