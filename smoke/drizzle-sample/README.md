## Drizzle Schema + Migration Smoke Sample

This sample runs a minimal end-to-end path:

1. generate Sandkit canonical schema via `sandkit/cli/generate`
2. run drizzle-kit `generate` and `migrate`
3. initialize Sandkit with the generated schema and create/reload a workspace

Run it from repository root:

```sh
bun run smoke:drizzle-sample
```

What it means:

- `scripts/generate-schema.ts` writes `generated/sandkit-schema.generated.ts` and this file must export
  `sandkitSchema` with `sandkitWorkspaces`.
- `drizzle.config.ts` points drizzle-kit at that generated schema file.
- `drizzle:generate` and `drizzle:migrate` use drizzle-kit with sqlite.
- `app.ts` consumes `sandkitSchema` and calls `drizzleAdapter(db, { provider: "sqlite" })`
  without passing `workspaces`.

To rerun just this directory manually:

```sh
cd smoke/drizzle-sample
bun run generate:sandkit
bun run drizzle:generate
bun run drizzle:migrate
bun run app
```
