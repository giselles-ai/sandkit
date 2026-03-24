## Drizzle Schema + Migration Smoke Sample

This sample runs a minimal end-to-end path:

1. generate Sandkit canonical schema via `sandkit/cli/generate`
2. reset generated migration state (`drizzle/`) and local sqlite DB so stale partial artifacts can't break `drizzle-kit`
3. run drizzle-kit `generate` and `migrate` from a fresh database
4. initialize Sandkit with the generated schema and create/reload a workspace

`drizzle/` and `smoke-drizzle-workspaces.sqlite` are generated/disposable state for this smoke run and are not source-of-truth input.

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
bun run clean:smoke-state
bun run generate:sandkit
bun run drizzle:generate
bun run drizzle:migrate
bun run app
```
