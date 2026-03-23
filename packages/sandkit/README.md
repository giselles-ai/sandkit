# Sandkit

Sandkit is a TypeScript toolkit for building durable app workflows on Vercel Sandbox.

It keeps two paths explicit:

- `workspace.sandbox.runCommand(...)` for durable, one-command-at-a-time work
- `openSession()` / `attachSession()` for a live leased sandbox when you need an interactive process

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
