"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import type {
  WorkflowHelloGitRunEvent,
  WorkflowHelloGitStep,
} from "@/lib/workflow-hello-git-events";
import {
  applyRunEventToState,
  isRunStatusTerminal,
  isStreamOpenFailureFatal,
  nextStreamStartIndex,
  shouldReconnectForRunningRun,
  type WorkflowHelloGitRun,
} from "@/lib/workflow-hello-git-run-stream";
import type { WorkflowHelloGitFinalOutput } from "@/workflows/hello-git";

type RunStartResponse = {
  runId: string;
};

type ApiError = {
  error: string;
};

type RunStatusResponse = {
  runId: string;
  status: "pending" | "running" | "completed" | "succeeded" | "failed" | "cancelled" | "unknown";
  finalOutput?: WorkflowHelloGitFinalOutput;
  error?: {
    code: string;
    message: string;
  };
};

class StreamOpenError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

const statusText: Record<RunStatusResponse["status"], string> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  unknown: "unknown",
};

const orderedSteps: WorkflowHelloGitStep[] = [
  "ensure_workspace",
  "clone_repository",
  "read_repository_status",
];

const stepLabels: Record<WorkflowHelloGitStep, string> = {
  ensure_workspace: "Ensure workspace",
  clone_repository: "Clone repository",
  read_repository_status: "Inspect repository",
};

function ResultOutput({ output }: { output: WorkflowHelloGitFinalOutput }) {
  return (
    <pre
      style={{
        whiteSpace: "pre-wrap",
        margin: 0,
        padding: "0.8rem",
        border: "1px solid #d0d7de",
        borderRadius: 8,
      }}
    >
      {JSON.stringify(output, null, 2)}
    </pre>
  );
}

function WorkflowOverview({ activeRun }: { activeRun: WorkflowHelloGitRun | null }) {
  const started = new Set<WorkflowHelloGitStep>();
  const completed = new Set<WorkflowHelloGitStep>();

  for (const event of activeRun?.events ?? []) {
    if (event.type !== "step") {
      continue;
    }

    if (event.status === "started") {
      started.add(event.step);
      continue;
    }

    completed.add(event.step);
  }

  return (
    <section style={{ display: "grid", gap: "0.6rem" }}>
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Workflow</h2>
      <div style={{ display: "grid", gap: "0.45rem" }}>
        {orderedSteps.map((step) => {
          const state = completed.has(step)
            ? "done"
            : activeRun?.display.step === step || started.has(step)
              ? "running"
              : "pending";

          return (
            <div
              key={step}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "1rem",
                padding: "0.7rem 0.8rem",
                border: "1px solid #d0d7de",
                borderRadius: 8,
                background:
                  state === "done" ? "#eefbf3" : state === "running" ? "#eef4ff" : "#f8fafc",
              }}
            >
              <span>{stepLabels[step]}</span>
              <strong>{state}</strong>
            </div>
          );
        })}
      </div>
      {activeRun?.display.lastMessage ? (
        <p style={{ margin: 0 }}>
          current: <strong>{activeRun.display.lastMessage}</strong>
        </p>
      ) : null}
    </section>
  );
}

