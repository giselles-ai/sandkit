# workflow-hello-git

Small Next.js + Workflow DevKit example that shows how a workflow only orchestrates execution.

The durable behavior is in `workspace.sandbox.runCommand(...)`.

Users submit a GitHub repository (`org/name`) from UI. The workflow does:

- resolve or create a durable workspace for that repository
- clone the repository only if not already present
- run durable inspection commands in the checkout

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

Set `GITHUB_TOKEN` before running the example:

```sh
export GITHUB_TOKEN=...
```

Install dependencies and run:

```sh
bun install
bun run dev
```

Open <http://localhost:3000>.

## What to look for

- The workflow is started via `POST /api/hello-git`.
- Run status is polled from `GET /api/hello-git/runs/[runId]`.
- Each repository preparation step is a separate `workspace.sandbox.runCommand(...)` call in the workflow.

## Files

- `app/page.tsx`: simple UI for starting and polling a run
- `app/api/hello-git/route.ts`: start workflow API
- `app/api/hello-git/runs/[runId]/route.ts`: run status API
- `workflows/hello-git.ts`: durable workflow steps
- `lib/sandkit.ts`: example runtime setup and local durable store bootstrap
- `db/schema/sandkit.ts`: generated Sandkit core schema for the local sqlite store
