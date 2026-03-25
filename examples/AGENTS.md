# AGENTS.md

## Examples Principles

Examples are teaching artifacts first.

- Prefer small, shallow modules that make the example's message visible at a glance.
- Prefer explicit composition over helper layers that hide the important boundary.
- Name files by the entity or concept they define, not by vague convenience buckets like `utils`, `common`, or `helpers`.
- Keep the example's durable unit, identity rules, and key transitions visible in the top-level scripts when those are the point of the example.
- In small examples, prefer writing a meaningful literal directly over introducing a named constant that only adds one extra level of indirection.

## Values Over Factories

In `examples/`, do not introduce factories just because code is being assembled.

- Prefer a value such as `const sandkit = ...` when the example is defining a fixed runtime or fixed setup.
- Prefer a direct literal such as `"hello-git"` when the example is teaching one fixed identifier and the name itself carries the meaning.
- Use a factory only when the variation is part of the example's meaning: different inputs, different lifecycle, expensive initialization, or genuinely distinct instances.
- Do not introduce a factory to preserve hypothetical future flexibility if the current example is teaching one fixed shape.
- Do not introduce a named constant just to avoid repeating a single obvious literal when that constant forces the reader to resolve another layer of naming first.
- If a helper makes the example harder to read, move the logic back to the script even if it means a few extra lines.

## Composition Depth

`examples/` and `packages/` have different goals.

- `examples/` should stay shallow and legible. They should show how pieces compose.
- `packages/` may be deeper modules that absorb internal complexity behind a simpler public API.
- Do not copy package-style abstraction depth into examples unless the abstraction itself is what the example is demonstrating.
