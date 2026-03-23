"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

import { type TrackedRepository, type TriageRunSummary, type SubjectType } from "@/lib/triage-service";

type RepositoryResponse = {
  repositories: TrackedRepository[];
};

type RunsResponse = {
  runs: TriageRunSummary[];
};

type ErrorPayload = { error: string };

function formatDate(value: Date) {
  return new Date(value).toLocaleString();
}

function formatStatus(value: string): string {
  return value === "failed" ? "failed" : value;
}

function statusClass(value: string) {
  return value === "failed" ? "status failed" : "status";
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const payload = (await response.json()) as ErrorPayload;
    throw new Error(payload.error ?? "Request failed");
  }

  return (await response.json()) as T;
}

export default function HomePage() {
  const [repositories, setRepositories] = useState<TrackedRepository[]>([]);
  const [runs, setRuns] = useState<TriageRunSummary[]>([]);
  const [slug, setSlug] = useState("");
  const [runRepoId, setRunRepoId] = useState("");
  const [subjectType, setSubjectType] = useState<SubjectType>("issue");
  const [subjectNumber, setSubjectNumber] = useState("1");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadRepos() {
    const payload = await fetchJson<RepositoryResponse>("/api/repositories");
    setRepositories(payload.repositories);
  }

  async function loadRuns() {
    const payload = await fetchJson<RunsResponse>("/api/runs");
    setRuns(payload.runs);
  }

  async function loadAll() {
    setLoading(true);
    try {
      await Promise.all([loadRepos(), loadRuns()]);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function onRegisterRepo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextSlug = slug.trim().toLowerCase();
    if (!nextSlug) {
      setError("Repository slug is required.");
      return;
    }

    try {
      const payload = await fetchJson<{ repository: TrackedRepository }>("/api/repositories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: nextSlug }),
      });
      setRepositories((current) => [payload.repository, ...current]);
      setSlug("");
      if (!runRepoId) {
        setRunRepoId(payload.repository.id);
      }
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to register repository.");
    }
  }

  async function onCreateRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runRepoId) {
      setError("Select a repository first.");
      return;
    }

    const nextSubjectNumber = Number(subjectNumber);
    if (!Number.isInteger(nextSubjectNumber) || nextSubjectNumber <= 0) {
      setError("Subject number must be positive.");
      return;
    }

    try {
      const payload = await fetchJson<{ run: TriageRunSummary }>("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackedRepositoryId: runRepoId,
          subjectType,
          subjectNumber: nextSubjectNumber,
          notes: notes.trim() || null,
        }),
      });
      setRuns((current) => [payload.run, ...current]);
      setError(null);
      setNotes("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to start triage run.");
    }
  }

  return (
    <main className="page-root">
      <header className="card">
        <h1 className="title">GitHub Triage Control Plane</h1>
        <p className="muted">
          Durable SaaS-style workflow: tracked repos are tied to Sandkit workspaces and triage runs execute as
          chained <code>runCommand()</code> steps.
        </p>
      </header>

      {loading ? <p className="muted">Loading...</p> : null}
      {error ? <p className="message">{error}</p> : null}

      <section className="card">
        <h2 className="title" style={{ fontSize: "1.2rem" }}>
          Register repository
        </h2>
        <form onSubmit={onRegisterRepo} className="grid two">
          <div className="field">
            <label htmlFor="slug">Repository (owner/repo)</label>
            <input id="slug" value={slug} onChange={(event) => setSlug(event.target.value)} />
          </div>
          <div className="field">
            <button type="submit">Save Repository</button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2 className="title" style={{ fontSize: "1.2rem" }}>
          Start triage run
        </h2>
        <form onSubmit={onCreateRun} className="grid two">
          <div className="field">
            <label htmlFor="runRepo">Tracked repository</label>
            <select
              id="runRepo"
              value={runRepoId}
              onChange={(event) => setRunRepoId(event.target.value)}
              required
            >
              <option value="">Select repository</option>
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.slug}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="subjectType">Subject Type</label>
            <select
              id="subjectType"
              value={subjectType}
              onChange={(event) => setSubjectType(event.target.value as SubjectType)}
            >
              <option value="issue">issue</option>
              <option value="pull_request">pull_request</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="subjectNumber">Issue / PR number</label>
            <input
              id="subjectNumber"
              inputMode="numeric"
              value={subjectNumber}
              onChange={(event) => setSubjectNumber(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="notes">Notes</label>
            <input id="notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
          <div className="field">
            <button type="submit">Run triage</button>
          </div>
        </form>
      </section>

      <section className="card">
        <div className="toolbar">
          <h2 className="title" style={{ fontSize: "1.2rem", margin: 0 }}>
            Tracked repositories
          </h2>
          <button type="button" className="warn" onClick={() => void loadRepos()}>
            Refresh
          </button>
        </div>
        <div className="list">
          {repositories.map((repository) => (
            <article className="list-item" key={repository.id}>
              <strong>{repository.slug}</strong>
              <p className="muted small">last synced: {formatDate(repository.last_synced_at ?? repository.updated_at)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="toolbar">
          <h2 className="title" style={{ fontSize: "1.2rem", margin: 0 }}>
            Triage runs
          </h2>
          <button type="button" onClick={() => void loadRuns()}>
            Refresh
          </button>
        </div>
        <div className="list">
          {runs.map((run) => (
            <article key={run.id} className="list-item">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>
                  {run.slug} / {run.subject_type} #{run.subject_number}
                </strong>
                <span className={statusClass(run.status)}>{formatStatus(run.status)}</span>
              </div>
              <p className="muted small">
                {run.status} · {formatDate(run.created_at)} · {run.finished_at ? "finished" : "running"}
              </p>
              {run.notes ? <p className="small">{run.notes}</p> : null}
              <p>
                <Link href={`/triage/${encodeURIComponent(run.id)}`}>View details</Link>
              </p>
            </article>
          ))}
          {!runs.length ? <p className="muted small">No runs yet.</p> : null}
        </div>
      </section>
    </main>
  );
}
