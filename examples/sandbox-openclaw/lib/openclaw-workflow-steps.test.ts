import { describe, expect, test } from "bun:test";

import { isRunStatusTerminal } from "./openclaw-run-stream";
import { deriveRunDisplayState } from "./openclaw-workflow-steps";

describe("workflow stream helpers", () => {
  test("treats terminal statuses as non-retryable", () => {
    expect(isRunStatusTerminal("succeeded")).toBe(true);
    expect(isRunStatusTerminal("failed")).toBe(true);
    expect(isRunStatusTerminal("cancelled")).toBe(true);
    expect(isRunStatusTerminal("completed")).toBe(true);
  });

  test("does not treat active statuses as terminal", () => {
    expect(isRunStatusTerminal("running")).toBe(false);
    expect(isRunStatusTerminal("pending")).toBe(false);
    expect(isRunStatusTerminal("unknown")).toBe(false);
    expect(isRunStatusTerminal(undefined)).toBe(false);
  });
});

describe("OpenClaw workflow run display derivation", () => {
  test("keeps create-workspace step messages while bootstrap is in progress", () => {
    const display = deriveRunDisplayState([
      {
        index: 0,
        type: "step",
        step: "prepare_workspace",
        status: "started",
        ts: "2026-03-23T00:00:00.000Z",
        detail: "Preparing workspace",
      },
    ]);

    expect(display.phase).toBeUndefined();
    expect(display.step).toBe("prepare_workspace");
    expect(display.lastMessage).toBe("Preparing workspace");
  });

  test("uses latest phase when it is the most recent terminal event", () => {
    const display = deriveRunDisplayState([
      {
        index: 0,
        type: "phase",
        phase: "session_started",
        ts: "2026-03-22T00:00:00.000Z",
        message: "session started",
      },
      {
        index: 1,
        type: "phase",
        phase: "server_started",
        ts: "2026-03-22T00:00:01.000Z",
        message: "gateway process started",
      },
      {
        index: 2,
        type: "phase",
        phase: "ready",
        ts: "2026-03-22T00:00:02.000Z",
        message: "ready",
      },
    ]);

    expect(display.phase).toBe("ready");
    expect(display.lastMessage).toBe("ready");
  });

  test("uses result readiness even after earlier step events", () => {
    const display = deriveRunDisplayState([
      {
        index: 0,
        type: "step",
        step: "ensure_gateway_running",
        status: "started",
        ts: "2026-03-22T00:00:00.000Z",
        detail: "start gateway",
      },
      {
        index: 1,
        type: "result",
        ts: "2026-03-22T00:00:01.000Z",
        finalOutput: {
          kind: "startSession",
          sandboxId: "sbx_123",
        },
      },
    ]);

    expect(display.phase).toBe("ready");
    expect(display.step).toBeUndefined();
  });

  test("create-workspace result renders as workspace created, not ready", () => {
    const display = deriveRunDisplayState([
      {
        index: 0,
        type: "result",
        ts: "2026-03-22T00:00:01.000Z",
        finalOutput: {
          kind: "createWorkspace",
          workspaceId: "openclaw-production",
        },
      },
    ]);

    expect(display.phase).toBeUndefined();
    expect(display.step).toBeUndefined();
    expect(display.lastMessage).toBe("workspace created");
  });

  test("uses error message over prior readiness", () => {
    const display = deriveRunDisplayState([
      {
        index: 0,
        type: "phase",
        phase: "ready",
        ts: "2026-03-22T00:00:01.000Z",
        message: "ready",
      },
      {
        index: 1,
        type: "error",
        ts: "2026-03-22T00:00:02.000Z",
        code: "failed",
        message: "startup failed",
      },
    ]);

    expect(display.phase).toBeUndefined();
    expect(display.lastMessage).toBe("startup failed");
  });
});
