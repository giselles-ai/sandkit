import { describe, expect, mock, test } from "bun:test";

import { WorkflowRunNotFoundError } from "workflow/internal/errors";

let runFactory: () => { status: Promise<unknown> };

mock.module("workflow/api", () => ({
  getRun: () => runFactory(),
}));

const { getRunOrNull, isWorkflowRunMissing } = await import("./openclaw-workflow-runs");

describe("openclaw workflow run lookup", () => {
  test("returns null when run status indicates missing run", async () => {
    runFactory = () => ({
      status: Promise.reject(new WorkflowRunNotFoundError("missing-run")),
    });

    await expect(getRunOrNull("missing-run")).resolves.toBeNull();
  });

  test("returns run wrapper when status resolves", async () => {
    const run = {
      status: Promise.resolve("pending"),
    };
    runFactory = () => run;

    const value = await getRunOrNull("known-run");
    expect(value).not.toBeNull();
    expect(value).toMatchObject(run);
  });

  test("classifies missing run errors by name", () => {
    expect(isWorkflowRunMissing(new WorkflowRunNotFoundError("run-123"))).toBe(true);
  });

  test("does not classify wrapped missing-run messages", () => {
    expect(isWorkflowRunMissing(new Error("run with id missing-run not found"))).toBe(false);
  });

  test("does not classify unrelated errors", () => {
    expect(isWorkflowRunMissing(new Error("permission denied"))).toBe(false);
  });
});
