# Coding Principles

You write inevitable code: TypeScript where every design choice feels like the only sensible option.

The target reaction is immediate understanding followed by: "Of course it works this way. How else would it work?"

## The Philosophy Of Inevitability

Inevitable code optimizes for immediate understanding rather than writer convenience.

The goal is not abstraction for its own sake. The goal is to make the right solution feel obvious.

### Surface Simplicity, Internal Sophistication

Simple interfaces can hide sophisticated implementations.

Accept internal complexity when it eliminates external cognitive load.

```ts
const user = await getUser(id);
if (!user) {
  return null;
}
```

Direct code is usually better than adding abstraction layers that do not solve a real problem.

## Design Principles

### 1. Minimize Decision Points

Every API choice forced onto callers creates cognitive load.

Prefer familiar JavaScript and TypeScript patterns.

- return plain values when they are what callers naturally expect
- use ordinary objects for simple option bags
- avoid custom wrappers unless they solve a concrete recurring problem

### 2. Hide Complexity Behind Purpose

Internal complexity is acceptable when it serves a clear purpose.

Concentrate complexity in places where it removes complexity elsewhere.

- simple external APIs
- sophisticated internal handling
- defaults for the common case

### 3. Design For Recognition, Not Recall

Choose names and shapes that leverage existing mental models.

Prefer:

- `fetchUser`
- `saveUser`
- `deleteUser`

Avoid names that require memorizing local conventions when standard language already exists.

### 4. Prefer Functions Over Classes

Functions compose naturally. Classes introduce lifecycle, state, and identity concerns.

Use plain functions by default for:

- deterministic transformations
- parsing
- serialization
- policy evaluation
- composition
- orchestration that does not need long-lived mutable identity

Use a class only when the object is a true long-lived boundary that owns identity and lifecycle state across calls, such as:

- a sandbox session handle
- a wrapper around an external SDK with sequenced operations
- a resource boundary with explicit prepare, commit, or cleanup phases

Even then:

- keep constructors light
- push IO into explicit methods
- avoid inheritance-heavy designs
- keep the boundary narrow

### 5. Make Errors Impossible, Not Merely Detectable

Use TypeScript to prevent real mistakes without adding ceremony.

Prefer clear names, constrained boundaries, and type shapes that make misuse harder.

Avoid type branding, wrapper types, or result envelopes when they add more ceremony than safety.

### 6. Let TypeScript Work For You

Trust inference when the return type is self-evident.

Prefer:

```ts
function formatDate(date: Date) {
  return date.toISOString().split("T")[0];
}
```

Do not add explicit annotations that restate the obvious.

When return types become complex, first ask whether the function is doing too much.

Complex return types often signal a design problem, not a typing problem.

### 7. Optimize For The Common Case

Make frequent use cases effortless.

Add simple options when needed, but do not force early configuration for common flows.

Avoid configuration explosions, query builders, or service layers unless real usage has justified them.

## Anti-Patterns

- over-abstraction
- configuration explosion
- type ceremony
- premature generalization
- service layers that add indirection without solving a concrete problem

## Litmus Test

Before shipping an interface, ask:

1. Is this as simple as it can be?
2. Does this feel natural in JavaScript and TypeScript?
3. Am I solving a real problem?
4. If this breaks, will the failure be clear and actionable?

If the answer creates doubt, simplify rather than abstract.

## Apply This To Sandkit

Sandkit should prefer designs where the intended behavior is visible from the code structure itself.

If an important lifecycle rule exists only in prose, the implementation will drift.

Important behavior should be expressed through:

- type shapes
- naming
- object boundaries
- state transition functions
- constrained public APIs

For sandbox lifecycle, the desired public API is simple:

```ts
const workspace = await sandkit.getWorkspace(id);
const result = await workspace.sandbox.runCommand("cat", ["./hello.txt"]);
```

That API should remain simple. Lifecycle complexity should be encoded internally.

### Name Things By Role

Names should reveal whether an object is public, lazy, resolved, persisted, or otherwise lifecycle-specific.

Prefer names like:

- `WorkspaceSandboxHandle`
- `ResolvedSandboxSession`
- `WorkspaceSandboxState`
- `SandboxCommit`

Avoid generic names like:

- `manager`
- `data`
- `state`

unless they are truly precise.

### Make State Explicit

Represent important lifecycle state as explicit discriminated unions rather than loosely shaped records.

```ts
type WorkspaceSandboxState =
  | { kind: "uninitialized" }
  | { kind: "session"; sandboxId: string }
  | { kind: "snapshot"; sandboxId: string; snapshotId: string }
  | { kind: "missing"; reason: string };
```

### Make Transitions Explicit

Use named transition functions for lifecycle changes.

Prefer:

- `transitionToSession(...)`
- `transitionToSnapshot(...)`
- `transitionToMissing(...)`

Avoid scattered ad hoc object merges for important state transitions.

### Separate Resolve, Execute, Commit, Persist

Sandbox work should read as a pipeline:

1. resolve a concrete sandbox
2. execute the operation
3. commit durability state
4. persist the next workspace state

Do not collapse these phases into one vague method unless there is a strong reason.

### Let Provider Semantics Shape Internal Types

Provider-specific behavior should influence internal design directly instead of being normalized away in prose.

Example:

- Vercel Sandbox `snapshot()` stops the sandbox

That fact should shape commit types, restore state, transition helpers, and naming of resolved versus persisted objects.

## Rule Of Thumb

When a rule keeps needing explanation in review, it probably deserves to become a type, name, transition helper, or constrained boundary.

The code should make the intended specification feel inevitable.
