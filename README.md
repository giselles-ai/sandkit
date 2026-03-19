# Sandkit

Sandkit is a helper and cli for building production grade apps with Vercel Sandbox.

https://vercel.com/docs/vercel-sandbox/sdk-reference

### How to use

```ts
// lib/sandkit.ts
import { sandkit } from "sandkit"
import { drizzleAdapter } from "sandkit/adapters/drizzle"
import { allowCodex } from "sandkit/policies/codex"
import { allowGemini } from "sandkit/policies/gemini"
impoer { db } from "@/db"

const sandkit = sandkit({
	database: drizzleAdapter(db, {
		provider: "sqlite",
	}),
	network: [
	  allowCodex(),
		allowGemini()
	]
})
```

```ts
// api/sandkit-sample/route.ts
import { sandkit } from "@/lib/sandkit"

export async funciton POST() {
  const workspace = await sandkit.createWorkspace()
  const sandbox = workspace.createOrResumeSandbox()
  await sandbox.runCommand("echo", ["hello world", ">", "./hello.txt"])
  return new Response(JSON.stringify({ workspaceId: workspace.id }), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  })
}
```

```ts
// api/sandkit-sample/workspaces/[id]/route.ts
import { sandkit } from "@/lib/sandkit";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await sandkit.getWorkspace(id);
  const sandbox = await workspace.createOrResumeSandbox();
  const result = await sandbox.runCommand("cat", ["./hello.txt"]);
  return new Response(JSON.stringify({ output: result.stdout }), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
```
