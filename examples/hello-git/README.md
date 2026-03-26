# hello-git

Minimal Sandkit sample for one idea:

you can come back to the same workspace later and keep working with the checkout that was created before.

Run two scripts. The first clones a repo. The second comes back later and reads from that same checkout.

This example intentionally does not use `openSession()` / `attachSession()`. It stays centered on `workspace.sandbox.runCommand(...)`.

## Quick Start

Build Sandkit first:

```sh
cd packages/sandkit
bun run build
```

Then move into the example:

```sh
cd examples/hello-git
```

Link to a Vercel project and pull local environment:

```sh
vercel link
vercel env pull
```

Set the GitHub token Sandkit should use for GitHub access. `GITHUB_REPO` is optional and defaults to `giselles-ai/sandkit`:

```sh
export GITHUB_TOKEN=...
```

If you want a different repository:

```sh
export GITHUB_REPO=org/name
```

Install dependencies:

```sh
bun install
```

Now run the two scripts:

```sh
bun run create-and-clone
bun run resume
```

## What You Should Notice

On `bun run create-and-clone`, you should see:

- the workspace id
- a successful clone

On `bun run resume`, you should see:

- the same workspace id
- `git status --short --branch`
- the repository contents under `repo`

If that second script works without recloning, the important part has already happened.

## Why This Is Interesting

Vercel Sandbox already lets one sandbox handle run multiple commands.

This example is showing something else:

- `create-and-clone.ts` creates a durable workspace with id `"hello-git"` and clones a GitHub repo into `repo`
- `resume.ts` comes back later, reopens that same workspace, and reads from the existing checkout

That is the difference this example is trying to make visible:

- a workspace is the durable unit
- `runCommand(...)` is the unit of work
- later process runs can reopen the same workspace and continue from the previous state

This is why the example uses two scripts instead of one longer script. Splitting creation from resumption makes the durable boundary visible.

## Files

- `create-and-clone.ts`: creates the durable workspace and clones the repository
- `resume.ts`: reopens that workspace and reads from the existing checkout
- `lib/sandkit.ts`: the fixed Sandkit runtime for this example
- `lib/repo.ts`: GitHub repo input parsing
- `package.json`: local scripts and dependencies
- `tsconfig.json`: local TypeScript settings

## Setup Details

Prerequisites:

- Vercel CLI (`vercel`)
- Node.js and Bun
- A linked Vercel project to provide local OIDC credentials

Dependency build step:

This example consumes the package exports from `@giselles-ai/sandkit` (`dist/` entry points), so the library must be built first.

From the repo root:

```sh
cd packages/sandkit
bun run build
```

`vercel env pull` creates `.env.local` with project-backed OIDC credentials.

`GITHUB_TOKEN` is not inserted into clone URLs or command arguments. It's used as the default credential for `github()` so Vercel Sandbox applies the correct header transforms for `github.com` / `api.github.com`.

## Read It As A Snippet

If you just want the core idea, ignore the setup details and read the example like this:

- create workspace
- run `git clone`
- later reopen the same workspace
- run `git status`

That is the Sandkit-shaped story this example is trying to teach.
