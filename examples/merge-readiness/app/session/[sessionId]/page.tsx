"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";

import type { MergeReadinessSessionState } from "@/lib/merge-readiness-service";

type ErrorPayload = {
  error: string;
};

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Operation failed.";
}

function formatTime(value: string | number | Date | null | undefined): string {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

function parseAction(raw: unknown): "interrupt" | "resume" | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const action = (raw as Record<string, unknown>).action;
  return action === "interrupt" || action === "resume" ? action : null;
}

async function loadSession(sessionId: string): Promise<MergeReadinessSessionState> {
  const response = await fetch(`/api/merge-readiness/sessions/${encodeURIComponent(sessionId)}`, {
    cache: "no-store",
  });
  const payload = (await response.json()) as MergeReadinessSessionState | ErrorPayload;
  if (!response.ok || "error" in payload) {
    throw new Error("error" in payload ? payload.error : "Failed to load session.");
  }
  return payload;
}

async function postAction(sessionId: string, action: "interrupt" | "resume") {
  const response = await fetch(`/api/merge-readiness/sessions/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const payload = (await response.json()) as MergeReadinessSessionState | ErrorPayload;
  if (!response.ok || "error" in payload) {
    throw new Error("error" in payload ? payload.error : "Action failed.");
  }
  return payload;
}

export default function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const router = useRouter();
  const { sessionId } = use(params);
  const [session, setSession] = useState<MergeReadinessSessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const value = await loadSession(sessionId);
      setSession(value);
    } catch (nextError) {
      setError(asErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 3000);

    return () => clearInterval(interval);
  }, [refresh]);

  const onAction = useCallback(
    async (rawAction: "interrupt" | "resume") => {
      setBusy(true);
      setError(null);
      try {
        const parsed = parseAction({ action: rawAction });
        if (parsed) {
          const next = await postAction(sessionId, parsed);
          setSession(next);
          if (parsed === "resume" && next.id !== sessionId) {
            router.push(`/session/${next.id}`);
            return;
          }
          await refresh();
        }
      } catch (nextError) {
        setError(asErrorMessage(nextError));
      } finally {
        setBusy(false);
      }
    },
    [router, sessionId, refresh],
  );

  return (
    <div className="grid">
      <section className="panel">
        <h1 className="title">Session monitor</h1>
        <p className="subtitle">observe, interrupt, resume</p>
        {busy && <p className="status">Syncing...</p>}
        {error && <p className="error">{error}</p>}
        {!session && !error && !busy && <p className="muted">No data yet.</p>}
      </section>

      {session && (
        <>
          <section className="panel">
            <h2 className="section-title">session</h2>
            <dl className="facts">
              <dt>status</dt>
              <dd>{session.status}</dd>
              <dt>workspace</dt>
              <dd>
                <Link className="link" href={`/workspace/${session.workspace_id}`}>
                  {session.workspace_id}
                </Link>
              </dd>
              <dt>review</dt>
              <dd>
                <Link className="link" href={`/review/${session.review_id}`}>
                  open review
                </Link>
              </dd>
              <dt>started</dt>
              <dd>{formatTime(session.started_at)}</dd>
              <dt>finished</dt>
              <dd>{formatTime(session.finished_at)}</dd>
              <dt>lease</dt>
              <dd>{session.sandboxActive ? `${session.leaseRemainingMs ?? 0}ms` : "inactive"}</dd>
            </dl>
            <div className="row">
              {session.status === "running" || session.status === "starting" ? (
                <button
                  className="button warn"
                  type="button"
                  disabled={busy}
                  onClick={() => void onAction("interrupt")}
                >
                  interrupt
                </button>
              ) : (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => void onAction("resume")}
                >
                  resume
                </button>
              )}
            </div>
          </section>

          <section className="panel">
            <h2 className="section-title">observe output</h2>
            <pre className="code">
              {session.outputSnippet ||
                session.stderrSnippet ||
                session.review?.error_message ||
                "No output yet."}
            </pre>
          </section>

          {session.stderrSnippet && (
            <section className="panel">
              <h2 className="section-title">stderr</h2>
              <pre className="code">{session.stderrSnippet}</pre>
            </section>
          )}
        </>
      )}
    </div>
  );
}
