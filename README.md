# Sandkit

Sandkit makes Vercel Sandbox stateful.

Sandkit adds workspace state, session management, durable command execution, and resumable sandbox workflows to Vercel Sandbox.

It keeps two paths explicit:

- `workspace.sandbox.runCommand(...)` for durable, one-command-at-a-time work
- `openSession()` / `attachSession()` for a live leased sandbox when you need an interactive process

An active session is an exclusive workspace lease. While a live session is open, `runCommand()` is unavailable until you attach to that session or commit it.

Provider-specific behavior still matters, but the public API stays centered on workspaces, policies, and durable state.

## Problem

Vercel Sandbox is ephemeral by design. It does not give you durable workspaces, session lifecycle, or a clear boundary between one-shot commands and live attached execution.

- No built-in workspace identity or durable workspace state
- No session management abstraction for live attach / resume
- No durable command boundary for one-command-at-a-time work
- Teams end up rebuilding the same sandbox state and lifecycle layer around jobs, agents, and recovery flows

## Solution

Sandkit adds a workspace state layer on top of Vercel Sandbox:

- Persistent workspaces for sandbox state management
- Live session lifecycle with explicit attach / commit semantics
- Durable command execution through `runCommand(...)` for committed work
- Policy controls that stay part of workspace state
- Resumable sandbox workflows for long-running apps and control planes

## Positioning

| Tool                                  | Responsibility                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Vercel Sandbox                        | Ephemeral execution environment                                                                                          |
| Sandkit                               | State and lifecycle layer for sandboxed execution: workspaces, session lifecycle, durable command boundaries, and resume |
| Workflow engines / app control planes | Decide when and why work runs                                                                                            |

## Primary Use Case: Persistent Workspaces for AI Coding Agents

Sandkit is especially useful when an agent or long-running sandbox app needs to keep a workspace alive across runs, attach to a live process, expose a public URL, and commit progress durably.

## Install

```sh
npm install @giselles-ai/sandkit
```

With Drizzle:

```sh
npm install @giselles-ai/sandkit drizzle-orm
```

## Quick Start

> Migration note: `sandkit(...)` was renamed to `createSandkit(...)` and this package is not yet aliased.
> Callers must update imports and call sites from `sandkit` to `createSandkit` together.

```ts
import { Database } from "bun:sqlite";

import { createSandkit } from "@giselles-ai/sandkit";
import { createBunSqliteAdapter } from "@giselles-ai/sandkit/adapters/sqlite-bun";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

const database = new Database("./sandkit.sqlite");
const workspaceAdapter = createBunSqliteAdapter(database);

const sandkit = createSandkit({
  database: workspaceAdapter,
  sandbox: vercelSandbox({
    defaultTimeout: 60_000,
  }),
});

const workspace = await sandkit.createWorkspace({
  name: "hello-sandkit",
});

await workspace.sandbox.runCommand({
  command: "sh",
  args: ["-lc", "echo 'hello world' > ./hello.txt"],
});

const result = await workspace.sandbox.runCommand({
  command: "cat",
  args: ["./hello.txt"],
});

console.log(result.stdout.trim());
```

Set `VERCEL_OIDC_TOKEN` for local runs or `VERCEL_ACCESS_TOKEN` in CI before creating a Vercel-backed sandbox.

## Policies

Service presets read default credentials from the environment when the policy is applied:

- `codex()` reads `CODEX_API_KEY`
- `gemini()` reads `GEMINI_API_KEY`
- `github()` reads `GITHUB_TOKEN` and maps it through Vercel Sandbox firewall transforms:
  - `Authorization: Basic <base64(x-access-token:<token>)>` on requests to `github.com`, intended for Git-over-HTTPS operations
  - `Authorization: Bearer <token>` on requests to `api.github.com`
  - no Authorization header for `*.githubusercontent.com`

For one-off overrides, pass the secret only on that run:

```ts
await workspace.sandbox.runCommand({
  command: "node",
  args: ["./script.js"],
  policy: allowServices([codex({ apiKey: process.env.RUN_SCOPED_CODEX_API_KEY! })]),
});
```

