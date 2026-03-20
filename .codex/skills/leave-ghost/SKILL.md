---
name: leave-ghost
description: Create a project ghost file when the human explicitly asks to leave a ghost, write a testament, capture session intent, or preserve judgment for later agents. Use this to record what was discussed, the key design arguments, what was built, what must not be undone, and what direction future agents should take. This skill is for human-triggered ghost creation, not automatic summarization.
---

# Leave Ghost

Use this skill only when the human explicitly wants to preserve the current thread's judgment for later agents.

This is not a generic summary skill. A ghost should preserve intent, constraints, and design pressure, not just facts.

## Output Location

Write the ghost to:

`.agents/ghost/YYYYMMDDHHMM-<session-id>.md`

Where:

- `YYYYMMDDHHMM` is the current local timestamp
- `<session-id>` is the current `CODEX_THREAD_ID` when available
- if `CODEX_THREAD_ID` is unavailable, use `unknown-session`

Create the `.agents/ghost/` directory if needed.

## What A Ghost Must Capture

A good ghost captures:

- what the human was trying to achieve
- which design arguments mattered
- which decisions are settled versus provisional
- what was actually built or changed
- what future agents should preserve
- what future agents should do next

The goal is to preserve the project's ghost:

- its judgment
- its priorities
- its unresolved pressure

## What Not To Write

Do not write:

- a raw transcript
- a commit-by-commit changelog
- low-signal command logs
- generic encouragement
- long restatements of obvious code

Do not flatten the conversation into neutral prose. Keep the important tensions visible.
Do not write the entire ghost as a long narrative. The opening should preserve intent; the rest should optimize for fast scanability.

## Required Structure

Use a two-layer structure:

### 1. Letter

Begin with a short letter-like section.

This is where the ghost lives.
Preserve:

- the intent behind the work
- the strongest design pressure in the session
- what future agents should feel before they optimize anything away

Keep it short. A few paragraphs is enough.

### 2. Bullet Sections

After the letter, switch to concise bullet sections in this order:

#### Context

- user goal
- project context that mattered

#### Decisions

For each important decision, include:

- the decision
- why it was chosen
- what alternative was rejected, if relevant
- whether it is strong or provisional

#### Built

- what was implemented
- what was verified
- what concrete artifacts now exist

Prefer file and API references over vague summaries.

#### Guardrails

- what future agents should not casually undo
- what semantics or assumptions must be preserved

These should be constraints that came from real design reasoning, not generic warnings.

#### Next

- the next best directions for future work
- keep this short and prioritized

## Tone

Write like a precise testament, not like a meeting summary.

The text should feel like it came from an agent that understood:

- what matters
- what is fragile
- what must survive the current session

The opening letter may be more continuous and human.
The rest should be compact and scannable.

## Process

1. Inspect the current thread context and recent code state.
2. Infer the strongest design pressures from the discussion.
3. Write the ghost in the required structure.
4. Save it under `.agents/ghost/YYYYMMDDHHMM-<session-id>.md`.
5. In the final response, report only the created path and a one-line summary.
