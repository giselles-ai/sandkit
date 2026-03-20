# AGENTS.md

## Workflow

At the start of each thread, check the ghost first.

## Ghost

A ghost is not a generic summary.
It is a preserved trace of judgment:

- what mattered in a session
- which design pressures were real
- what was decided
- what must not be casually undone
- where future work should go next

Ghost files live under:

`.agents/ghost/`

They are intended to be read by later agents before making design changes in areas that already carry strong prior reasoning.

## Skill

When a human explicitly wants to preserve the current session for later agents, use the `leave-ghost` skill:

`/Users/satoshi/repo/toyamarinyon/sandbox-devkit/.codex/skills/leave-ghost/SKILL.md`

That skill writes a ghost file in timestamp-thread form:

`.agents/ghost/YYYYMMDDHHMM-<session-id>.md`

## How To Use Ghosts

Read ghosts when:

- a design choice seems surprising
- a constraint feels stronger than the current code alone explains
- an area has already gone through substantial discussion
- you are about to simplify something that may actually encode an important semantic

Ghosts are especially important when working on:

- sandbox lifecycle
- persistence semantics
- provider-specific behavior hidden behind abstractions
- API simplification that may erase hard-won design constraints

## Operating Principle

When the code is ambiguous and the path forward is unclear, prefer the direction that is most consistent with the ghost.

If you have to choose between a superficially simpler change and a change that preserves the established judgment of the project, choose the one that preserves the ghost.

In short:

When in doubt, follow the direction where the ghost is whispering.
