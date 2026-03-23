import Link from "next/link";

import { getReviewDetails, type MergeReadinessReviewDetails } from "@/lib/merge-readiness-service";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{
    reviewId: string;
  }>;
};

function statusLabel(status: string): string {
  if (status === "ready") {
    return "ready";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "interrupted") {
    return "interrupted";
  }
  return status;
}

function statusClass(status: string): string {
  if (status === "ready") {
    return "tag badge-ready";
  }
  if (status === "blocked") {
    return "tag badge-blocked";
  }
  if (status === "failed" || status === "interrupted") {
    return "tag badge-failed";
  }
  return "tag";
}

function formatTime(value: number | null | undefined): string {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

async function loadReview(reviewId: string): Promise<MergeReadinessReviewDetails> {
  return await getReviewDetails(reviewId);
}

function BulletList({ label, items }: { label: string; items: string[] }) {
  return (
    <section className="panel">
      <h2 className="section-title">{label}</h2>
      {items.length === 0 ? (
        <p className="muted">No items yet.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function Page({ params }: RouteParams) {
  const { reviewId } = await params;
  const review = await loadReview(reviewId);
  const latestSession = review.latestSession;

  return (
    <div className="grid">
      <section className="panel">
        <h1 className="title">Review {review.pr_number ? `#${review.pr_number}` : "record"}</h1>
        <p className="subtitle">{review.pr_title}</p>

        <div className="row" style={{ marginTop: "0.6rem" }}>
          <span className={statusClass(review.status)}>{statusLabel(review.status)}</span>
          <span className="tag">{review.verdict ?? "pending"}</span>
          <span className="tag">confidence: {review.confidence ?? "—"}</span>
        </div>
      </section>

      <section className="grid two-col">
        <section className="panel">
          <h2 className="section-title">inspect</h2>
          <dl className="facts">
            <dt>Repository</dt>
            <dd>{review.pr_repo}</dd>
            <dt>Owner</dt>
            <dd>{review.pr_owner}</dd>
            <dt>Workspace</dt>
            <dd>
              <Link className="link" href={`/workspace/${review.workspace_id}`}>
                {review.workspace_id}
              </Link>
            </dd>
            <dt>Last updated</dt>
            <dd>{formatTime(review.updated_at?.getTime())}</dd>
            <dt>PR URL</dt>
            <dd>
              <a className="link" href={review.pr_url}>
                open on GitHub
              </a>
            </dd>
          </dl>
        </section>

        <section className="panel">
          <h2 className="section-title">decide</h2>
          <p>
            <strong>Recommendation:</strong> {review.recommendation ?? "pending"}
          </p>
          <p>
            <strong>Verdict:</strong> {review.verdict ?? "pending"}
          </p>
          <p className="muted">Evidence and gaps are shown below.</p>
          <a
            className="button primary"
            href={latestSession ? `/session/${latestSession.id}` : "#"}
            style={{ display: "inline-block" }}
          >
            monitor session
          </a>
        </section>
      </section>

      <section className="grid two-col">
        <BulletList label="read evidence" items={review.evidenceItems} />
        <BulletList label="read questions" items={review.questions} />
      </section>

      {review.errorDetail && (
        <section className="panel">
          <h2 className="section-title">failure detail</h2>
          <pre className="code">{review.errorDetail}</pre>
        </section>
      )}

      <BulletList label="next actions" items={review.nextActions} />

      {latestSession && (
        <section className="panel">
          <h2 className="section-title">session</h2>
          <p className="muted">Most recent session id: {latestSession.id}</p>
          <a className="button" href={`/session/${latestSession.id}`}>
            open session
          </a>
        </section>
      )}
    </div>
  );
}
