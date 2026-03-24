# hello-sandkit

Minimal Sandkit sample that demonstrates the durable path:

- `createSandkit(...)`
- `createWorkspace(...)`
- `workspace.sandbox.runCommand(...)`

This example intentionally does not use `openSession()` / `attachSession()`.

## What this does

- Creates a durable workspace state store with Bun SQLite.
- Creates a Vercel-backed workspace.
- Runs one durable command that writes a file.
- Runs another durable command that reads it back.

This example demonstrates durable execution for the two commands within one run.

## Prerequisites

- Vercel CLI (`vercel`)
- Node.js and Bun.
- A linked Vercel project to provide local OIDC credentials.

## Dependency build step

This example consumes the package exports from `@giselles-ai/sandkit` (`dist/` entry points), so the library must be built first.

From the repo root:

```sh
cd packages/sandkit
bun run build
```

## Setup

1. Link to a Vercel project:

```sh
cd examples/hello-sandkit
vercel link
```

2. Pull local environment to create `.env.local` with project-backed OIDC credentials:

The project can be empty and only exists as authentication context.

`vercel link` connects this directory to a Vercel project, and `vercel env pull` writes local project-scoped credentials including `VERCEL_OIDC_TOKEN` into `.env.local`.

```sh
cd examples/hello-sandkit
vercel env pull
```

3. Install and run:

```sh
bun install
bun run start
```

If you are running for a while, re-run `vercel env pull` when the local token is refreshed.
The Vercel OIDC development token in `.env.local` is short-lived and can expire.

## Files

- `index.ts`: workspace setup + two durable `runCommand()` calls.
- `package.json`: local script/dependencies.
- `tsconfig.json`: local TypeScript settings.

## Expected output

You should see logs showing both durable command phases, including the readback text from `hello.txt`.
