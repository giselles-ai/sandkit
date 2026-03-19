# Sandkit Class Usage Guidelines

## Guiding Rule

Use classes only for long-lived resource boundaries that hold identity and lifecycle state. Prefer pure functions for composition and transformations.

## Use a Class When

- An object owns mutable state across calls (`WorkspaceHandle`, `SandkitSandbox`).
- The API is naturally method-based and calls can be sequenced (`createOrResumeSandbox()`, `runCommand()`).
- You need deterministic lifecycle hooks around operations (prepare, record, cleanup).
- You need to wrap an external SDK as a stable boundary.

## Use Functions When

- The logic is deterministic and input/output driven (argument parsing, schema serialization, policy evaluation).
- You need easy unit testing and reuse across environments.
- You need to compose behavior by pipes (`transformConfig`, `normalizeRecord`, `renderSchema`).
- You need no cross-instance mutable state.

## Pattern to Apply

Define interfaces at boundaries, then provide small concrete classes that delegate to injected functions:

- `SandkitSandbox` (class) wraps `SandboxDriver` and runs template steps.
- `createModelSchema(...)` and `renderDrizzleSchema(...)` (functions) generate schema outputs.
- `evaluatePolicies(...)` (function) returns allowed/blocked decisions.
- `parseGenerateArgs(...)` / `runGenerateCommand(...)` (function + command entrypoint) for CLI orchestration.

## Anti-Patterns

- Avoid inheritance chains (`extends`) for most operations; use composition.
- Avoid “god classes” that parse config, execute DB, and call SDK directly.
- Avoid side effects in constructors; keep constructors light and push IO into explicit methods.
