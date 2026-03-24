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
> Callers must update imports and call sites from `sandkit` to `createSandkit`.

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

Declare `exposedPorts` on `createWorkspace({ sandbox: ... })` only when you need a live session URL. `defaultTimeout` is the provider-level lease default; override a specific live session with `openSession({ timeoutMs })`.

## Setup bootstrap

Pass setup to `createSandkit({ setup })` to seed a shared durable state used by all workspaces on the same adapter.
Each workspace starts from that shared bootstrap snapshot when no workspace-specific durable state exists.
Sandkit persists one shared bootstrap state per adapter and bootstrap definition (command + args + explicit setup policy), runs setup once per unique bootstrap definition, and reuses the matching state for subsequent workspaces.
If a shared bootstrap state is stale or unusable, Sandkit re-runs setup and persists a replacement.
By default setup runs under the workspace policy; set `setup.policy` when bootstrap needs broader access than steady-state execution.
Because setup becomes shared durable state, `setup.policy` must also be durable: explicit secret-bearing policies are rejected there.

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

const workspace = await sandkit.createWorkspace({
  name: "bootstrapped-workspace",
});
```

## Configuration

Provide a `sandbox` provider explicitly (for example `vercelSandbox(...)`).
If you do not pass `database`, Sandkit defaults to the in-memory adapter. That default is useful for local tests and internal development, but the primary published usage is an explicit Vercel provider plus a persistent adapter.

## Policies

- `codex()` reads `CODEX_API_KEY`
- `gemini()` reads `GEMINI_API_KEY`
- `github()` reads `GITHUB_TOKEN`
- `aiGateway()` reads `AI_GATEWAY_API_KEY` from host env and allows the hostname (plus wildcard) from `AI_GATEWAY_BASE_URL`.
  `AI_GATEWAY_BASE_URL` ports are ignored for allow-listing; only host/domain matches are used.

Durable default policy belongs to the workspace: use `createWorkspace({ policy: ... })` when you create it, or `workspace.setPolicy(...)` later. Pass `policy` to `runCommand(...)` for one-off overrides.

## Schema Generation

```sh
npx @giselles-ai/sandkit generate --adapter drizzle --provider sqlite
```

If the project already has a Drizzle setup, provider discovery can infer the dialect:

```sh
npx @giselles-ai/sandkit generate
```

## Examples

- `examples/sandbox-openclaw`
- `smoke/drizzle-sample`

Repository: [github.com/giselles-ai/sandkit](https://github.com/giselles-ai/sandkit)