Durable default policy belongs to the workspace. Set it when creating the workspace or update it later:

```ts
const workspace = await sandkit.createWorkspace({
  policy: allowServices([codex()]),
});

await workspace.setPolicy(allowServices([codex()]));
```

## Setup Bootstrap

`setup` is the shared bootstrap definition, not the materialized artifact.
It is optional.
When `setup` is provided, it is the shared bootstrap command, args, and required durable `policy`.
This produces adapter-scoped shared bootstrap state keyed by `adapter.id` + setup definition fingerprint.
Multiple Sandkit instances using the same adapter and setup definition can reuse the same shared bootstrap state.

`sandkit.bootstrap()` is an optional eager materialization step:

- it creates shared bootstrap state if missing,
- it leaves existing shared bootstrap state untouched,
- it does not open or validate a long-lived sandbox runtime for an existing shared bootstrap state.

Without `bootstrap()`, shared setup is still materialized lazily on first workspace use (first `runCommand(...)` or `openSession(...)` that needs it).
Stale or unusable shared bootstrap artifacts are detected and rebuilt in those workspace flows, not by `bootstrap()` alone.

`setup` durability is adapter-backed. With a persistent adapter such as Bun SQLite or Drizzle, the shared bootstrap survives process restarts. With the default in-memory adapter, it does not.

```ts
import { createSandkit, allowAll } from "@giselles-ai/sandkit";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

const sandkit = createSandkit({
  sandbox: vercelSandbox(),
  setup: {
    command: "sh",
    args: ["-lc", "npm ci"],
    policy: allowAll(),
  },
});

await sandkit.bootstrap();
// Optional: omit bootstrap() and let setup run lazily on first workspace use.
const workspace = await sandkit.createWorkspace({
  name: "bootstrapped-workspace",
});
```

## Live Sessions

Use a session only when you need a running process or a public URL:

```ts
const workspace = await sandkit.createWorkspace({
  sandbox: {
    exposedPorts: [3000],
  },
});

const session = await workspace.sandbox.openSession();

await session.exec({
  command: "sh",
  args: ["-lc", "python3 -m http.server 3000"],
});

const url = await session.url(3000);
await session.commit();
```

Declare `exposedPorts` on the workspace only when you intend to publish a live session URL. Keep `defaultTimeout` as the provider-level lease default, and use `openSession({ timeoutMs })` when a specific live session needs a different timeout.

`runCommand()` and a live session are intentionally separate. If a session is active, attach to it or commit it before running another durable command.

## Configuration

Provide a `sandbox` provider explicitly (for example `vercelSandbox(...)`).
If you omit `database`, Sandkit defaults to the in-memory adapter.

## Drizzle Adapter

The generated schema exports the canonical workspace table as `sandkitWorkspaces`.

```ts
import { createSandkit, allowServices, codex } from "@giselles-ai/sandkit";
import { drizzleAdapter } from "@giselles-ai/sandkit/adapters/drizzle";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";
import { db, schema } from "@/db";

const sandkit = createSandkit({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    workspaces: schema.sandkitWorkspaces,
  }),
  sandbox: vercelSandbox(),
});
```

Generate schema:

```sh
npx @giselles-ai/sandkit generate --adapter drizzle --provider sqlite
npx drizzle-kit generate
```

If you already have a Drizzle repo, provider discovery can infer the dialect:

```sh
npx @giselles-ai/sandkit generate
```

## Examples

- [`examples/workflow-hello-git`](examples/workflow-hello-git) shows a minimal Next.js + Workflow DevKit flow where Workflow orchestrates durable `workspace.sandbox.runCommand(...)` steps.
- [`examples/sandbox-openclaw`](examples/sandbox-openclaw) shows a production-oriented live session flow with OpenClaw on Vercel Sandbox.
- [`smoke/drizzle-sample`](smoke/drizzle-sample) shows schema generation and Drizzle integration.

## Status

Sandkit is still early, but the core paths are already exercised in local smoke coverage:

- workspace create and reload
- durable `runCommand()` execution
- workspace policy and per-run override
- Drizzle schema generation
- live session lifecycle on Vercel Sandbox
