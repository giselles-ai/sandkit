import { getWritable } from "workflow";

import {
  createOpenClawRunEvent,
  type OpenClawRunStep,
  type OpenClawRunPhase,
  type OpenClawStartFinalOutput,
  type OpenClawWorkflowStartInput,
} from "@/lib/openclaw-workflow-steps";

function normalizeInput(raw: OpenClawWorkflowStartInput): OpenClawWorkflowStartInput {
  return {
    durationMs: raw.durationMs,
    requestedAt: raw.requestedAt ?? new Date().toISOString(),
  };
}

function createEventWriter() {
  let index = 0;

  function nextIndex(): number {
    const current = index;
    index += 1;
    return current;
  }

  type WritableOpenClawRunEvent =
    | {
        type: "phase";
        phase: OpenClawRunPhase;
        openclawSessionId?: string;
        sandboxId?: string;
        message?: string;
      }
    | {
        type: "step";
        step: OpenClawRunStep;
        status: "started" | "completed";
        detail?: string;
      }
    | {
        type: "result";
        finalOutput: OpenClawStartFinalOutput;
      }
    | {
        type: "error";
        code: string;
        message: string;
        retryable?: boolean;
      };

  return {
    write: async (event: WritableOpenClawRunEvent): Promise<void> => {
      "use step";

      const envelope = createOpenClawRunEvent(nextIndex(), event);
      const writable = getWritable<string>();
      const writer = writable.getWriter();
      await writer.write(`${JSON.stringify(envelope)}\n`);
      writer.releaseLock();
    },
    close: async () => {
      "use step";
      await getWritable<string>().close();
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runOpenClawStartSessionStep(
  input: OpenClawWorkflowStartInput,
): Promise<OpenClawStartFinalOutput> {
  "use step";

  const { startSession } = await import("@/lib/openclaw-service");
  const writer = createEventWriter();
  let openclawSessionId: string | undefined;

  try {
    const state = await startSession(input.durationMs, {
      onStep: async ({ step, status, detail }) => {
        await writer.write({
          type: "step",
          step,
          status,
          detail,
        });
      },
      onPhase: async (phase, details) => {
        if (details.openclawSessionId) {
          openclawSessionId = details.openclawSessionId;
        }

        if (phase === "ready") {
          await writer.write({
            type: "phase",
            phase,
            openclawSessionId: details.openclawSessionId,
            sandboxId: details.sandboxId,
            message: details.message ?? "OpenClaw is ready.",
          });
          return;
        }

        if (phase === "session_started") {
          await writer.write({
            type: "phase",
            phase,
            openclawSessionId: details.openclawSessionId,
            sandboxId: details.sandboxId,
            message: details.message ?? "OpenClaw session lease acquired.",
          });
          return;
        }

        if (phase === "server_started") {
          await writer.write({
            type: "phase",
            phase,
            openclawSessionId: details.openclawSessionId,
            sandboxId: details.sandboxId,
            message: details.message ?? "OpenClaw gateway startup initiated.",
          });
        }
      },
    });

    const finalOutput: OpenClawStartFinalOutput = {
      kind: "startSession",
      openclawSessionId,
      sandboxId: state.sandboxId,
      openclawUrl: state.openclawUrl,
    };

    await writer.write({
      type: "result",
      finalOutput,
    });

    return finalOutput;
  } catch (error) {
    await writer.write({
      type: "error",
      code: "openclaw_start_failed",
      message: toErrorMessage(error),
      retryable: false,
    });
    throw error;
  } finally {
    await writer.close();
  }
}

runOpenClawStartSessionStep.maxRetries = 0;

export async function startOpenClawSessionWorkflow(
  input: OpenClawWorkflowStartInput,
): Promise<OpenClawStartFinalOutput> {
  "use workflow";

  const runtimeInput = normalizeInput(input);
  return runOpenClawStartSessionStep(runtimeInput);
}
