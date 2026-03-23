"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { TopReviewSummary } from "@/lib/merge-readiness-service";

type TopApiResponse = {
  reviews: TopReviewSummary[];
};

type TopActionResult = {
  review: TopReviewSummary;
  workspaceId?: string;
  started?: boolean;
};

type ErrorPayload = {
  error: string;
};

function statusClass(status: string): string {
  if (status === "ready") {
    return "tag badge-ready";
  }

  if (status === "blocked") {
    return "tag badge-blocked";
  }

  if (status === "failed" || status === "interrupted" || status === "cancelled") {
    return "tag badge-failed";
  }

  return "tag";
}

const RESUMABLE_STATUSES = new Set(["requested", "monitoring", "running"]);

function canResumeReview(status: string): boolean {
  return RESUMABLE_STATUSES.has(status);
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Operation failed.";
}

async function loadDashboard(): Promise<TopReviewSummary[]> {
  const response = await fetch("/api/merge-readiness", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to load dashboard.");
  }
  const payload = (await response.json()) as TopApiResponse;
  return payload.reviews;
}

async function requestReview(prUrl: string): Promise<TopActionResult> {
  const response = await fetch("/api/merge-readiness", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "request", prUrl }),
  });

  const payload = (await response.json()) as TopActionResult | ErrorPayload;
  if (!response.ok || "error" in payload) {
    throw new Error("error" in payload ? payload.error : "Unable to request investigation.");
  }

  return payload;
}

async function resumeReview(reviewId: string): Promise<TopActionResult> {
  const response = await fetch("/api/merge-readiness", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "resume", reviewId }),
  });

  const payload = (await response.json()) as TopActionResult | ErrorPayload;
  if (!response.ok || "error" in payload) {
    throw new Error("error" in payload ? payload.error : "Unable to resume investigation.");
  }

  return payload;
}

export default function Page() {
  const [reviews, setReviews] = useState<TopReviewSummary[]>([]);
  const [prUrl, setPrUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const rows = await loadDashboard();
    setReviews(rows);
  }, []);

  useEffect(() => {
    void refresh().catch((nextError) => {
      setError(asErrorMessage(nextError));
    });
  }, [refresh]);

  const onRequest = useCallback(async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await requestReview(prUrl);
      setMessage(
        result.started
          ? "Review requested. Monitoring has started."
          : "Existing investigation is active. Monitoring resumed.",
      );
      setPrUrl("");
      await refresh();
    } catch (nextError) {
      setError(asErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }, [prUrl, refresh]);

  const onResume = useCallback(
    async (reviewId: string) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await resumeReview(reviewId);
        setMessage("Review resumed.");
        await refresh();
      } catch (nextError) {
        setError(asErrorMessage(nextError));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <div className="grid">
      <section className="panel">
        <h1 className="title">Merge Readiness</h1>
        <p className="subtitle">
          Request a merge-readiness review for a GitHub pull request and observe the evidence-driven
          recommendation.
        </p>

        <div className="row" style={{ marginTop: "0.9rem" }}>
          <input
            className="input"
            value={prUrl}
            onChange={(event) => setPrUrl(event.target.value)}
            placeholder="https://github.com/<owner>/<repo>/pull/<number>"
            aria-label="Pull request URL"
          />
          <button
            className="button primary"
            type="button"
            disabled={busy || !prUrl.trim()}
            onClick={() => void onRequest()}
          >
            Request a review
          </button>
        </div>

        {error && <p className="error status">{error}</p>}
        {message && <p className="status">{message}</p>}
      </section>

      <section className="panel">
        <h2 className="section-title">Recent investigations</h2>
        <div className="stack" style={{ marginTop: "0.75rem" }}>
          {reviews.length === 0 && (
            <p className="muted status">No reviews yet. Request one from the form above.</p>
          )}

          {reviews.map((review) => (
            <div key={review.id} className="panel">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <p style={{ margin: 0 }}>
                    <strong>#{review.pr_number ?? "?"}</strong>
                    <span style={{ marginLeft: "0.45rem" }}>{review.pr_title}</span>
                  </p>
                  <dl className="facts">
                    <dt>Status</dt>
                    <dd>
                      <span className={statusClass(review.status)}>{review.status}</span>
                    </dd>
                  </dl>
                  <a className="link" href={review.pr_url}>
                    {review.pr_url}
                  </a>
                </div>

                <div className="row">
                  <Link className="button ghost" href={`/review/${review.id}`}>
                    monitor
                  </Link>
                  {canResumeReview(review.status) && (
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={() => void onResume(review.id)}
                    >
                      resume
                    </button>
                  )}
                  {review.workspace_id && (
                    <Link className="button ghost" href={`/workspace/${review.workspace_id}`}>
                      inspect workspace
                    </Link>
                  )}
                </div>
              </div>
              {review.evidenceItems.length > 0 && (
                <p className="muted">Latest signal: {review.evidenceItems.at(-1)}</p>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
