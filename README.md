# Sandkit

Sandkit is a helper and cli for building production grade apps with Vercel Sandbox.

https://vercel.com/docs/vercel-sandbox/sdk-reference

### How to use

```ts
// lib/sandkit.ts
import { sandkit } from "sandkit";
import { drizzleAdapter } from "sandkit/adapters/drizzle";
import { allowServices, codex, gemini } from "sandkit";
import { db } from "@/db";

const sandkit = sandkit({
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  policy: allowServices([codex(), gemini()]),
});
```

```ts
// api/sandkit-sample/route.ts
import { sandkit } from "@/lib/sandkit";

export async function POST() {
  const workspace = await sandkit.createWorkspace();
  await workspace.sandbox.runCommand({
    command: "sh",
    args: ["-lc", "echo 'hello world' > ./hello.txt"],
  });
  return new Response(JSON.stringify({ workspaceId: workspace.id }), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
```

```ts
// api/sandkit-sample/workspaces/[id]/route.ts
import { sandkit } from "@/lib/sandkit";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await sandkit.getWorkspace(id);
  await workspace.setPolicy(allowServices([codex()]));
  const result = await workspace.sandbox.runCommand({
    command: "cat",
    args: ["./hello.txt"],
  });
  return new Response(JSON.stringify({ output: result.stdout }), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
```

### Drizzle ORM Adapter

```sh
npm install sandkit drizzle-orm
```

#### Example Usage

```ts
import { sandkit } from "sandkit";
import { drizzleAdapter } from "sandkit/adapters/drizzle";
import { db } from "@/db";

const sandkit = sandkit({
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  policy: allowServices([codex()]),
});
```

The generated schema exports a canonical workspace table as `sandkitWorkspaces`.

If you use custom table names, pass an explicit `workspaces` table to `drizzleAdapter`:

```ts
const sandkit = sandkit({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    workspaces: schema.sandkitWorkspaceTable,
  }),
});
```

#### Schema generation & migration

```sh
# Explicit path
npx @giselles-ai/sandkit@latest generate --adapter drizzle --provider sqlite

# Or let discovery infer provider from a Drizzle repository
npx @giselles-ai/sandkit@latest generate
npx drizzle-kit generate
```

### Codex Subagent: `lilas`

`lilas` is the implementation-focused Sandkit subagent for concrete, scoped code changes once the relevant code path is known.

Use `lilas` when the task is already well framed and the main need is execution:

- implement a specific feature or option
- fix a localized bug
- refactor one module to clarify an invariant
- make a lifecycle change inside an already identified Sandkit path

Do not use `lilas` for open-ended exploration, broad architecture work, or speculative cleanup across unrelated areas.

#### What Makes A Good `lilas` Prompt

A strong prompt gives `lilas`:

- one concrete task
- a narrow file or subsystem scope
- any invariant that must be preserved
- the most relevant validation target

Good:

```text
Use the `lilas` subagent.

Task:
- Fix snapshot restore behavior in `packages/sandkit/src/core/workspace.ts`.

Constraints:
- Preserve the current public API.
- Keep resolve, execute, commit, and persist phases explicit.
- Do not refactor unrelated workspace code.

Validation:
- Run the most relevant test or local command for workspace sandbox lifecycle.
```

Weak:

```text
Use the `lilas` subagent to improve sandbox architecture.
```

The weak version is too broad. `lilas` works best when the task already has a clear target.

#### Default Template

```text
Use the `lilas` subagent.

Task:
- <one specific implementation task>

Scope:
- Work only in <files or subsystem>.
- Read only the code paths needed to make the change safely.

Constraints:
- Follow `docs/coding-principles.md`.
- Prefer the smallest coherent change that fully solves the task.
- Do not broaden scope, rewrite unrelated areas, or do speculative cleanup.

Validation:
- Run the most relevant local test or command in scope.

Report:
- Summarize what changed, how it was validated, and any remaining gaps.
```

#### Targeted Refactor Template

```text
Use the `lilas` subagent.

Task:
- Refactor <file or module> to make <specific behavior or invariant> clearer.

Constraints:
- Preserve behavior.
- Prefer direct designs, explicit names, and constrained boundaries.
- Prefer named transition helpers over ad hoc state changes when lifecycle rules are involved.
- Avoid speculative cleanup outside the touched path.

Validation:
- Run the most relevant local check for the refactored behavior.

Report:
- Summarize the design change and why it is clearer now.
```

#### Bug Fix Template

```text
Use the `lilas` subagent.

Task:
- Fix <bug> in <file or subsystem>.

Constraints:
- Find the smallest safe fix.
- Do not add abstraction unless it removes real complexity.
- Add or update a focused test if there is an existing test path for this behavior.

Validation:
- Run the most relevant test or command for the changed behavior.

Report:
- Summarize the root cause, the fix, and any remaining risk.
```

#### Sandkit Lifecycle Template

```text
Use the `lilas` subagent.

Task:
- Implement <lifecycle-related change>.

Constraints:
- Keep the public API simple.
- Encode lifecycle rules in types, names, boundaries, or transition helpers rather than prose.
- Keep resolve, execute, commit, and persist phases explicit where relevant.
- Let provider-specific semantics shape internal types instead of flattening them away.

Validation:
- Run the most relevant lifecycle-focused local command or test.

Report:
- Summarize the lifecycle model after the change and any remaining edge cases.
```
