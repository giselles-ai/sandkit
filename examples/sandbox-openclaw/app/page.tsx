"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyRunEventToState,
  nextStreamStartIndex,
  shouldReconnectForRunningRun,
  isRunStatusTerminal,
  isStreamOpenFailureFatal,
  type OpenClawRun,
} from "@/lib/openclaw-run-stream";
import type { OpenClawDisplayState, OpenClawRunEvent } from "@/lib/openclaw-workflow-steps";

type StreamEvent = OpenClawRunEvent;
type RunRouteResponse = {
  runId: string;
  status: "pending" | "running" | "completed" | "succeeded" | "failed" | "cancelled" | "unknown";
};

class StreamOpenError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

type OpenClawState = {
  hasWorkspace: boolean;
  workspaceId?: string;
  hasActiveSession: boolean;
  openclawPhase?: string;
  sandboxId?: string;
  openclawUrl?: string;
  remainingMs?: number;
  expiresAt?: string;
  connectCommand?: string;
};

type StatePayload = {
  state: OpenClawState;
  error?: string;
};

type RunStartResponse = {
  runId: string;
};

type RunPayload = {
  runId: string;
};
function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(
    seconds,
  ).padStart(2, "0")}s`;
}

function CopyCommand({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 900);
  }

  return (
    <div className="row">
      <input className="copy-field" value={value} readOnly />
      <button className="button" type="button" onClick={() => void onCopy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function summarizeProgressState(
  run: OpenClawRun | null,
  durablePhase: string | undefined,
): {
  phase: string | undefined;
  message: string | undefined;
} {
  if (durablePhase === "ready") {
    return {
      phase: "ready",
      message: "ready",
    };
  }

  if (run?.status === "running") {
    return {
      phase: run.display.phase ?? durablePhase,
      message: run.display.lastMessage,
    };
  }

  return {
    phase: durablePhase,
    message: run?.display.lastMessage,
  };
}

function describeProgressMessage(
  phase: string | undefined,
  step: OpenClawDisplayState["step"] | undefined,
  message: string | undefined,
): string | null {
  if (message) {
    return message;
  }

  if (phase === "session_started") {
    return "Connecting to session...";
  }

  if (phase === "server_started") {
    return "Starting OpenClaw gateway...";
  }

  if (phase === "ready") {
    return "OpenClaw is ready.";
  }

  if (step === "prepare_workspace") {
    return "Preparing workspace...";
  }

  if (step === "durable_bootstrap") {
    return "Installing bootstrap artifacts durably...";
  }

  if (step === "verify_bootstrap") {
    return "Verifying bootstrap installation...";
  }

  if (step === "resolve_start_attempt") {
    return "Preparing start attempt...";
  }

  if (step === "ensure_gateway_running") {
    return "Ensuring gateway process and route are ready...";
  }

  if (step === "public_ready") {
    return "Checking public endpoint...";
  }

  return null;
}

async function fetchState(): Promise<StatePayload> {
  const response = await fetch("/api/openclaw", { method: "GET", cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to read control plane state.");
  }

  return (await response.json()) as StatePayload;
}

async function fetchRunStatus(runId: string): Promise<RunRouteResponse | null> {
  const response = await fetch(`/api/openclaw/runs/${encodeURIComponent(runId)}`, {
    method: "GET",
    cache: "no-store",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Unable to read run status (${response.status}).`);
  }

  return {
    runId,
    status: ((await response.json()) as { status: RunRouteResponse["status"] }).status,
  };
}

type ApiActionResponse = StatePayload | RunPayload | { error: string };

async function callAction(payload: Record<string, unknown>): Promise<ApiActionResponse> {
  const response = await fetch("/api/openclaw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const next = (await response.json()) as ApiActionResponse;
  if (!response.ok || "error" in next) {
    throw new Error("error" in next ? next.error : "Action failed.");
  }

  return next;
}

async function startWorkflow(): Promise<string> {
  const response = await fetch("/api/openclaw/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestedAt: new Date().toISOString() }),
  });

  const payload = (await response.json()) as RunStartResponse | { error: string };
  if (!response.ok || "error" in payload) {
    throw new Error("error" in payload ? payload.error : "start request failed");
  }

  return payload.runId;
}

