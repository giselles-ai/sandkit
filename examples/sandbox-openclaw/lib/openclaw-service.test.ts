import { describe, expect, test } from "bun:test";

import {
  deriveOpenClawPhaseForPassiveRead,
  composeOpenClawPassiveState,
  isOpenClawSessionRecordReusableForStart,
} from "./openclaw-service";

describe("OpenClaw phase derivation (passive reads)", () => {
  test("derives bootstrapped when there is no active lease and durable bootstrap exists", () => {
    const derived = deriveOpenClawPhaseForPassiveRead(null, true, undefined);

    expect(derived).toBe("bootstrapped");
  });

  test("returns undefined when durable bootstrap is absent and no active public readiness exists", () => {
    const derived = deriveOpenClawPhaseForPassiveRead(null, false, undefined);

    expect(derived).toBe(undefined);
  });

  test("derives startup progress only when explicitly supplied as in-progress state", () => {
    const derived = deriveOpenClawPhaseForPassiveRead(
      {
        hasActiveSession: true,
      },
      true,
      "session_started",
    );

    expect(derived).toBe("session_started");
  });

  test("derives ready when active lease has a healthy UI URL", () => {
    const derived = deriveOpenClawPhaseForPassiveRead(
      {
        hasActiveSession: true,
        openclawUrl: "https://example.com",
      },
      false,
      undefined,
    );

    expect(derived).toBe("ready");
  });

  test("derives bootstrapped when active lease has no healthy UI URL but durable bootstrap exists", () => {
    const derived = deriveOpenClawPhaseForPassiveRead(
      {
        hasActiveSession: true,
      },
      true,
      undefined,
    );

    expect(derived).toBe("bootstrapped");
  });

  test("returns undefined when active lease exists but durable bootstrap is absent/corrupt", () => {
    const derived = deriveOpenClawPhaseForPassiveRead(
      {
        hasActiveSession: true,
      },
      false,
      undefined,
    );

    expect(derived).toBe(undefined);
  });

  test("derives session_started when active lease has no URL during startup progress", () => {
    const derived = deriveOpenClawPhaseForPassiveRead(
      {
        hasActiveSession: true,
      },
      true,
      "session_started",
    );

    expect(derived).toBe("session_started");
  });

  test("derives server_started when active lease has no URL during server startup progress", () => {
    const derived = deriveOpenClawPhaseForPassiveRead(
      {
        hasActiveSession: true,
      },
      true,
      "server_started",
    );

    expect(derived).toBe("server_started");
  });

  test("collapses to bootstrapped after commit via passive derived truth", () => {
    const derived = deriveOpenClawPhaseForPassiveRead(null, true, undefined);

    expect(derived).toBe("bootstrapped");
  });

  test("never exposes committed as public phase", () => {
    const derived = deriveOpenClawPhaseForPassiveRead(
      {
        hasActiveSession: true,
        openclawUrl: "https://example.com",
      },
      true,
      undefined,
    );

    expect(derived).not.toBe("committed");
    expect([
      "bootstrapped",
      "session_started",
      "server_started",
      "ready",
      undefined,
    ] as const).toContain(derived);
  });

  test("getState composition can expose session_started from summary while preserving lease truth", () => {
    const composed = composeOpenClawPassiveState(
      {
        hasActiveSession: true,
        sandboxId: "sbx_123",
        remainingMs: 240_000,
        expiresAt: "2026-03-22T09:00:00.000Z",
        openclawUrl: undefined,
        connectCommand: "sandbox connect sbx_123",
      },
      true,
      "session_started",
    );

    expect(composed.openclawPhase).toBe("session_started");
    expect(composed.hasActiveSession).toBe(true);
    expect(composed.sandboxId).toBe("sbx_123");
    expect(composed.remainingMs).toBe(240_000);
  });

  test("getState composition can expose server_started from summary while preserving lease truth", () => {
    const composed = composeOpenClawPassiveState(
      {
        hasActiveSession: true,
        sandboxId: "sbx_123",
        remainingMs: 240_000,
        expiresAt: "2026-03-22T09:00:00.000Z",
        openclawUrl: undefined,
        connectCommand: "sandbox connect sbx_123",
      },
      true,
      "server_started",
    );

    expect(composed.openclawPhase).toBe("server_started");
    expect(composed.hasActiveSession).toBe(true);
    expect(composed.sandboxId).toBe("sbx_123");
    expect(composed.remainingMs).toBe(240_000);
  });

  test("getState composition keeps phase undefined when durable bootstrap is missing even if progress phase is supplied", () => {
    const composed = composeOpenClawPassiveState(
      {
        hasActiveSession: true,
        sandboxId: "sbx_123",
        remainingMs: 240_000,
        expiresAt: "2026-03-22T09:00:00.000Z",
        openclawUrl: undefined,
        connectCommand: "sandbox connect sbx_123",
      },
      false,
      "session_started",
    );

    expect(composed.openclawPhase).toBe(undefined);
    expect(composed.hasActiveSession).toBe(true);
    expect(composed.sandboxId).toBe("sbx_123");
    expect(composed.remainingMs).toBe(240_000);
  });

  test("commitSession terminal row is not reused by startSession selection", () => {
    const reused = isOpenClawSessionRecordReusableForStart({
      phase: "bootstrapped",
      finished_at: new Date("2026-03-22T00:00:00.000Z"),
    });

    expect(reused).toBe(false);
  });

  test("startSession can reuse non-finished resumable rows", () => {
    const reused = isOpenClawSessionRecordReusableForStart({
      phase: "ready",
      finished_at: null,
    });

    expect(reused).toBe(true);
  });

  test("active lease fields are preserved when durable bootstrap is invalid, while phase is undefined", () => {
    const composed = composeOpenClawPassiveState(
      {
        hasActiveSession: true,
        sandboxId: "sbx_123",
        remainingMs: 300_000,
        expiresAt: "2026-03-22T09:00:00.000Z",
        connectCommand: "sandbox connect sbx_123",
      },
      false,
    );

    expect(composed.openclawPhase).toBe(undefined);
    expect(composed.hasActiveSession).toBe(true);
    expect(composed.sandboxId).toBe("sbx_123");
    expect(composed.remainingMs).toBe(300_000);
    expect(composed.expiresAt).toBe("2026-03-22T09:00:00.000Z");
    expect(composed.connectCommand).toBe("sandbox connect sbx_123");
  });
});
