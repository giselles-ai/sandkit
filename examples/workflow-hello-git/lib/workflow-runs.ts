import { getRun } from "workflow/api";

function isWorkflowRunMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "WorkflowRunNotFoundError" || error.message.includes("Run not found"))
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
