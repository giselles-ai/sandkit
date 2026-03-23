# Merge Readiness

Production-oriented example showing how to combine Sandkit’s durable and live execution paths for PR readiness investigation.

## Goal

Users submit a GitHub PR URL.  
The app deterministically creates/reuses a workspace for that PR, runs a Codex-based investigation with PR/Repository context and check status, then reports:

- verdict (`safe_to_merge`, `unsafe_to_merge`, `needs_human_review`)
- recommendation (`approve`, `request_changes`, `investigate_further`, `needs_human`)
- evidence
- questions
- next actions

The app also lets operators monitor and resume ongoing investigations.

## Core flow

1. **Top page**: `request a merge-readiness review` from a PR URL.
2. **Runtime orchestration**:
   - **Durable phase** (`runCommand()`): fetch PR metadata, run baseline checks, download/extract the PR head tarball, bootstrap the Codex CLI, and prepare the workspace.
   - **Live phase** (`openSession()` + `startProcess()`): execute `codex` (`--yolo --json --skip-git-repo-check`) and write structured decision output.
3. **Post-run resolution**: read decision JSON and persist review/session state.
4. **Review and Workspace pages**: inspect evidence and status, run additional passes.
5. **Session page**: observe output, interrupt, or resume.

## Repo structure

- `lib/merge-readiness-app.ts`
  - runtime + database initialization + workspace root + policy.
- `lib/merge-readiness-store.ts`
  - typed persistence for `merge_readiness_reviews` and `merge_readiness_sessions`.
- `lib/merge-readiness-service.ts`
  - end-to-end service facade used by API routes and pages:
    - `requestReview`
    - `resumeReview`
    - `getReviewDetails`
    - `getWorkspaceDetail`
    - `getSessionState`
    - `interruptSession`
    - `resumeSession`
- `app/api/merge-readiness/*`
  - control-plane endpoints for dashboard/review/workspace/session operations.
- `app/page.tsx`, `app/review/[reviewId]/page.tsx`, `app/workspace/[workspaceId]/page.tsx`, `app/session/[sessionId]/page.tsx`
  - production-style screens matching the verb map.
- `drizzle` and `db/schema`
  - local sqlite schema used by this example.

## Setup

```bash
cd examples/merge-readiness
bun install
bun run db:migrate
bun run dev
```

You must have:

- GitHub/Codex access available for the sandbox environment via Sandkit policy.
- `codex` CLI installed in the execution environment.

## Environment Variables

Required for real investigations:

- `CODEX_API_KEY`
  - Used by the built-in Codex policy and by `codex exec` during the live investigation phase.
  - The example bootstraps the `@openai/codex` CLI durably before opening the live session.

Optional:

- `GITHUB_TOKEN`
  - Not required for public-repository investigations.
  - Required if you later adapt this example to download private repository contents or fetch private PR refs.
  - GitHub REST metadata/checks/status lookups are sent by sandboxed `curl` and rely on Sandkit's `github()` policy to inject the authorization header.

- `MR_WORKSPACE_ROOT`
  - Filesystem root where prepared workspaces are stored.
  - Default: `/vercel/sandbox/home/merge-readiness`
- `MR_SANDBOX_TIMEOUT_MS`
  - Session timeout in milliseconds for the Vercel Sandbox driver.
  - Default: `1200000` (20 minutes)
- `MR_REQUIRED_HEADER`
  - Extra request header value for deployments that require one around local app requests.
  - Default: empty

Example:

```bash
export GITHUB_TOKEN=...
export CODEX_API_KEY=...
export MR_WORKSPACE_ROOT=/vercel/sandbox/home/merge-readiness
export MR_SANDBOX_TIMEOUT_MS=1200000
```
