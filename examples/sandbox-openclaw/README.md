# sandbox-openclaw

A production-oriented sample showing how to run OpenClaw on Vercel Sandbox through Sandkit.

- Creates a single OpenClaw workspace once.
- Keeps sandbox bootstrapping in durable `runCommand()` calls.
- Uses `openSession()` for the live phase where OpenClaw actually runs.
- Uses `attachSession()`, `extendTimeout()`, and `commit()` from the session handle.
- Persists Sandkit metadata with `drizzle` + `sqlite`.

## Setup

```bash
cd /Users/satoshi/.codex/worktrees/921a/sandbox-devkit/packages/sandkit
bun run build

cd /Users/satoshi/.codex/worktrees/921a/sandbox-devkit/examples/sandbox-openclaw
bun install
bun dev
```

Required environment variables:

- `AI_GATEWAY_API_KEY`
- `AI_GATEWAY_BASE_URL` (default `https://ai-gateway.vercel.sh/v1`)
- `AI_GATEWAY_MODEL` (default `openai/gpt-5.4-mini`)
- `OPENCLAW_INSTALL_SPEC` (default `openclaw@latest`)
- `OPENCLAW_GATEWAY_PORT` (default `18789`)
- `OPENCLAW_WORKSPACE_ID` (optional, defaults `openclaw-production`)
- `SANDBOX_TIMEOUT_MS` (optional, default `1200000`)
