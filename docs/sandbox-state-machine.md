# Sandkit Sandbox State Machine

This document defines the lifecycle model for Sandkit-managed sandboxes.

The goal is to keep the public API simple:

```ts
const workspace = await sandkit.getWorkspace(id);
const result = await workspace.sandbox.runCommand("cat", ["./hello.txt"]);
```

At the same time, Sandkit must correctly manage provider-specific lifecycle rules such as Vercel Sandbox snapshot behavior.

## Core Rules

- Public callers interact with `workspace.sandbox`, not `createOrResumeSandbox()`.
- `workspace.sandbox` is a lazy handle, not a concrete sandbox instance.
- `sandbox.runCommand(...)` is one unit of work.
- Persistence is Sandkit's responsibility, not the caller's responsibility.
- A provider snapshot is not a passive save operation.
  For Vercel Sandbox, creating a snapshot stops the sandbox.

## Terminology

- `workspace`: durable record owned by Sandkit.
- `sandbox handle`: lazy public object exposed as `workspace.sandbox`.
- `resolved sandbox`: provider-backed concrete sandbox instance.
- `session state`: enough metadata to reconnect to a live or resumable sandbox session.
- `snapshot state`: enough metadata to restore from a provider snapshot.

## Public Model

The public model intentionally hides lifecycle mechanics.

- `workspace.sandbox.runCommand(...)`
  Sandkit resolves a concrete sandbox, executes the command, and persists updated state.
- Callers should not decide when to snapshot.
- Callers should not need to know whether the provider resumed from a live session or a snapshot.

## Responsibility Boundaries

This project keeps the public model small by separating ownership and live execution semantics.

| Concept | Ownership | Durability | Public API role | Typical use |
|---|---|---|---|---|
| `workspace` | owns durable state | persisted across reload and restart | stable handle owner (`getWorkspace`, `setPolicy`) | policy updates, workspace retrieval |
| `workspace.sandbox` | lazy boundary only | no owned durable state | entry point (`runCommand`, `openSession`, `attachSession`, `getActiveLease`) | call routing and state-machine resolution |
| `session` | ephemeral lease | active runtime state only | explicit live object (`exec`, `startProcess`, `url`, `commit`, `extendTimeout`) | running interactive process and obtaining public routes |
| `policy` | durable default on workspace, override per command | workspace default is stored durably; run snapshots store a redacted effective-policy record only | durable via `setPolicy`, temporary via `runCommand({ policy })` | network boundary configuration |

## State Set

Sandkit tracks sandbox lifecycle at the workspace level.

### 1. `cold`

No attachable live session exists for the workspace.

Properties:

- No live session metadata is currently usable.
- This is the initial state before any sandbox is created.
- Sandkit may also reconcile expired or unavailable session metadata back to `cold`.

### 2. `session`

The workspace has enough provider metadata to reconnect to an existing sandbox session.

Properties:

- Sandkit stores session-oriented restore information such as `sandboxId`.
- The provider sandbox may still be running, or may be resumable through provider APIs.
- This is the live-session state entered through `openSession()`.

### 3. `snapshot`

The workspace has enough provider metadata to restore from a provider snapshot.

Properties:

- Sandkit stores snapshot-oriented restore information such as `snapshotId`.
- The previous concrete sandbox instance must be considered closed.
- Resume creates a new concrete runtime from the snapshot.

## Transitions

```mermaid
stateDiagram-v2
    [*] --> cold
    cold --> snapshot: first runCommand creates sandbox and commits
    cold --> session: openSession()
    snapshot --> snapshot: resume from snapshot and runCommand()
    snapshot --> session: resume from snapshot and openSession()
    session --> snapshot: session.commit()
    session --> session: attachSession() / extendTimeout()
    session --> cold: provider session lost or lease expired
```

## Unit Of Work

`runCommand(...)` is one unit of work.

Sandkit performs the following steps:

1. Resolve the latest workspace record.
2. Resolve a concrete sandbox from persisted state.
3. Execute the command.
4. Persist the next workspace sandbox state.
5. Return the command result or rethrow the error.

Important:

- Step 4 runs on both success and failure paths.
- Persistence policy belongs to Sandkit.
- The caller must not be responsible for durability.

## Persistence Policy

The intended default policy is:

