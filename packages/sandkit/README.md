# Sandkit

Sandkit makes Vercel Sandbox stateful.

Sandkit adds workspace state, session management, durable command execution, and resumable sandbox workflows to Vercel Sandbox.

It keeps two paths explicit:

- `workspace.sandbox.runCommand(...)` for durable, one-command-at-a-time work
- `openSession()` / `attachSession()` for a live leased sandbox when you need an interactive process

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
npm install sandkit
```

With Drizzle:

```sh
npm install sandkit drizzle-orm
```

## Quick Start

```ts
import { sandkit, allowServices, codex, gemini } from "sandkit";
import { drizzleAdapter } from "sandkit/adapters/drizzle";
import { db } from "@/db";

const appSandkit = sandkit({
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  policy: allowServices([codex(), gemini()]),
});

const workspace = await appSandkit.createWorkspace();

await workspace.sandbox.runCommand({
  command: "sh",
  args: ["-lc", "echo 'hello world' > ./hello.txt"],
});
```

## Policies

- `codex()` reads `CODEX_API_KEY`
- `gemini()` reads `GEMINI_API_KEY`
- `github()` reads `GITHUB_TOKEN`

Use `workspace.setPolicy(...)` for the durable default, or pass `policy` to `runCommand(...)` for a one-off override.

## Schema Generation

```sh
npx sandkit generate --adapter drizzle --provider sqlite
```

If the project already has a Drizzle setup, provider discovery can infer the dialect:

```sh
npx sandkit generate
```

## Examples

- `examples/sandbox-openclaw`
- `smoke/drizzle-sample`

Repository: [github.com/giselles-ai/sandkit](https://github.com/giselles-ai/sandkit)
