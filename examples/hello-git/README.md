# hello-git

Minimal Sandkit sample that demonstrates durable Git access:

- `createSandkit(...)`
- `createWorkspace(...)` with durable `policy: allowServices([github()])`
- `workspace.sandbox.runCommand({...})`
- `runCommand`-driven cloning and listing

This example intentionally does not use `openSession()` / `attachSession()`.

## What this does

- Creates a durable workspace state store with Bun SQLite.
- Creates a Vercel-backed workspace with GitHub policy enabled.
- Runs one durable command to clone `https://github.com/${GITHUB_REPO}` into `repo`.
- Runs another durable command to list the cloned directory with `ls repo`.

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
cd examples/hello-git
vercel link
```

2. Pull local environment to create `.env.local` with project-backed OIDC credentials:

`vercel link` connects this directory to a Vercel project, and `vercel env pull` writes local project-scoped credentials including `VERCEL_OIDC_TOKEN` into `.env.local`.

```sh
cd examples/hello-git
vercel env pull
```

3. Set required environment variables:

```sh
export GITHUB_REPO=org/name
export GITHUB_TOKEN=...
```

`GITHUB_TOKEN` is not inserted into clone URLs or command arguments. It's used as the default credential for `github()` so Vercel Sandbox applies the correct header transforms for `github.com` / `api.github.com`.

4. Install and run:

```sh
bun install
bun run start
```

## Files

- `index.ts`: workspace setup + durable `runCommand(...)` calls for clone and list.
- `package.json`: local script/dependencies.
- `tsconfig.json`: local TypeScript settings.

## Expected output

You should see logs for the clone and list phases. On success, `ls` prints the repository contents under `repo`.

## Durable behavior note

Within one run, the second `runCommand(...)` sees the repository cloned by the first command through Sandkit's durable command boundary.

This example creates a new workspace each time it starts, so it does not demonstrate reopening the same workspace across separate process runs. It also does not auto-delete `repo` inside a workspace; if you adapt this example to reuse a fixed workspace id, be explicit about how you want to handle an existing checkout.