function EventLog({ events }: { events: WorkflowHelloGitRunEvent[] }) {
  if (events.length === 0) {
    return null;
  }

  return (
    <section style={{ display: "grid", gap: "0.6rem" }}>
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Events</h2>
      <div
        style={{
          display: "grid",
          gap: "0.45rem",
          maxHeight: "18rem",
          overflow: "auto",
        }}
      >
        {events.map((event) => (
          <div
            key={`${event.index}-${event.type}`}
            style={{
              border: "1px solid #d0d7de",
              borderRadius: 8,
              padding: "0.7rem 0.8rem",
              background: "#fff",
            }}
          >
            <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>
              {event.type === "step"
                ? `${stepLabels[event.step]}: ${event.status}`
                : event.type === "result"
                  ? "result"
                  : "error"}
            </div>
            {"detail" in event && event.detail ? (
              <div style={{ marginTop: "0.25rem", fontSize: "0.92rem" }}>{event.detail}</div>
            ) : null}
            {event.type === "error" ? (
              <div style={{ marginTop: "0.25rem", fontSize: "0.92rem" }}>{event.message}</div>
            ) : null}
            <div style={{ marginTop: "0.25rem", fontSize: "0.8rem", color: "#4b5563" }}>
              {event.ts}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

async function streamRunEvents(
  runId: string,
  startIndex: number,
  onEvent: (event: WorkflowHelloGitRunEvent) => void,
  signal: AbortSignal,
) {
  const response = await fetch(
    `/api/hello-git/runs/${encodeURIComponent(runId)}/stream?startIndex=${startIndex}`,
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

      onEvent(JSON.parse(trimmed) as WorkflowHelloGitRunEvent);
    }
  }
}

export default function HomePage() {
  const [repo, setRepo] = useState("giselles-ai/sandkit");
  const [runId, setRunId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<RunStatusResponse["status"] | null>(null);
  const [runOutput, setRunOutput] = useState<WorkflowHelloGitFinalOutput | null>(null);
  const [activeRun, setActiveRun] = useState<WorkflowHelloGitRun | null>(null);

  const streamController = useRef<AbortController | null>(null);
  const activeRunRef = useRef<WorkflowHelloGitRun | null>(null);

  useEffect(() => {
    activeRunRef.current = activeRun;
  }, [activeRun]);

  useEffect(() => {
    if (!runId || !busy) {
      return;
    }

    const abort = new AbortController();
    const stopStream = () => {
      if (streamController.current) {
        streamController.current.abort();
        streamController.current = null;
      }
    };
    const poll = async () => {
      try {
        const response = await fetch(`/api/hello-git/runs/${encodeURIComponent(runId)}`, {
          method: "GET",
          cache: "no-store",
          signal: abort.signal,
        });

        if (!response.ok) {
          const payload = (await response.json()) as ApiError;
          throw new Error(payload.error);
        }

        const payload = (await response.json()) as RunStatusResponse;
        setStatus(payload.status);
        setRunOutput(payload.finalOutput ?? null);

        if (payload.error) {
          setError(payload.error.message);
          setBusy(false);
          stopStream();
          return;
        }

        if (isRunStatusTerminal(payload.status)) {
          setBusy(false);
          if (payload.status === "failed") {
            setError("Workflow failed.");
          }
          if (payload.status === "succeeded") {
            setError("");
          }
          stopStream();
        }
      } catch (nextError) {
        if (!abort.signal.aborted) {
          setBusy(false);
          setError(nextError instanceof Error ? nextError.message : "Failed to read run status.");
          stopStream();
        }
      }
    };

    const controller = new AbortController();
    streamController.current = controller;
    void streamRunEvents(
      runId,
      nextStreamStartIndex(activeRunRef.current, runId),
      (event) => {
        const nextRun = applyRunEventToState(runId, event, activeRunRef.current);
        activeRunRef.current = nextRun;
        setActiveRun(nextRun);
        if (event.type === "result") {
          setRunOutput(event.finalOutput);
        }
        if (event.type === "error") {
          setError(event.message);
          setBusy(false);
        }
      },
      controller.signal,
    ).catch(async (streamError) => {
      if (controller.signal.aborted) {
        return;
      }

      if (streamError instanceof StreamOpenError && isStreamOpenFailureFatal(streamError.status)) {
        setError(`Unable to open event stream (${streamError.status}).`);
        setBusy(false);
        return;
      }

      const current = activeRunRef.current;
      if (shouldReconnectForRunningRun(current)) {
        await poll();
      }
    });

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      abort.abort();
      stopStream();
      clearInterval(timer);
    };
  }, [runId, busy]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setStatus("running");
    setRunOutput(null);
    setActiveRun(null);
    setRunId("");

    try {
      const response = await fetch("/api/hello-git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as ApiError;
        throw new Error(payload.error);
      }

      const payload = (await response.json()) as RunStartResponse;
      setRunId(payload.runId);
    } catch (nextError) {
      setBusy(false);
      setError(nextError instanceof Error ? nextError.message : "Failed to start workflow.");
    }
  }

  return (
    <main
      style={{
        margin: "2rem auto",
        maxWidth: "56rem",
        display: "grid",
        gap: "1rem",
        padding: "0 1rem",
        fontFamily: "-apple-system, system-ui, Segoe UI, sans-serif",
      }}
    >
      <h1 style={{ margin: 0 }}>workflow-hello-git</h1>
      <p>
        Workflow decides when to run, and Sandkit keeps the workspace durable through{" "}
        <code>workspace.sandbox.runCommand(...)</code>.
      </p>
      <form onSubmit={submit} style={{ display: "grid", gap: "0.75rem", maxWidth: "28rem" }}>
        <label style={{ display: "grid", gap: "0.25rem" }}>
          GitHub repository
          <input
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="org/name"
            required
            style={{
              border: "1px solid #d0d7de",
              borderRadius: 6,
              padding: "0.5rem",
            }}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          style={{
            width: "fit-content",
            padding: "0.5rem 1rem",
            borderRadius: 6,
            border: "1px solid #2d6cdf",
            background: "#2f76ff",
            color: "white",
            cursor: busy ? "progress" : "pointer",
          }}
        >
          {busy ? "Running..." : "Run durable workflow"}
        </button>
      </form>

      {error ? <p style={{ color: "#b42318" }}>{error}</p> : null}

      {runId ? (
        <section style={{ display: "grid", gap: "0.5rem" }}>
          <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Run</h2>
          <p style={{ margin: 0 }}>runId: {runId}</p>
          {status ? <p style={{ margin: 0 }}>status: {statusText[status]}</p> : null}
          <WorkflowOverview activeRun={activeRun} />
          <EventLog events={activeRun?.events ?? []} />
          {runOutput ? <ResultOutput output={runOutput} /> : null}
        </section>
      ) : null}
    </main>
  );
}
