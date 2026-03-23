"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";

import type {
  MergeReadinessWorkspaceDetails,
  TopReviewSummary,
} from "@/lib/merge-readiness-service";
import { type MergeReadinessSessionRecord } from "@/lib/merge-readiness-store";

type WorkspacePayload = MergeReadinessWorkspaceDetails & {
  reviews: TopReviewSummary[];
  sessions: MergeReadinessSessionRecord[];
};

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Operation failed.";
}

function formatTime(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleString();
}

function sessionStatusClass(status: string): string {
  if (status === "completed") {
    return "tag badge-ready";
  }
  if (status === "failed" || status === "interrupted") {
    return "tag badge-failed";
  }
  return "tag";
}

async function loadWorkspace(workspaceId: string): Promise<WorkspacePayload> {
  const response = await fetch(
    `/api/merge-readiness/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      cache: "no-store",
    },
  );

  const payload = (await response.json()) as WorkspacePayload | { error: string };
  if (!response.ok || "error" in payload) {
    throw new Error("error" in payload ? payload.error : "Failed to load workspace.");
  }

  return payload;
}

async function runWorkspace(workspaceId: string, prUrl: string) {
  const response = await fetch(
    `/api/merge-readiness/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prUrl }),
    },
  );

  const payload = (await response.json()) as
    | { reviewId: string; started: boolean }
    | { error: string };
  if (!response.ok || "error" in payload) {
    throw new Error("error" in payload ? payload.error : "Failed to run.");
  }

  return payload;
}

export default function Page({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const rows = await loadWorkspace(workspaceId);
      setWorkspace(rows);
    } catch (loadError) {
      setError(asErrorMessage(loadError));
    } finally {
      setBusy(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRun = useCallback(async () => {
    if (!workspace?.reviews[0]?.pr_url) {
      setError("No PR attached to this workspace.");
      return;
    }

    setRunning(true);
    setError(null);
    try {
      await runWorkspace(workspaceId, workspace.reviews[0].pr_url);
      await refresh();
    } catch (runError) {
      setError(asErrorMessage(runError));
    } finally {
      setRunning(false);
    }
  }, [workspaceId, workspace, refresh]);

  return (
    <div className="grid">
      <section className="panel">
        <h1 className="title">Workspace {workspaceId}</h1>
        <p className="subtitle">Inspect durable workspace state and run a pass for its PR.</p>
        <div className="row" style={{ marginTop: "0.8rem" }}>
          <button
            className="button primary"
            type="button"
            disabled={running || !workspace?.reviews.length}
            onClick={() => void onRun()}
          >
            {running ? "Running..." : "run another pass"}
          </button>
          {busy && <p className="status">Loading...</p>}
          {error && <p className="error">{error}</p>}
        </div>
      </section>

      <section className="grid two-col">
        <section className="panel">
          <h2 className="section-title">inspect</h2>
          {workspace && (
            <dl className="facts">
              <dt>Status</dt>
              <dd>{workspace.descriptor.status}</dd>
              <dt>Created</dt>
              <dd>{formatTime(workspace.descriptor.createdAt)}</dd>
              <dt>Updated</dt>
              <dd>{formatTime(workspace.descriptor.updatedAt)}</dd>
              <dt>Active lease</dt>
              <dd>
                {workspace.activeLease
                  ? `${workspace.activeLease.remainingMs}ms remaining`
                  : "inactive"}
              </dd>
            </dl>
          )}
          {!workspace?.reviews.length && (
            <p className="muted">No review records for this workspace.</p>
          )}
          {workspace?.reviews.map((review) => (
            <div key={review.id} className="stack" style={{ marginBottom: "0.8rem" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <p style={{ margin: 0 }}>
                  {review.pr_owner}/{review.pr_repo}#{review.pr_number ?? "?"}
                </p>
                <span className="tag">{review.status}</span>
              </div>
              <a className="link" href={review.pr_url}>
                open pull request
              </a>
              <div className="row">
                <Link className="button ghost" href={`/review/${review.id}`}>
                  inspect review
                </Link>
              </div>
            </div>
          ))}
        </section>

        <section className="panel">
          <h2 className="section-title">run</h2>
          <p className="muted">
            Use the latest PR URL in this workspace to run another pass from the durable control.
          </p>
          {workspace?.reviews[0]?.pr_url && (
            <a className="copy-field" href={workspace.reviews[0].pr_url}>
              {workspace.reviews[0].pr_url}
            </a>
          )}
        </section>
      </section>

      <section className="panel">
        <h2 className="section-title">sessions</h2>
        {workspace?.sessions.length === 0 && <p className="muted">No sessions yet.</p>}
        <div className="stack" style={{ marginTop: "0.65rem" }}>
          {workspace?.sessions.map((session) => (
            <div key={session.id} className="row" style={{ justifyContent: "space-between" }}>
              <p style={{ margin: 0 }}>
                <span className={sessionStatusClass(session.status)}>{session.status}</span>
                <span style={{ marginLeft: "0.5rem" }}>{session.id}</span>
              </p>
              <div className="row">
                <Link className="button ghost" href={`/session/${session.id}`}>
                  inspect session
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
