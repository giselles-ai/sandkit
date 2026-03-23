export type OpenClawWorkflowStartInput = {
  durationMs?: number;
  requestedAt: string;
};

export type OpenClawWorkflowCreateInput = {
  requestedAt: string;
};

export type OpenClawStartStep = "resolve_start_attempt" | "ensure_gateway_running" | "public_ready";

export type OpenClawCreateStep = "prepare_workspace" | "durable_bootstrap" | "verify_bootstrap";

export type OpenClawRunStep = OpenClawStartStep | OpenClawCreateStep;

export type OpenClawRunPhase = "session_started" | "server_started" | "ready";

export type OpenClawRunEvent =
  | {
      index: number;
      type: "phase";
      phase: OpenClawRunPhase;
      ts: string;
      openclawSessionId?: string;
      sandboxId?: string;
      message?: string;
    }
  | {
      index: number;
      type: "step";
      step: OpenClawRunStep;
      status: "started" | "completed";
      ts: string;
      detail?: string;
    }
  | {
      index: number;
      type: "result";
      ts: string;
      finalOutput: {
        kind?: "createWorkspace" | "startSession";
        openclawSessionId?: string;
        sandboxId?: string;
        openclawUrl?: string;
        workspaceId?: string;
      };
    }
  | {
      index: number;
      type: "error";
      ts: string;
      code: string;
      message: string;
      retryable?: boolean;
    };

export type OpenClawStartFinalOutput = {
  kind: "startSession";
  openclawSessionId?: string;
  sandboxId?: string;
  openclawUrl?: string;
};

export type OpenClawCreateFinalOutput = {
  kind: "createWorkspace";
  workspaceId?: string;
};

export function createOpenClawRunEvent(
  index: number,
  event: Omit<OpenClawRunEvent, "index" | "ts">,
): OpenClawRunEvent {
  return {
    ...event,
    index,
    ts: new Date().toISOString(),
  } as OpenClawRunEvent;
}

export type OpenClawDisplayState = {
  phase?: OpenClawRunPhase;
  step?: OpenClawRunStep;
  lastMessage?: string;
};

export function deriveRunDisplayState(events: OpenClawRunEvent[]): OpenClawDisplayState {
  const reversed = [...events].reverse();

  for (const event of reversed) {
    if (event.type === "error") {
      return {
        phase: undefined,
        step: undefined,
        lastMessage: event.message,
      };
    }

    if (event.type === "result") {
      if (event.finalOutput.kind === "createWorkspace") {
        return {
          phase: undefined,
          step: undefined,
          lastMessage: "workspace created",
        };
      }

      return {
        phase: "ready",
        step: undefined,
        lastMessage: "ready",
      };
    }

    if (event.type === "phase") {
      return {
        phase: event.phase,
        step: undefined,
        lastMessage: event.message,
      };
    }

    if (event.type === "step" && event.detail) {
      return {
        phase: undefined,
        step: event.step,
        lastMessage: event.detail,
      };
    }
  }

  return {
    phase: undefined,
    step: undefined,
    lastMessage: undefined,
  };
}
