import { getRun } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/internal/errors";

export function isWorkflowRunMissing(error: unknown): boolean {
  return (
    error instanceof WorkflowRunNotFoundError ||
    WorkflowRunNotFoundError.is(error as object) ||
    (error instanceof Error && error.name === "WorkflowRunNotFoundError")
  );
}

export async function getRunOrNull(runId: string) {
  try {
    const run = getRun(runId);
    await run.status;
    return run;
  } catch (error) {
    if (isWorkflowRunMissing(error)) {
      return null;
    }

    throw error;
  }
}
