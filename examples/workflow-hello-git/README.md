# PR Review In A Durable Sandbox (`workflow-hello-git`)

Small Next.js + Workflow DevKit example showing how a workflow can durably run `codex exec --yolo` against a GitHub pull request in an isolated sandbox.

The workflow keeps the durable unit visible in `workspace.sandbox.runCommand(...)`.

Users submit a GitHub pull request URL from UI. The workflow does:

- resolve or create a durable workspace for that pull request URL
- clone or reuse the repository checkout
- fetch and checkout the PR head into the durable workspace
- run `codex exec --yolo --skip-git-repo-check` inside an isolated sandbox
- read the report file, verify the stdout/stderr files, and return their paths plus log tails

The workflow does not try to hard-code project-specific lint/test/typecheck detection. Codex is allowed to inspect the repository, install dependencies, decide what checks make sense, and summarize what happened.

`--yolo` is used here because the example wants Codex to act without inner approval prompts or inner sandboxing. The restraint lives in the outer Vercel Sandbox managed by Sandkit. This is the point of the example: let Codex do a best-effort CI-style exploration, while the durable workspace preserves the checked-out revision and the files that Codex produced.

`session`, live URLs, and DB-backed dashboards are intentionally omitted.

## Quick Start

Build Sandkit first:

```sh
cd packages/sandkit
bun run build
```

Then move into the example:

```sh
cd examples/workflow-hello-git
```

Link and pull env for a Vercel project:

```sh
vercel link
vercel env pull
```

Set `CODEX_API_KEY` before running the example:

```sh
export CODEX_API_KEY=...
```

Optional for private repositories or higher GitHub API limits (not required for public PR URLs):

```sh
export GITHUB_TOKEN=...
```

Install dependencies and run:

```sh
bun install
bun run dev
```

Open <http://localhost:3000>.

## What To Look For

- The workflow is started via `POST /api/hello-git`.
- Run status is polled from `GET /api/hello-git/runs/[runId]`.
- Each durable boundary stays explicit:
  - ensure workspace
  - prepare pull request checkout
  - run Codex
  - read the report file and check the log files
- Shared Sandkit setup installs the Codex CLI once and reuses it across workspaces.

Workflow final output:

- `kind`, `workspaceId`, `prUrl`, `repo`, `pullNumber`, `headSha`, `clonePerformed`, `codexExitCode`
- `report` (`summary`, `checks`, optional `notes`, optional `files`)
- `stdoutFile`, `stderrFile`, `reportFile`, file-presence flags, log tails, `requestedAt`

## Files

- `app/page.tsx`: PR URL form, step timeline, result, checked revision, and file/log display
- `app/api/hello-git/route.ts`: start workflow API
- `app/api/hello-git/runs/[runId]/route.ts`: run status API
- `workflows/hello-git.ts`: durable PR review steps
- `lib/sandkit.ts`: fixed Sandkit runtime with shared Codex CLI setup
- `lib/workflow-hello-git-events.ts`: event and display-state types
- `lib/workflow-hello-git-run-stream.ts`: stream-state reducer
