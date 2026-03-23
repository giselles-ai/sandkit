import Link from "next/link";

import { getTriageRun, type TriageRunDetail } from "@/lib/triage-service";

type RouteParams = {
  params: Promise<{
    runId: string;
  }>;
};

type ReportSection = {
  summary: string;
  reproducibilityChecklist: readonly string[];
  labelCandidates: readonly string[];
  priorityCandidates: readonly string[];
  assigneeCandidates: readonly string[];
  verificationSuggestions: readonly string[];
};

type Artifact = {
  key: string;
  path: string;
  status: string;
};

function formatDate(value: Date | string | null | undefined): string {
  if (!value) {
    return "-";
  }

  if (typeof value === "string") {
    return new Date(value).toLocaleString();
  }

  return value.toLocaleString();
}

function statusClass(status: string): string {
  return status === "failed" ? "status failed" : "status";
}

function parseReportMarkdown(markdown: string): ReportSection {
  const sections = {
    summary: "",
    reproducibilityChecklist: [] as string[],
    labelCandidates: [] as string[],
    priorityCandidates: [] as string[],
    assigneeCandidates: [] as string[],
    verificationSuggestions: [] as string[],
  };

  const lines = markdown.split("\n").map((line) => line.trim());
  let section: keyof ReportSection | null = null;

  for (const line of lines) {
    if (line === "## Short Summary") {
      section = "summary";
      continue;
    }

    if (line === "## Reproducibility Checklist") {
      section = "reproducibilityChecklist";
      continue;
    }

    if (line === "## Label Candidates") {
      section = "labelCandidates";
      continue;
    }

    if (line === "## Priority Candidates") {
      section = "priorityCandidates";
      continue;
    }

    if (line === "## Assignee Candidates") {
      section = "assigneeCandidates";
      continue;
    }

    if (line === "## Verification Suggestions") {
      section = "verificationSuggestions";
      continue;
    }

    if (line.startsWith("## ") || line.startsWith("- Repository:") || line.startsWith("- Subject:") || line.startsWith("- Title:") || line.startsWith("- Labels:") || line.startsWith("- URL:") || line.startsWith("- Generated:") || line.startsWith("## Source Body")) {
      section = null;
      continue;
    }

    if (!section || !line) {
      continue;
    }

    if (line.startsWith("- ")) {
      if (section === "reproducibilityChecklist") {
        sections.reproducibilityChecklist.push(line.slice(2));
      }
      if (section === "labelCandidates") {
        sections.labelCandidates.push(line.slice(2));
      }
      if (section === "priorityCandidates") {
        sections.priorityCandidates.push(line.slice(2));
      }
      if (section === "assigneeCandidates") {
        sections.assigneeCandidates.push(line.slice(2));
      }
      if (section === "verificationSuggestions") {
        sections.verificationSuggestions.push(line.slice(2));
      }
      continue;
    }

    if (section === "summary") {
      sections.summary = sections.summary ? `${sections.summary}\n${line}` : line;
    }
  }

  return sections;
}

function artifactsFromSteps(steps: TriageRunDetail["steps"]): Artifact[] {
  return steps
    .map((step) => {
      if (!step.artifact_path) {
        return null;
      }

      const key = step.artifact_path.split("/").at(-1) ?? "artifact";
      return {
        key,
        path: step.artifact_path,
        status: step.status,
      };
    })
    .filter((row): row is Artifact => Boolean(row));
}

function formatArtifactState(status: string): string {
  if (status === "succeeded") {
    return "ready";
  }

  if (status === "running") {
    return "running";
  }

  if (status === "failed") {
    return "failed";
  }

  return "queued";
}

export const dynamic = "force-dynamic";