- `runCommand(...)` automatically persists durable state.
- Callers do not manually decide whether to persist after the command.
- For providers where durable persistence is implemented through snapshots, Sandkit should create a snapshot at the end of the unit of work.

Reason:

- Persistence responsibility belongs to Sandkit, not the caller.
- If callers have to explicitly persist, unexpected errors can discard meaningful sandbox state changes.
- A unit of work is only complete when Sandkit has both executed the command and secured the resulting state.

## Snapshot Semantics

Snapshot is a lifecycle event, not a passive save.

Rules:

- If Sandkit creates a snapshot, it must treat the current concrete sandbox as no longer usable.
- After snapshot creation, persisted state should move to `snapshot`.
- Future operations must resolve a new concrete sandbox from snapshot restore data.

Implication:

- If Sandkit uses snapshots as the durability mechanism for `runCommand()`, then `runCommand()` must be modeled as:
  execute -> snapshot -> stop current sandbox -> persist snapshot restore state
- In that model, ending the concrete sandbox session is part of the normal command commit behavior.

## Provider Expectations

Providers must fit the Sandkit contract, but provider semantics are not identical.

### Vercel Sandbox

- `Sandbox.create(...)` creates a concrete runtime.
- `Sandbox.get(...)` reconnects to a concrete runtime by sandbox id.
- `snapshot()` creates a restore point and stops the sandbox.

Therefore:

- automatic durability after `runCommand(...)` may require snapshot creation
- if snapshot is the durability mechanism, Sandkit must model the resulting stop as part of the normal state transition
- the next command should resume from persisted restore metadata rather than assuming the prior concrete sandbox is still live

## Invariants

These must remain true across implementations.

- Public callers see a stable sandbox interface, not provider lifecycle APIs.
- `workspace.sandbox` may be lazy, but `runCommand(...)` must behave deterministically.
- Sandkit owns persistence decisions.
- Provider stop/snapshot semantics must not be ignored or silently contradicted.
- A persisted workspace record must always describe one restore strategy clearly:
  either session-oriented restore or snapshot-oriented restore.

## Capability Map

```mermaid
flowchart TD
    A[workspace] --> B[durable policy]
    A --> C[persisted sandbox state]
    A --> D[run records]
    A --> E[workspace.sandbox]
    E --> F[runCommand]
    E --> G[openSession]
    E --> H[attachSession]
    E --> I[getActiveLease]
    G --> J[session]
    H --> J
    J --> K[exec]
    J --> L[startProcess]
    J --> M[url]
    J --> N[extendTimeout]
    J --> O[commit]
```

## What Sandkit Can Do Now

| Area | API | Can be done | Notes |
|---|---|---|---|
| Durable command execution | `workspace.sandbox.runCommand(...)` | Yes | one-command durable unit, state persisted automatically; unavailable while an active session lease exists |
| One-shot policy override | `runCommand({ policy })` | Yes | per-run override only |
| Durable policy updates | `workspace.setPolicy(...)` | Yes | persisted on workspace record |
| Live session start | `workspace.sandbox.openSession()` | Yes | requires no active attachable session; session is an exclusive live path |
| Live session attach | `workspace.sandbox.attachSession()` | Yes | reattaches to an existing attachable lease only; does not refresh lease timing by itself |
| Lease introspection | `workspace.sandbox.getActiveLease()` | Yes | includes sandbox id and expiry, null when detached |
| Session command execution | `session.exec(...)` | Yes | live path, separate from `runCommand` |
| Background process | `session.startProcess(...)` | Yes | interactive workloads |
| Route discovery | `session.url(port)` | Yes | provider-backed public route lookup; port readiness and public route availability are not always the same |
| Session timeout | `session.extendTimeout(durationMs)` | Yes | lease-extension path for live sessions |
| Session commit | `session.commit()` | Yes | transitions to durable snapshot state |

## Non-Goals

These are intentionally not assumed.

- SQL-style rollback semantics
- provider-independent atomic filesystem rollback

## Future Extension

A future `runTx(...)` API can extend this model.

Expected shape:

- `runCommand(...)` remains a single-command unit of work
- `runTx(...)` would group multiple commands into one persistence boundary

Even then, `runTx(...)` should be modeled as a checkpointed unit of work, not as a rollback-capable SQL transaction.
