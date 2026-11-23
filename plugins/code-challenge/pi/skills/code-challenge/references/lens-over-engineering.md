# Lens: over-engineering

Find structure that has no second user.

- an interface, factory, registry or plugin point with one implementation and no signal that a second is coming
- configuration for values that never vary; generics with one instantiation
- layers that only delegate; events or queues where a direct call works
- extension hooks nobody calls

Apply the seam rule shared with [lens-structure.md](lens-structure.md): whether pluggability is expected is a product question answered at INTAKE (or inferred from signals and logged). Where no signal exists, an extra abstraction is an over-engineering finding here, never a structure gap. Where a signal exists, do not flag the seam.

Propose the inline form and name what must stay (a public contract, a test seam that tests use). Record test protection.

## Evidence needed

- `proven`: count the implementations and callers with `grep` or LSP references and quote the count; confirm no config, doc or roadmap signal for a second user.
- `hypothesis`: the count is one but a signal is ambiguous. Say which.

## Steering

`quality-code-policy` (SOLID and invariants beat YAGNI at real boundaries; YAGNI elsewhere), `architecture-guide` for boundaries.