export default async function TriageRunPage({ params }: RouteParams) {
  const { runId } = await params;
  const run = await getTriageRun(runId);
  if (!run) {
    return (
      <main className="page-root">
        <section className="card">
          <h1 className="title">Run not found</h1>
          <p className="muted">
            <Link href="/">Back to triage control plane.</Link>
          </p>
        </section>
      </main>
    );
  }

  const latestReport = run.report_markdown ?? "";
  const parsedReport = latestReport ? parseReportMarkdown(latestReport) : null;
  const artifacts = artifactsFromSteps(run.steps);

  return (
    <main className="page-root">
      <section className="card">
        <div className="toolbar">
          <h1 className="title">
            {run.slug} {run.subject_type} #{run.subject_number}
          </h1>
          <Link href="/">← Home</Link>
        </div>
        <p className="muted small">
          Status: <span className={statusClass(run.status)}>{run.status}</span> / updated{" "}
          {formatDate(run.updated_at)}
        </p>
        <p className="muted small">
          Created {formatDate(run.created_at)} / finished {formatDate(run.finished_at)}
        </p>
        {run.error_message ? <p className="message">Error: {run.error_message}</p> : null}
      </section>

      <section className="card">
        <h2 className="title" style={{ fontSize: "1.2rem" }}>
          Report
        </h2>
        {latestReport ? (
          <>
            <p>
              <a href={`/api/runs/${encodeURIComponent(run.id)}/report`} target="_blank">
                Open raw markdown
              </a>
            </p>
            {parsedReport ? (
              <section className="list">
                <article className="list-item">
                  <h3 className="title" style={{ fontSize: "1rem", marginBottom: "0.4rem" }}>
                    Short Summary
                  </h3>
                  <p>{parsedReport.summary || "No summary."}</p>
                </article>
                <article className="list-item">
                  <h3 className="title" style={{ fontSize: "1rem", marginBottom: "0.4rem" }}>
                    Reproducibility Checklist
                  </h3>
                  <ul>
                    {parsedReport.reproducibilityChecklist.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
                <article className="list-item">
                  <h3 className="title" style={{ fontSize: "1rem", marginBottom: "0.4rem" }}>
                    Label Candidates
                  </h3>
                  <ul>
                    {parsedReport.labelCandidates.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
                <article className="list-item">
                  <h3 className="title" style={{ fontSize: "1rem", marginBottom: "0.4rem" }}>
                    Priority & Assignee Candidates
                  </h3>
                  <div className="row">
                    <div>
                      <strong>Priority</strong>
                      <ul>
                        {parsedReport.priorityCandidates.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <strong>Assignee</strong>
                      <ul>
                        {parsedReport.assigneeCandidates.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </article>
                <article className="list-item">
                  <h3 className="title" style={{ fontSize: "1rem", marginBottom: "0.4rem" }}>
                    Verification Suggestions
                  </h3>
                  <ul>
                    {parsedReport.verificationSuggestions.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
                <pre>{latestReport}</pre>
              </section>
            ) : (
              <pre>{latestReport}</pre>
            )}
          </>
        ) : (
          <p className="muted small">Report is not ready yet.</p>
        )}
      </section>

      <section className="card">
        <h2 className="title" style={{ fontSize: "1.2rem" }}>
          Workspace artifacts
        </h2>
        {artifacts.length ? (
          <div className="list">
            {artifacts.map((artifact) => (
              <article className="list-item" key={artifact.path}>
                <strong>{artifact.key}</strong>
                <p className="small muted">sandbox path: {artifact.path}</p>
                <p className="small">state: {formatArtifactState(artifact.status)}</p>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted small">No artifact records yet.</p>
        )}
      </section>

      <section className="card">
        <h2 className="title" style={{ fontSize: "1.2rem" }}>
          Steps
        </h2>
        <div className="list">
          {run.steps.map((step) => (
            <article className="list-item" key={step.id}>
              <strong>{step.step_name}</strong>{" "}
              <span className={statusClass(step.status)}>{step.status}</span>
              {step.command_exit_code !== null && step.command_exit_code !== undefined ? (
                <span className="muted small"> exit: {step.command_exit_code}</span>
              ) : null}
              <p className="small muted">artifact: {step.artifact_path ?? "-"}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
