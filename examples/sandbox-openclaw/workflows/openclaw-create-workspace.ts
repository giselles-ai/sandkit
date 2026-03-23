import { getWritable } from "workflow";

import {
  createOpenClawRunEvent,
  type OpenClawRunStep,
  type OpenClawRunPhase,
  type OpenClawCreateFinalOutput,
  type OpenClawWorkflowCreateInput,
} from "@/lib/openclaw-workflow-steps";

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
        finalOutput: OpenClawCreateFinalOutput;
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

async function runOpenClawCreateWorkspaceStep(): Promise<OpenClawCreateFinalOutput> {
  "use step";

  const { createWorkspace } = await import("@/lib/openclaw-service");
  const writer = createEventWriter();

  try {
    const state = await createWorkspace({
      onStep: async ({ step, status }) => {
        await writer.write({
          type: "step",
          step,
          status,
        });
      },
    });

    const finalOutput: OpenClawCreateFinalOutput = {
      kind: "createWorkspace",
      workspaceId: state.workspaceId,
    };
    await writer.write({
      type: "result",
      finalOutput,
    });

    return finalOutput;
  } catch (error) {
    await writer.write({
      type: "error",
      code: "openclaw_create_failed",
      message: toErrorMessage(error),
      retryable: false,
    });
    throw error;
  } finally {
    await writer.close();
  }
}

runOpenClawCreateWorkspaceStep.maxRetries = 0;

export async function startOpenClawCreateWorkspaceWorkflow(
  input: OpenClawWorkflowCreateInput,
): Promise<OpenClawCreateFinalOutput> {
  "use workflow";

  if (!input.requestedAt) {
    throw new Error("Invalid create-workspace workflow payload.");
  }

  return runOpenClawCreateWorkspaceStep();
}
