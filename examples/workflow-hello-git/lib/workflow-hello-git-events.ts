export type WorkflowHelloGitStep =
  | "ensure_workspace"
  | "clone_repository"
  | "read_repository_status";

export type WorkflowHelloGitRunEvent =
  | {
      index: number;
      type: "step";
      step: WorkflowHelloGitStep;
      status: "started" | "completed";
      ts: string;
      detail?: string;
    }
  | {
      index: number;
      type: "result";
      ts: string;
      finalOutput: {
        kind: "helloGit";
        workspaceId: string;
        repo: string;
        clonePerformed: boolean;
        status: string;
        files: string;
        requestedAt: string;
      };
    }
  | {
      index: number;
      type: "error";
      ts: string;
      code: string;
      message: string;
    };

type WorkflowHelloGitRunEventInput =
  | {
      type: "step";
      step: WorkflowHelloGitStep;
      status: "started" | "completed";
      detail?: string;
    }
  | {
      type: "result";
      finalOutput: {
        kind: "helloGit";
        workspaceId: string;
        repo: string;
        clonePerformed: boolean;
        status: string;
        files: string;
        requestedAt: string;
      };
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export type WorkflowHelloGitDisplayState = {
  step?: WorkflowHelloGitStep;
  lastMessage?: string;
};

export function createWorkflowHelloGitRunEvent(
  index: number,
  event: WorkflowHelloGitRunEventInput,
): WorkflowHelloGitRunEvent {
  return {
    ...event,
    index,
    ts: new Date().toISOString(),
  } as WorkflowHelloGitRunEvent;
}

export function deriveWorkflowHelloGitDisplayState(
  events: WorkflowHelloGitRunEvent[],
): WorkflowHelloGitDisplayState {
  const reversed = [...events].reverse();

  for (const event of reversed) {
    if (event.type === "error") {
      return {
        lastMessage: event.message,
      };
    }

    if (event.type === "result") {
      return {
        lastMessage: event.finalOutput.clonePerformed ? "clone completed" : "workspace reused",
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
