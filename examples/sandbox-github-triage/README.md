# sandbox-github-triage

This is a durable workflow example for SaaS-style GitHub PR / Issue triage. `sandbox-github-triage` demonstrates:

- A minimal app shape where you register tracked repositories from a web UI, then create and run triage runs.
- A four-step durable workflow centered on `workspace.sandbox.runCommand(...)`:
  - `sync-repo`
  - `collect-context`
  - `analyze`
  - `render-report`
- One workspace per repository, reused across repeated triage runs.
- An architecture that keeps both app-side DB state and Sandkit workspace state so run history and generated artifacts accumulate over time.
- A default policy of `allowServices([github(), codex()])`, making the boundary between GitHub retrieval and LLM analysis explicit.

## Data Model

- `triage_repositories`
  - `id`, `workspace_id`, `slug`, `default_branch`, `last_synced_at`
- `triage_runs`
  - Stores the target repository, subject, status, and generated report information
- `triage_steps`
  - Stores the result of each step in a run (`exitCode`, `stdout` / `stderr`, and artifact path)

## Reviewable Report

`/triage/<run-id>` presents the final report in a reviewable structure:

- short summary
- reproducibility checklist
- label candidates
- priority candidates
- assignee candidates
- verification suggestions

## Artifacts Inside the Workspace

Every `runCommand()` step writes durable artifacts under `/vercel/sandbox/home/triage/...`.

- `triage/repositories/<owner_repo>/`: cloned repository
- `triage/artifacts/<run-id>/context.json`: collected issue / PR context
- `triage/artifacts/<run-id>/analysis.json`: analysis input / output
- `triage/artifacts/<run-id>/report.md`: final Markdown report

The run detail page calls out the main artifact paths (`context.json`, `analysis.json`, and `report.md`) so the user can inspect the underlying materials during follow-up investigation.

## How It Differs from the OpenClaw Example

Unlike `examples/sandbox-openclaw`, which uses a live session (`openSession()`) for a long-running process, this example:

- splits execution into session-free `runCommand()` steps
- makes each step durable as an independent unit of work
- reuses the workspace so history and supporting materials accumulate

It is meant to show a durable-first SaaS operations workflow rather than a live control plane.

## Setup

```bash
cd packages/sandkit
bun run build

cd ../examples/sandbox-github-triage
bun install
bun run db:migrate
bun run db:generate
bun run dev
```

## Environment Variables

- `GITHUB_TOKEN` (optional): used for GitHub API calls
- `CODEX_API_KEY` (optional): used when the analyze step calls Codex
- `AI_GATEWAY_BASE_URL` (optional): defaults to `https://api.openai.com/v1`
- `CODEX_MODEL` (optional): model name for the analyze step; defaults to `gpt-4o-mini` and `gpt-5-mini` in CI
- `TRIAGE_CODEX_MODEL` (optional): alias for `CODEX_MODEL`
- `SANDBOX_RUNTIME` (optional): defaults to `node24`
- `SANDBOX_TIMEOUT_MS` (optional)