async function startCreateWorkspaceWorkflow(): Promise<string> {
  const payload = await callAction({
    action: "createWorkspace",
  });
  if ("runId" in payload) {
    return payload.runId;
  }

  throw new Error("createWorkspace did not return a run handle.");
}

async function streamRunEvents(
  runId: string,
  startIndex: number,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
) {
  const response = await fetch(
    `/api/openclaw/runs/${encodeURIComponent(runId)}/stream?startIndex=${startIndex}`,
    {
      cache: "no-store",
      signal,
    },
  );

  if (!response.ok || !response.body) {
    throw new StreamOpenError("Unable to open event stream.", response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const next = await reader.read();
    if (next.done) {
      return;
    }

    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const event = JSON.parse(trimmed) as StreamEvent;
        onEvent(event);
      } catch (error) {
        throw new Error(
          `Invalid stream payload: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export default function Page() {
  const [state, setState] = useState<OpenClawState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<OpenClawRun | null>(null);

  const streamController = useRef<AbortController | null>(null);
  const activeRunRef = useRef<OpenClawRun | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    activeRunRef.current = activeRun;
  }, [activeRun]);

  const refresh = useCallback(async () => {
    try {
      const nextState = await fetchState();
      setState(nextState.state);
      setError(nextState.error ?? null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load state.");
    }
  }, []);

  const stopRunStream = useCallback(() => {
    if (streamController.current) {
      streamController.current.abort();
      streamController.current = null;
    }

    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const startStream = useCallback(
    async (runId: string) => {
      stopRunStream();
      const attempt = ++reconnectAttemptRef.current;
      const startIndex = nextStreamStartIndex(activeRunRef.current, runId);
      const controller = new AbortController();
      streamController.current = controller;

      try {
        await streamRunEvents(
          runId,
          startIndex,
          (event) => {
            const nextRun = applyRunEventToState(runId, event, activeRunRef.current);
            if (!nextRun) {
              return;
            }

            setActiveRun(nextRun);
            activeRunRef.current = nextRun;

            if (event.type === "result" || event.type === "error") {
              setError(null);
              void refresh();
            }
          },
          controller.signal,
        );

        const currentRun = activeRunRef.current;
        if (currentRun?.runId !== runId) {
          return;
        }

        try {
          const runStatus = await fetchRunStatus(runId);
          if (!runStatus || isRunStatusTerminal(runStatus.status)) {
            setActiveRun((current) => (current?.runId === runId ? null : current));
            activeRunRef.current = null;
            void refresh();
            return;
          }
        } catch (runError) {
          setError(runError instanceof Error ? runError.message : "Unable to check run status.");
          setActiveRun((current) => (current?.runId === runId ? null : current));
          activeRunRef.current = null;
          return;
        }

        if (shouldReconnectForRunningRun(currentRun)) {
          setActiveRun({
            ...currentRun,
            display: {
              ...currentRun.display,
              lastMessage: "Stream ended. Reconnecting...",
            },
          });
          activeRunRef.current = {
            ...currentRun,
            display: {
              ...currentRun.display,
              lastMessage: "Stream ended. Reconnecting...",
            },
          };
          reconnectTimerRef.current = window.setTimeout(() => {
            void startStream(runId);
          }, 1000);
        } else {
          setActiveRun((current) => (current?.runId === runId ? null : current));
          activeRunRef.current = null;
        }
      } catch (streamError) {
        if (controller.signal.aborted || attempt !== reconnectAttemptRef.current) {
          return;
        }

        const currentRun = activeRunRef.current;
        if (!currentRun || currentRun.runId !== runId) {
          return;
        }

        if (streamError instanceof StreamOpenError) {
          const isPermanentOpenFailure = isStreamOpenFailureFatal(streamError.status);

          if (isPermanentOpenFailure) {
            setError(`Unable to open event stream (${streamError.status}).`);
            setActiveRun((current) => (current?.runId === runId ? null : current));
            activeRunRef.current = null;
            return;
          }
        }

        try {
          const runStatus = await fetchRunStatus(runId);
          if (!runStatus || isRunStatusTerminal(runStatus.status)) {
            setError("Run ended before stream updates were consumed.");
            setActiveRun((current) => (current?.runId === runId ? null : current));
            activeRunRef.current = null;
            void refresh();
            return;
          }
        } catch (runError) {
          setError(runError instanceof Error ? runError.message : "Unable to check run status.");
          setActiveRun((current) => (current?.runId === runId ? null : current));
          activeRunRef.current = null;
          return;
        }

        if (currentRun?.runId === runId && shouldReconnectForRunningRun(currentRun)) {
          if (
            !currentRun.display.lastMessage ||
            !currentRun.display.lastMessage.includes("Reconnecting")
          ) {
            setActiveRun({
              ...currentRun,
              display: {
                ...currentRun.display,
                lastMessage: "Stream disconnected. Reconnecting...",
              },
            });
            activeRunRef.current = {
              ...currentRun,
              display: {
                ...currentRun.display,
                lastMessage: "Stream disconnected. Reconnecting...",
              },
            };
          }

          reconnectTimerRef.current = window.setTimeout(() => {
            void startStream(runId);
          }, 1000);
          return;
        }

        setError(streamError instanceof Error ? streamError.message : "Event stream failed.");
      } finally {
        if (!controller.signal.aborted && attempt === reconnectAttemptRef.current) {
          streamController.current = null;
        }
      }
    },
    [refresh, stopRunStream],
  );

  const stopAllRunStream = useCallback(() => {
    stopRunStream();
    reconnectAttemptRef.current += 1;
  }, [stopRunStream]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 8_000);

    return () => {
      window.clearInterval(timer);
      stopAllRunStream();
    };
  }, [refresh, stopAllRunStream]);

  useEffect(() => {
    if (activeRun?.status !== "running") {
      stopRunStream();
      reconnectAttemptRef.current += 1;
    }
  }, [activeRun?.status, stopRunStream]);

  async function runAction(action: "extendSession" | "commitSession", durationMs?: number) {
    if (busy) {
      return;
    }

    setBusy(action);
    setError(null);
    try {
      const response = await callAction({
        action,
        ...(durationMs === undefined ? {} : { durationMs }),
      });
      if ("state" in response) {
        setState(response.state);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Action failed.");
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function createWorkspace() {
    if (busy) {
      return;
    }

    setBusy("createWorkspace");
    setError(null);
    stopAllRunStream();
    try {
      const runId = await startCreateWorkspaceWorkflow();
      setActiveRun({
        runId,
        status: "running",
        lastIndex: 0,
        display: {
          lastMessage: "createWorkspace request accepted",
        },
      });
      activeRunRef.current = {
        runId,
        status: "running",
        lastIndex: 0,
        display: {
          lastMessage: "createWorkspace request accepted",
        },
      };
      await refresh();
      await startStream(runId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Create workspace action failed.");
      await refresh();
      setActiveRun(null);
      activeRunRef.current = null;
    } finally {
      setBusy(null);
    }
  }

  async function startSession() {
    if (busy) {
      return;
    }

    setBusy("startSession");
    setError(null);

    try {
      const runId = await startWorkflow();
      stopAllRunStream();
      setActiveRun({
        runId,
        status: "running",
        lastIndex: 0,
        display: {
          lastMessage: "start request accepted",
        },
      });
      activeRunRef.current = {
        runId,
        status: "running",
        lastIndex: 0,
        display: {
          lastMessage: "start request accepted",
        },
      };
      await refresh();
      await startStream(runId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Start workflow failed.");
      await refresh();
      setActiveRun(null);
    } finally {
      setBusy(null);
    }
  }

  const isRunActive = activeRun?.status === "running";
  const overlayMessage = describeProgressMessage(
    summarizeProgressState(activeRun, state?.openclawPhase).phase,
    activeRun?.display.step,
    activeRun?.display.lastMessage,
  );

  const displayedPhase = summarizeProgressState(activeRun, state?.openclawPhase).phase;
  const overlayReady = state?.openclawPhase === "ready" || displayedPhase === "ready";

  if (!state) {
    return (
      <section className="panel">
        <h1 className="title">OpenClaw Control Plane</h1>
        <p className="status">Loading workspace state...</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h1 className="title">OpenClaw Control Plane</h1>
      <p className="subtitle">
        One workspace, one durable bootstrap path, one live session for OpenClaw operations. Start
        uses `/api/openclaw/start` to run orchestrated startup and stream progress.
      </p>

      {!state.hasWorkspace ? (
        <section className="grid">
          <p className="status">
            Workspace is not created yet. This runs durable bootstrap in `runCommand` and installs
            OpenClaw into Vercel Sandbox.
          </p>
          {activeRun?.display.lastMessage ? (
            <p className="status">{activeRun.display.lastMessage}</p>
          ) : null}
          <div className="row">
            <button
              className="button primary"
              type="button"
              disabled={busy === "createWorkspace"}
              onClick={() => void createWorkspace()}
            >
              {busy === "createWorkspace" ? "Creating workspace..." : "Create Workspace"}
            </button>
          </div>
        </section>
      ) : (
        <section className="grid">
          <div className="row">
            <button className="button" type="button" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          <dl className="facts">
            <dt>OpenClaw phase</dt>
            <dd>{overlayReady ? "ready" : (displayedPhase ?? "unknown")}</dd>
            <dt>Workspace</dt>
            <dd>{state.workspaceId}</dd>
            <dt>Sandbox ID</dt>
            <dd>{state.sandboxId ?? "no active session"}</dd>
            <dt>Session Remaining</dt>
            <dd>
              {state.remainingMs === undefined ? "inactive" : formatDuration(state.remainingMs)}
            </dd>
          </dl>

          {state.hasActiveSession ? (
            <>
              <div className="row">
                {state.openclawUrl ? (
                  <a
                    className="link button primary"
                    href={state.openclawUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open OpenClaw UI
                  </a>
                ) : (
                  <button
                    className="button primary"
                    type="button"
                    disabled={busy === "startSession" || isRunActive}
                    onClick={() => void startSession()}
                  >
                    {busy === "startSession" || isRunActive ? "Starting..." : "Start OpenClaw UI"}
                  </button>
                )}
                <button
                  className="button"
                  type="button"
                  disabled={busy === "extendSession"}
                  onClick={() => void runAction("extendSession", 10 * 60_000)}
                >
                  {busy === "extendSession" ? "Extending..." : "+10m"}
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy === "extendSession"}
                  onClick={() => void runAction("extendSession", 30 * 60_000)}
                >
                  {busy === "extendSession" ? "Extending..." : "+30m"}
                </button>
                <button
                  className="button warn"
                  type="button"
                  disabled={busy === "commitSession"}
                  onClick={() => void runAction("commitSession")}
                >
                  {busy === "commitSession" ? "Committing..." : "Commit and end session"}
                </button>
              </div>
              {!state.openclawUrl ? (
                <p className="status">{overlayMessage ?? "Waiting for readiness."}</p>
              ) : null}
              <CopyCommand value={state.connectCommand ?? `sandbox connect ${state.sandboxId}`} />
            </>
          ) : (
            <div className="row">
              <button
                className="button primary"
                type="button"
                disabled={busy === "startSession" || isRunActive}
                onClick={() => void startSession()}
              >
                {busy === "startSession" || isRunActive ? "Starting..." : "Start Session"}
              </button>
            </div>
          )}

          {state.openclawPhase === undefined ? (
            <p className="status">
              OpenClaw durable bootstrap state is invalid; unable to read a stable public phase.
            </p>
          ) : null}
          {activeRun?.status === "failed" && !overlayReady ? (
            <p className="error">Startup failed: {activeRun.display.lastMessage}</p>
          ) : null}
        </section>
      )}

      {error ? <p className="error">Error: {error}</p> : null}
      <p className="status">
        {state.expiresAt ? `Session expires at: ${new Date(state.expiresAt).toLocaleString()}` : ""}
      </p>
    </section>
  );
}
