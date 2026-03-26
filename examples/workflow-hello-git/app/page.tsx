"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import type {
  WorkflowPrReviewRunEvent,
  WorkflowPrReviewStep,
} from "@/lib/workflow-hello-git-events";
import {
  applyRunEventToState,
  isRunStatusTerminal,
  isStreamOpenFailureFatal,
  nextStreamStartIndex,
  shouldReconnectForRunningRun,
  type WorkflowPrReviewRun,
} from "@/lib/workflow-hello-git-run-stream";
import type { WorkflowPrReviewFinalOutput } from "@/workflows/hello-git";

type RunStartResponse = {
  runId: string;
};

type ApiError = {
  error: string;
};

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

type RunStatusResponse = {
  runId: string;
  status: "pending" | "running" | "completed" | "succeeded" | "failed" | "cancelled" | "unknown";
  finalOutput?: WorkflowPrReviewFinalOutput;
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

const orderedSteps: WorkflowPrReviewStep[] = [
  "ensure_workspace",
  "clone_repository",
  "fetch_pull_request",
  "checkout_pull_request",
  "run_codex_exec",
  "collect_report",
];

const stepLabels: Record<WorkflowPrReviewStep, string> = {
  ensure_workspace: "Ensure workspace",
  clone_repository: "Clone repository",
  fetch_pull_request: "Fetch pull request",
  checkout_pull_request: "Checkout pull request",
  run_codex_exec: "Run codex exec --yolo",
  collect_report: "Read report file and check logs",
};

function ReportList({ items, label }: { items: string[]; label: string }) {
  return (
    <div>
      <strong>{label}</strong>
      <ul style={{ margin: "0.45rem 0 0", paddingLeft: "1.15rem" }}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function CheckList({ output }: { output: WorkflowPrReviewFinalOutput["report"] }) {
  if (!output?.checks.length) {
    return null;
  }

  return (
    <div style={{ display: "grid", gap: "0.45rem" }}>
      <strong>Checks</strong>
      <div style={{ display: "grid", gap: "0.45rem" }}>
        {output.checks.map((check, index) => (
          <div
            key={`${check.label}-${check.command}-${index}`}
            style={{
              border: "1px solid #d0d7de",
              borderRadius: 10,
              padding: "0.7rem 0.8rem",
              background: "#f8fafc",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
              <strong>{check.label}</strong>
              <span>{check.outcome}</span>
            </div>
            <pre style={{ margin: "0.45rem 0 0", whiteSpace: "pre-wrap" }}>{check.command}</pre>
            {check.note ? (
              <div style={{ marginTop: "0.35rem", color: "#4b5563" }}>{check.note}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultOutput({ output }: { output: WorkflowPrReviewFinalOutput }) {
  const report = output.report;

  return (
    <section style={{ display: "grid", gap: "0.75rem" }}>
      <div
        style={{
          display: "grid",
          gap: "0.45rem",
          padding: "0.9rem",
          border: "1px solid #d0d7de",
          borderRadius: 10,
          background: "#fff",
        }}
      >
        <div>
          <strong>PR</strong>
          <div>{output.prUrl}</div>
        </div>
        <div>
          <strong>Workspace</strong>
          <div>{output.workspaceId}</div>
        </div>
        <div>
          <strong>Pull request</strong>
          <div>
            {output.repo}#{output.pullNumber}
          </div>
        </div>
        <div>
          <strong>Reviewed revision</strong>
          <div>{output.headSha}</div>
        </div>
        <div>
          <strong>Requested at</strong>
          <div>{output.requestedAt}</div>
        </div>
        <div>
          <strong>Checkout cloned</strong>
          <div>{output.clonePerformed ? "yes" : "reused"}</div>
        </div>
        <div>
          <strong>Codex exit code</strong>
          <div>{output.codexExitCode}</div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: "0.55rem",
          padding: "0.9rem",
          border: "1px solid #d0d7de",
          borderRadius: 10,
          background: "#fff",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Report</h2>
        <p style={{ margin: 0 }}>
          {report?.summary ??
            "Codex did not produce a structured report. Inspect the checked log files below."}
        </p>
        <div style={{ marginTop: "0.45rem", display: "grid", gap: "0.45rem" }}>
          <CheckList output={report} />
          {report?.notes?.length ? <ReportList items={report.notes} label="Notes" /> : null}
          {report?.files?.length ? (
            <div>
              <strong>Interesting files</strong>
              <ul style={{ margin: "0.45rem 0 0", paddingLeft: "1.15rem" }}>
                {report.files.map((file) => (
                  <li key={file.path}>
                    <div>{file.path}</div>
                    <div style={{ color: "#4b5563" }}>{file.description}</div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: "0.75rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))",
        }}
      >
        <div
          style={{
            padding: "0.9rem",
            border: "1px solid #d0d7de",
            borderRadius: 10,
            background: "#fff",
          }}
        >
          <h2 style={{ margin: "0 0 0.55rem", fontSize: "1.05rem" }}>
            Stdout file {output.stdoutExists ? "(present)" : "(missing)"}
          </h2>
          <pre style={{ margin: "0 0 0.55rem", whiteSpace: "pre-wrap" }}>{output.stdoutFile}</pre>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {output.stdoutTail || "No stdout tail captured."}
          </pre>
        </div>
        <div
          style={{
            padding: "0.9rem",
            border: "1px solid #d0d7de",
            borderRadius: 10,
            background: "#fff",
          }}
        >
          <h2 style={{ margin: "0 0 0.55rem", fontSize: "1.05rem" }}>
            Stderr file {output.stderrExists ? "(present)" : "(missing)"}
          </h2>
          <pre style={{ margin: "0 0 0.55rem", whiteSpace: "pre-wrap" }}>{output.stderrFile}</pre>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {output.stderrTail || "No stderr tail captured."}
          </pre>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: "0.55rem",
          padding: "0.9rem",
          border: "1px solid #d0d7de",
          borderRadius: 10,
          background: "#fff",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>
          Report file {output.reportExists ? "(present)" : "(missing)"}
        </h2>
        <p style={{ margin: 0 }}>{output.reportFile}</p>
      </div>
    </section>
  );
}

function WorkflowOverview({ activeRun }: { activeRun: WorkflowPrReviewRun | null }) {
  const [expandedSteps, setExpandedSteps] = useState<
    Partial<Record<WorkflowPrReviewStep, boolean>>
  >({});
  const started = new Set<WorkflowPrReviewStep>();
  const completed = new Set<WorkflowPrReviewStep>();
  const latestStepDetail = new Map<WorkflowPrReviewStep, { detail?: string; ts: string }>();
  const liveCommandOutput = (activeRun?.events ?? []).filter(
    (event): event is Extract<WorkflowPrReviewRunEvent, { type: "live_command_output" }> =>
      event.type === "live_command_output",
  );

  for (const event of activeRun?.events ?? []) {
    if (event.type === "step") {
      latestStepDetail.set(event.step, {
        detail: event.detail,
        ts: event.ts,
      });
      if (event.status === "started") {
        started.add(event.step);
        continue;
      }

      completed.add(event.step);
      continue;
    }
  }

  useEffect(() => {
    if (liveCommandOutput.length === 0) {
      return;
    }

    setExpandedSteps((current) =>
      current.run_codex_exec === undefined ? { ...current, run_codex_exec: true } : current,
    );
  }, [liveCommandOutput.length]);

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
          const detail = latestStepDetail.get(step);
          const isCodexStep = step === "run_codex_exec";
          const hasLiveOutput = isCodexStep && liveCommandOutput.length > 0;
          const isExpanded = expandedSteps[step] ?? (state === "running" || hasLiveOutput);

          return (
            <details
              key={step}
              open={isExpanded}
              onToggle={(event) => {
                const nextOpen = event.currentTarget.open;
                setExpandedSteps((current) =>
                  current[step] === nextOpen ? current : { ...current, [step]: nextOpen },
                );
              }}
              style={{
                border: "1px solid #d0d7de",
                borderRadius: 8,
                background:
                  state === "done" ? "#eefbf3" : state === "running" ? "#eef4ff" : "#f8fafc",
              }}
            >
              <summary
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "1rem",
                  padding: "0.7rem 0.8rem",
                  cursor: "pointer",
                  listStyle: "none",
                }}
              >
                <span>{stepLabels[step]}</span>
                <strong>{state}</strong>
              </summary>
              <div
                style={{
                  display: "grid",
                  gap: "0.45rem",
                  padding: "0 0.8rem 0.8rem",
                  borderTop: "1px solid rgba(208, 215, 222, 0.75)",
                }}
              >
                {detail?.detail ? (
                  <div style={{ marginTop: "0.7rem", fontSize: "0.92rem" }}>{detail.detail}</div>
                ) : null}
                {detail ? (
                  <div style={{ fontSize: "0.8rem", color: "#4b5563" }}>{detail.ts}</div>
                ) : null}
                {isCodexStep ? (
                  <div
                    style={{
                      display: "grid",
                      gap: "0.45rem",
                      marginTop: detail ? "0.25rem" : "0.7rem",
                      padding: "0.55rem",
                      borderRadius: 8,
                      background: "#0b1020",
                      color: "#f8fafc",
                    }}
                  >
                    <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Live command output</div>
                    {liveCommandOutput.length > 0 ? (
                      liveCommandOutput.map((event) => (
                        <div
                          key={`${event.index}-${event.stream}`}
                          style={{ display: "grid", gap: "0.2rem" }}
                        >
                          <div style={{ fontSize: "0.76rem", color: "#94a3b8" }}>
                            {event.stream === "stdout" ? "STDOUT" : "STDERR"}
                          </div>
                          <pre
                            style={{
                              margin: 0,
                              whiteSpace: "pre-wrap",
                              fontSize: "0.84rem",
                              color: event.stream === "stderr" ? "#fca5a5" : "#f8fafc",
                            }}
                          >
                            {event.chunk}
                          </pre>
                        </div>
                      ))
                    ) : (
                      <div style={{ fontSize: "0.84rem", color: "#94a3b8" }}>
                        {state === "running" ? "Waiting for live output..." : "No live output."}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </details>
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

async function streamRunEvents(
  runId: string,
  startIndex: number,
  onEvent: (event: WorkflowPrReviewRunEvent) => void,
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

      onEvent(JSON.parse(trimmed) as WorkflowPrReviewRunEvent);
    }
  }
}

export default function HomePage() {
  const [prUrl, setPrUrl] = useState("https://github.com/giselles-ai/sandkit/pull/1");
  const [runId, setRunId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<RunStatusResponse["status"] | null>(null);
  const [runOutput, setRunOutput] = useState<WorkflowPrReviewFinalOutput | null>(null);
  const [activeRun, setActiveRun] = useState<WorkflowPrReviewRun | null>(null);

  const streamController = useRef<AbortController | null>(null);
  const activeRunRef = useRef<WorkflowPrReviewRun | null>(null);

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

    streamController.current = abort;

    const syncRunStatus = async () => {
      const response = await fetch(`/api/hello-git/runs/${encodeURIComponent(runId)}`, {
        cache: "no-store",
        signal: abort.signal,
      });
      const payload = (await response.json()) as RunStatusResponse | ApiError;
      if (!response.ok) {
        throw new Error(isApiError(payload) ? payload.error : "Run lookup failed.");
      }
      if (isApiError(payload)) {
        throw new Error(payload.error);
      }

      setStatus(payload.status);
      if (payload.finalOutput) {
        setRunOutput(payload.finalOutput);
      }
      if (payload.error) {
        setError(payload.error.message);
      }
      if (isRunStatusTerminal(payload.status)) {
        setBusy(false);
      }
    };

    const openStream = async () => {
      const startIndex = nextStreamStartIndex(activeRunRef.current, runId);

      try {
        await streamRunEvents(
          runId,
          startIndex,
          (event) => {
            setActiveRun((current) => applyRunEventToState(runId, event, current));
          },
          abort.signal,
        );
      } catch (streamError) {
        if (abort.signal.aborted) {
          return;
        }

        if (
          streamError instanceof StreamOpenError &&
          isStreamOpenFailureFatal(streamError.status)
        ) {
          throw streamError;
        }
      }

      await syncRunStatus();
      if (shouldReconnectForRunningRun(activeRunRef.current)) {
        await openStream();
      }
    };

    void openStream().catch((streamError) => {
      if (abort.signal.aborted) {
        return;
      }

      stopStream();
      setBusy(false);
      setError(streamError instanceof Error ? streamError.message : "Run monitoring failed.");
    });

    return () => {
      abort.abort();
      if (streamController.current === abort) {
        streamController.current = null;
      }
    };
  }, [runId, busy]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setStatus("pending");
    setRunOutput(null);
    setActiveRun(null);

    try {
      const response = await fetch("/api/hello-git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prUrl }),
      });
      const payload = (await response.json()) as RunStartResponse | ApiError;
      if (!response.ok) {
        throw new Error(isApiError(payload) ? payload.error : "Failed to start run.");
      }
      if (isApiError(payload)) {
        throw new Error(payload.error);
      }

      setRunId(payload.runId);
    } catch (submitError) {
      setBusy(false);
      setStatus("failed");
      setError(submitError instanceof Error ? submitError.message : "Failed to start run.");
    }
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "2rem",
        background: "linear-gradient(180deg, #f3f7fb 0%, #eef2f7 100%)",
        color: "#0f172a",
      }}
    >
      <div style={{ maxWidth: 1080, margin: "0 auto", display: "grid", gap: "1rem" }}>
        <section
          style={{
            display: "grid",
            gap: "0.85rem",
            padding: "1.1rem",
            border: "1px solid #d0d7de",
            borderRadius: 14,
            background: "#fff",
          }}
        >
          <h1 style={{ margin: 0 }}>PR Review In A Durable Sandbox</h1>
          <p style={{ margin: 0 }}>
            Submit a GitHub pull request URL, prepare a durable sandbox checkout, then let Codex run
            with <code>--yolo</code> inside that sandbox. The outer sandbox is the real execution
            boundary; this example shows how workflow can preserve the checkout and the resulting
            files durably.
          </p>

          <form
            onSubmit={(event) => void onSubmit(event)}
            style={{ display: "grid", gap: "0.7rem" }}
          >
            <label style={{ display: "grid", gap: "0.35rem" }}>
              <span>Pull request URL</span>
              <input
                value={prUrl}
                onChange={(event) => setPrUrl(event.target.value)}
                placeholder="https://github.com/<owner>/<repo>/pull/<number>"
                style={{
                  width: "100%",
                  padding: "0.75rem 0.8rem",
                  border: "1px solid #d0d7de",
                  borderRadius: 10,
                }}
              />
            </label>
            <button
              type="submit"
              disabled={busy || !prUrl.trim()}
              style={{
                width: "fit-content",
                padding: "0.7rem 1rem",
                borderRadius: 999,
                border: "none",
                background: "#0f172a",
                color: "#fff",
                cursor: busy ? "wait" : "pointer",
              }}
            >
              {busy ? "Running..." : "Run Codex review"}
            </button>
          </form>

          <div style={{ display: "grid", gap: "0.25rem" }}>
            <div>
              status: <strong>{status ? statusText[status] : "idle"}</strong>
            </div>
            {runId ? (
              <div>
                run id: <code>{runId}</code>
              </div>
            ) : null}
            {error ? <div style={{ color: "#b42318" }}>{error}</div> : null}
          </div>
        </section>

        <div style={{ display: "grid", gap: "1rem", alignItems: "start" }}>
          <WorkflowOverview activeRun={activeRun} />
        </div>

        {runOutput ? <ResultOutput output={runOutput} /> : null}
      </div>
    </main>
  );
}
