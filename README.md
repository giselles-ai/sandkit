# Sandkit

Sandkit is a TypeScript toolkit for building durable app workflows on Vercel Sandbox.

It keeps two paths explicit:

- `workspace.sandbox.runCommand(...)` for durable, one-command-at-a-time work
- `openSession()` / `attachSession()` for a live leased sandbox when you need an interactive process

Provider-specific behavior still matters, but the public API stays centered on workspaces, policies, and durable state.

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

const result = await workspace.sandbox.runCommand({
  command: "cat",
  args: ["./hello.txt"],
});

console.log(result.stdout);
```

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

Durable default policy lives on the workspace:

```ts
await workspace.setPolicy(allowServices([codex()]));
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

## Drizzle Adapter

The generated schema exports the canonical workspace table as `sandkitWorkspaces`.

```ts
import { sandkit, allowServices, codex } from "sandkit";
import { drizzleAdapter } from "sandkit/adapters/drizzle";
import { db, schema } from "@/db";

const appSandkit = sandkit({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    workspaces: schema.sandkitWorkspaces,
  }),
  policy: allowServices([codex()]),
});
```

Generate schema:

```sh
npx sandkit generate --adapter drizzle --provider sqlite
npx drizzle-kit generate
```

If you already have a Drizzle repo, provider discovery can infer the dialect:

```sh
npx sandkit generate
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
