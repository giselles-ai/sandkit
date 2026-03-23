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

```ts
import { Database } from "bun:sqlite";

import { sandkit } from "@giselles-ai/sandkit";
import { createBunSqliteAdapter } from "@giselles-ai/sandkit/adapters/sqlite-bun";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";

const database = new Database("./sandkit.sqlite");
const workspaceAdapter = createBunSqliteAdapter(database);

const app = sandkit({
  database: workspaceAdapter,
  sandbox: vercelSandbox({
    timeout: 60_000,
  }),
});

const workspace = await app.createWorkspace({
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
- `github()` reads `GITHUB_TOKEN`

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
const workspace = await app.createWorkspace({
  policy: allowServices([codex()]),
});

await workspace.setPolicy(allowServices([codex()]));
```

## Setup Bootstrap

Pass setup to `sandkit({ setup })` to seed a shared durable state used by all workspaces on the same adapter.
Each workspace starts from that shared bootstrap snapshot when no workspace-specific durable state exists.
Sandkit persists one shared bootstrap state per adapter and bootstrap definition (command + args), runs setup once per unique bootstrap definition, and reuses the matching state for subsequent workspaces.
If a shared bootstrap state is stale or unusable, Sandkit re-runs setup and persists a replacement.

`setup` durability is adapter-backed. With a persistent adapter such as Bun SQLite or Drizzle, the shared bootstrap survives process restarts. With the default in-memory adapter, it does not.

```ts
const app = sandkit({
  setup: {
    command: "sh",
    args: ["-lc", "npm ci"],
  },
});
```

## Live Sessions

Use a session only when you need a running process or a public URL:

```ts
const session = await workspace.sandbox.openSession();

await session.exec({
  command: "sh",
  args: ["-lc", "python3 -m http.server 3000"],
});

const url = await session.url(3000);
await session.commit();
```

`runCommand()` and a live session are intentionally separate. If a session is active, attach to it or commit it before running another durable command.

## Configuration

Provide a `sandbox` provider explicitly (for example `vercelSandbox(...)`).
If you omit `database`, Sandkit defaults to the in-memory adapter.

## Drizzle Adapter

The generated schema exports the canonical workspace table as `sandkitWorkspaces`.

```ts
import { sandkit, allowServices, codex } from "@giselles-ai/sandkit";
import { drizzleAdapter } from "@giselles-ai/sandkit/adapters/drizzle";
import { vercelSandbox } from "@giselles-ai/sandkit/integrations/vercel";
import { db, schema } from "@/db";

const appSandkit = sandkit({
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

- [`examples/sandbox-openclaw`](/Users/satoshi/repo/giselles-ai/sandkit/examples/sandbox-openclaw) shows a production-oriented live session flow with OpenClaw on Vercel Sandbox.
- [`smoke/drizzle-sample`](/Users/satoshi/repo/giselles-ai/sandkit/smoke/drizzle-sample) shows schema generation and Drizzle integration.

## Status

Sandkit is still early, but the core paths are already exercised in local smoke coverage:

- workspace create and reload
- durable `runCommand()` execution
- workspace policy and per-run override
- Drizzle schema generation
- live session lifecycle on Vercel Sandbox
