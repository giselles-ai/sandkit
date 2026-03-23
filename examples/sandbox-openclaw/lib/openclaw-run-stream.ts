import type { OpenClawDisplayState, OpenClawRunEvent } from "@/lib/openclaw-workflow-steps";

export type OpenClawRunFinalOutput = {
  kind?: "createWorkspace" | "startSession";
  workspaceId?: string;
  openclawSessionId?: string;
  sandboxId?: string;
  openclawUrl?: string;
};

export type OpenClawRun = {
  runId: string;
  status: "running" | "succeeded" | "failed";
  lastIndex: number;
  display: OpenClawDisplayState;
  finalOutput?: OpenClawRunFinalOutput;
};

export function isRunStatusTerminal(status: string | undefined): boolean {
  return (
    status === "failed" ||
    status === "succeeded" ||
    status === "cancelled" ||
    status === "completed"
  );
}

export function isStreamOpenFailureFatal(status?: number): boolean {
  if (status === undefined) {
    return false;
  }

  return status === 404 || status >= 500;
}

export function nextStreamStartIndex(activeRun: OpenClawRun | null, runId: string): number {
  return activeRun?.runId === runId ? activeRun.lastIndex : 0;
}

export function applyRunEventToState(
  runId: string,
  event: OpenClawRunEvent,
  current: OpenClawRun | null,
): OpenClawRun | null {
  const base: OpenClawRun =
    current?.runId === runId
      ? current
      : {
          runId,
          status: "running",
          lastIndex: 0,
          display: {},
        };

  if (event.index < base.lastIndex) {
    return base;
  }

  const next: OpenClawRun = {
    ...base,
    lastIndex: Math.max(base.lastIndex, event.index + 1),
    display: { ...base.display },
  };

  if (event.type === "phase") {
    next.display = {
      ...next.display,
      phase: event.phase,
      lastMessage: event.message ?? `${event.phase}`,
      step: undefined,
    };
    return next;
  }

  if (event.type === "step") {
    next.display = {
      ...next.display,
      step: event.step,
      lastMessage: event.detail ?? next.display.lastMessage,
    };
    return next;
  }

  if (event.type === "result") {
    if (event.finalOutput.kind === "createWorkspace") {
      return {
        ...next,
        status: "succeeded",
        finalOutput: event.finalOutput,
        display: {
          phase: undefined,
          step: undefined,
          lastMessage: "workspace created",
        },
      };
    }

    return {
      ...next,
      status: "succeeded",
      finalOutput: event.finalOutput,
      display: {
        phase: "ready",
        lastMessage: "ready",
      },
    };
  }

  if (event.type === "error") {
    return {
      ...next,
      status: "failed",
      display: {
        ...next.display,
        lastMessage: event.message,
      },
    };
  }

  return next;
}

export function shouldReconnectForRunningRun(run: OpenClawRun | null): boolean {
  return run?.status === "running";
}
