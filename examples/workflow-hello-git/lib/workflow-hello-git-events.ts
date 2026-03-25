import type { WorkflowPrReviewFinalOutput } from "@/workflows/hello-git";

export type WorkflowPrReviewStep =
  | "ensure_workspace"
  | "clone_repository"
  | "fetch_pull_request"
  | "checkout_pull_request"
  | "run_codex_exec"
  | "collect_report";

export type WorkflowPrReviewRunEvent =
  | {
      index: number;
      type: "step";
      step: WorkflowPrReviewStep;
      status: "started" | "completed";
      ts: string;
      detail?: string;
    }
  | {
      index: number;
      type: "result";
      ts: string;
      finalOutput: WorkflowPrReviewFinalOutput;
    }
  | {
      index: number;
      type: "error";
      ts: string;
      code: string;
      message: string;
    };

type WorkflowPrReviewRunEventInput =
  | {
      type: "step";
      step: WorkflowPrReviewStep;
      status: "started" | "completed";
      detail?: string;
    }
  | {
      type: "result";
      finalOutput: WorkflowPrReviewFinalOutput;
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export type WorkflowPrReviewDisplayState = {
  step?: WorkflowPrReviewStep;
  lastMessage?: string;
};

export function createWorkflowPrReviewRunEvent(
  index: number,
  event: WorkflowPrReviewRunEventInput,
): WorkflowPrReviewRunEvent {
  return {
    ...event,
    index,
    ts: new Date().toISOString(),
  } as WorkflowPrReviewRunEvent;
}

export function deriveWorkflowPrReviewDisplayState(
  events: WorkflowPrReviewRunEvent[],
): WorkflowPrReviewDisplayState {
  const reversed = [...events].reverse();

  for (const event of reversed) {
    if (event.type === "error") {
      return {
        lastMessage: event.message,
      };
    }

    if (event.type === "result") {
      return {
        lastMessage:
          event.finalOutput.report?.summary ??
          `Codex finished with exit code ${event.finalOutput.codexExitCode}.`,
      };
    }

    if (event.type === "step") {
      return {
        step: event.status === "started" ? event.step : undefined,
        lastMessage: event.detail,
      };
    }
  }

  return {};
}
