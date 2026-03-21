# sandbox-openclaw

A production-oriented sample showing how to run OpenClaw on Vercel Sandbox through Sandkit.

- Creates a single OpenClaw workspace once.
- Keeps sandbox bootstrapping in durable `runCommand()` commands.
- Persists durable bootstrap completion state in workspace metadata.
- Uses `openSession()` for the live phase where OpenClaw actually runs.
- Uses `attachSession()`, `extendTimeout()`, and `commit()` from the session handle.
- Persists Sandkit metadata with `drizzle` + `sqlite`.
- Rewrites OpenClaw Control UI config during `startSession()` so `allowedOrigins` is the exact public sandbox origin, not `["*"]`.
- Uses `gateway.controlUi.dangerouslyDisableDeviceAuth=true` so tokenized remote Control UI access works inside the sandbox example. This is a deliberate security downgrade for the example flow.

Note: `Start Session` does not repair missing bootstrap state. If the workspace does not have valid bootstrap state,
recreate the workspace to repair and bootstrap it again.

In this example, `commit()` is treated as the durable checkpoint that ends the current live session. Provider behavior may differ, but on the current Vercel Sandbox flow the session should be considered finished after commit.

## Setup

```bash
cd packages/sandkit
bun run build

cd ../examples/sandbox-openclaw
bun install
bun run db:generate
bun run db:migrate
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

Schema generation and migration:

```bash
npx sandkit generate --adapter drizzle --dialect sqlite
bun run db:generate
bun run db:migrate
bun run db:reset   # remove legacy sqlite and run migration from scratch
```

If migration fails with `no such table` or `already exists`, the local DB state is usually out of sync:

```bash
bun run db:reset
```

`db:reset` removes `data/openclaw.sqlite` and reruns `db:migrate`.
