---
name: prepare-release-pr
description: Prepare a release pull request for a published package in this repository when the human wants to cut a release, draft release notes, or have an agent propose the next npm release. Use this to collect changes since the last published npm version, propose patch or minor, update package.json, and create a release PR whose title is `Release: <package>@<version>` and whose body becomes the release notes source.
---

# Prepare Release PR

Use this skill when the human wants an agent-supported release preparation flow.

This skill is for release preparation only.
Do not publish to npm from this skill.
Do not create a git tag or GitHub Release from this skill.

## Release Model

- The release candidate is a dedicated release PR.
- The PR title is the machine-readable release identifier.
- The PR body is the canonical release notes draft during preparation.
- npm registry is the source of truth for what is already published.

## Required Title Format

Always create the release PR title as:

`Release: <package>@<version>`

Example:

`Release: @giselles-ai/sandkit@0.1.2`

## Required Body Format

Always use this structure:

```md
## Overview

- `<package>@<version>` の release 準備
- bump 種別: `<patch|minor>`
- 判断理由:
  - ...
  - ...

## Pull Requests

- #123 ...
- #124 ...
```

Rules:

- Write the body in Japanese.
- Keep it short and reviewable.
- Prefer PR references over raw commit lists.
- Include only the PRs that materially explain the release.

## Semver Guidance

Default to proposing `patch` unless the changes justify a new minor release.

Use `minor` when the diff includes user-meaningful new capabilities such as:

- new public API surface
- new package entrypoints or integrations
- meaningful new examples that expand supported workflows
- behavior that materially broadens what consumers can do

Use `patch` when the diff is primarily:

- fixes
- internal cleanup
- docs polish
- example corrections without new capability
- workflow or maintenance improvements that do not expand the package contract

If the boundary is unclear, state the ambiguity explicitly in the Overview section rather than pretending the choice is obvious.

## Inputs To Inspect

Use these sources to prepare the release PR:

- npm registry for the latest published version of the package
- git history for the diff since that published baseline
- GitHub PR history and merged PR metadata
- current package.json version and package name

Do not use git tags as the only release baseline.
Use tags only as supporting context when they exist and are trustworthy.

## Process

1. Identify the target package name from its `package.json`.
2. Find the latest published version in npm registry.
3. Determine the release baseline for that published version.
4. Collect merged PRs and meaningful changes since that baseline.
5. Propose `patch` or `minor` with explicit reasons.
6. Compute the next version.
7. Update the target `package.json` version.
8. Create or update a release branch for the package.
9. Open a PR with title `Release: <package>@<version>`.
10. Write the PR body using the required format.

## Guardrails

- Do not publish to npm.
- Do not create or push release tags.
- Do not create a GitHub Release.
- Do not treat `package.json` version as proof that the package is already released.
- Do not include speculative claims in release notes. Prefer verified facts from merged PRs.
- Do not turn semver choice into a hidden heuristic. State the reason in the PR body.

## Final Response

After preparing the release PR, report:

- the package name
- the proposed version
- the proposed bump type
- the PR URL if created
- any ambiguity that still needs human judgment
