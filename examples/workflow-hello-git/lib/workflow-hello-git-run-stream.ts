import {
  deriveWorkflowPrReviewDisplayState,
  type WorkflowPrReviewDisplayState,
  type WorkflowPrReviewRunEvent,
} from "@/lib/workflow-hello-git-events";
import type { WorkflowPrReviewFinalOutput } from "@/workflows/hello-git";

export type WorkflowPrReviewRun = {
  runId: string;
  status: "running" | "succeeded" | "failed";
  lastIndex: number;
  events: WorkflowPrReviewRunEvent[];
  display: WorkflowPrReviewDisplayState;
  finalOutput?: WorkflowPrReviewFinalOutput;
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

export function nextStreamStartIndex(activeRun: WorkflowPrReviewRun | null, runId: string): number {
  return activeRun?.runId === runId ? activeRun.lastIndex : 0;
}

export function applyRunEventToState(
  runId: string,
  event: WorkflowPrReviewRunEvent,
  current: WorkflowPrReviewRun | null,
): WorkflowPrReviewRun {
  const base: WorkflowPrReviewRun =
    current?.runId === runId
      ? current
      : {
          runId,
          status: "running",
          lastIndex: 0,
          events: [],
          display: {},
        };

  if (event.index < base.lastIndex) {
    return base;
  }

  const events = [...base.events, event];
  const next: WorkflowPrReviewRun = {
    ...base,
    lastIndex: Math.max(base.lastIndex, event.index + 1),
    events,
    display: deriveWorkflowPrReviewDisplayState(events),
  };

  if (event.type === "result") {
    return {
      ...next,
      status: "succeeded",
      finalOutput: event.finalOutput,
    };
  }

  if (event.type === "error") {
    return {
      ...next,
      status: "failed",
    };
  }

  return next;
}

export function shouldReconnectForRunningRun(run: WorkflowPrReviewRun | null): boolean {
  return run?.status === "running";
}
