# AGENTS.md

## Workflow

If the user's prompt includes a GitHub URL, retrieve the referenced issue, pull request, commit, or repository context with `gh` CLI before acting on it.

## Principles

Sandkit's public center of gravity is `workspace.sandbox.runCommand(...)` as the durable unit of work.

- Keep persistence responsibility inside Sandkit, not with callers.
- Do not reintroduce `workspace.createOrResumeSandbox()` as the intended public entrypoint.
- Preserve provider truth, especially Vercel Sandbox lifecycle behavior, even when the public API uses Sandkit-shaped names.
- Prefer code structure, types, and transitions that reveal the specification over prose-only explanations.

The durable/live split is intentional and should remain explicit.

- `runCommand(...)` is the default durable path.
- `session` is the explicit live phase for long-running interactive workloads.
- A live session is an exclusive lease; do not let `runCommand()` race with it.
- Public session semantics should stay provider-neutral even when backed by Vercel snapshot behavior.
- `session` is not a raw shell handle. It is a managed live phase on top of the durable workspace model.

Workspace state is the durable source of truth.

- Sandbox lifecycle and commits should remain explicit state transitions, not metadata soup.
- Keep the internal model legible as a lifecycle such as resolve -> execute -> commit -> persist.
- Policy is workspace-owned durable default state.
- Per-run policy override belongs only on `runCommand({ policy })`.
- Secrets may be resolved at apply time but must not be stored durably.
- Do not let per-run overrides silently mutate durable workspace defaults.

Provider honesty matters more than pretty abstraction.

- Vercel snapshot semantics are real and should not be disguised as a harmless save.
- A snapshot-backed commit may stop the runtime; design and naming must not hide that.
- Policy semantics should start from the provider's real model, not from a generic evaluator-first abstraction.
- Wildcard and network policy behavior must match provider semantics exactly.
- Bootstrap/open-network phases and restricted execution phases are distinct and should stay distinct.
- Route propagation, ports, PATH quirks, and similar provider details are part of the truth, not noise to abstract away.
- Do not assume smoke failures are code failures before separating auth, environment, network, and provider-runtime causes.

Package and example discipline matter.

- Keep package exports and build surface minimal and tied to real consumers.
- Prefer real consumer setups such as `workspace:*` and packed package flows over path-import demos.
- Do not add config or discovery magic unless it pays for itself in real use.
- Discovery and convenience fallbacks must remain subordinate to explicit user input and explicit flags.
- Do not treat private internals or brittle library internals as the semantic center of an integration just because they help ergonomics.

Policy and credential design should stay honest.

- Model workspace policy as durable workspace state, not sandbox-handle-owned mutable state.
- Prefer service-oriented policy builders that compile into durable provider-shaped policy, rather than cute rule-list APIs.
- Do not preserve fake compatibility for removed or renamed policy inputs.
- Wildcards must not silently broaden meaning.
- Default credentials may resolve from the environment at apply time, but raw secrets must never be persisted in workspace state or snapshots.
- Explicit secret-bearing overrides are ephemeral and must not silently collapse into default credential mode.

Examples and smokes must tell the truth.

- A smoke only counts as evidence if it really executes the path it claims to verify.
- Keep bootstrap/setup phases distinct from restricted execution phases when that separation is necessary to explain failures honestly.
- Skipped smokes are not successful end-to-end verification.
- Production-shaped examples should recover from realistic broken intermediate state instead of assuming clean starts.

When the code is ambiguous and the path forward is unclear, prefer the change that preserves these principles over a superficially simpler shortcut.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->
