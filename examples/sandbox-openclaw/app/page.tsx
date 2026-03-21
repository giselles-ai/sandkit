"use client";

import { useCallback, useEffect, useState } from "react";

type OpenClawState = {
  hasWorkspace: boolean;
  workspaceId?: string;
  hasActiveSession: boolean;
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

async function fetchState(): Promise<StatePayload> {
  const response = await fetch("/api/openclaw", { method: "GET", cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to read control plane state.");
  }

  return (await response.json()) as StatePayload;
}

async function callAction(payload: Record<string, unknown>) {
  const response = await fetch("/api/openclaw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const next = (await response.json()) as StatePayload;
  if (!response.ok || next.error) {
    throw new Error(next.error ?? "Action failed.");
  }

  return next.state;
}

export default function Page() {
  const [state, setState] = useState<OpenClawState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const payload = await fetchState();
      setState(payload.state);
      setError(payload.error ?? null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load state.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 8_000);

    return () => window.clearInterval(timer);
  }, [refresh]);

  async function runAction(
    action: "createWorkspace" | "startSession" | "extendSession" | "commitSession",
    durationMs?: number,
  ) {
    if (busy) {
      return;
    }

    setBusy(action);
    setError(null);
    try {
      const nextState = await callAction({
        action,
        ...(durationMs === undefined ? {} : { durationMs }),
      });
      setState(nextState);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Action failed.");
      await refresh();
    } finally {
      setBusy(null);
    }
  }

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
        One workspace, one durable bootstrap path, one live session for OpenClaw operations. Session
        start does not repair bootstrap.
      </p>

      {!state.hasWorkspace ? (
        <section className="grid">
          <p className="status">
            Workspace is not created yet. This runs durable bootstrap in `runCommand` and installs
            OpenClaw into Vercel Sandbox.
          </p>
          <div className="row">
            <button
              className="button primary"
              type="button"
              disabled={busy === "createWorkspace"}
              onClick={() => void runAction("createWorkspace")}
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
                    disabled={busy === "startSession"}
                    onClick={() => void runAction("startSession")}
                  >
                    {busy === "startSession" ? "Repairing..." : "Repair OpenClaw UI"}
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
                <p className="status">
                  Active sandbox session found, but the public OpenClaw UI is not healthy. Repairing
                  restarts the gateway inside the current session.
                </p>
              ) : null}
              <CopyCommand value={state.connectCommand ?? `sandbox connect ${state.sandboxId}`} />
            </>
          ) : (
            <div className="row">
              <button
                className="button primary"
                type="button"
                disabled={busy === "startSession"}
                onClick={() => void runAction("startSession")}
              >
                {busy === "startSession" ? "Starting..." : "Start Session"}
              </button>
            </div>
          )}
        </section>
      )}

      {error ? <p className="error">Error: {error}</p> : null}
      <p className="status">
        {state.expiresAt ? `Session expires at: ${new Date(state.expiresAt).toLocaleString()}` : ""}
      </p>
    </section>
  );
}
