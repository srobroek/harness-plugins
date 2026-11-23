# Lens: simplification

Find code that does in many steps what fewer would do, keeping behaviour identical.

- nested conditionals that flatten with early returns or a lookup table
- a loop that rebuilds what a standard collection method gives
- needless intermediate variables, wrapper functions that only forward, boolean flags that select between two functions
- state kept in two places, or a conversion to a type and straight back
- repeated option or error handling a single helper would hold

Keep this lens apart from over-engineering: simplification shortens code that is needed; over-engineering removes structure nobody needs (see [lens-over-engineering.md](lens-over-engineering.md)).

Record test protection on every finding: `protected` (a test fails if behaviour changes), `partial` or `unprotected`. An unprotected simplification that touches branches gets a note to add a test first.

## Evidence needed

- `proven`: the two forms are equivalent by reading both and by a test or type check that exercises every branch removed. Name the test.
- `hypothesis`: equivalence argued by reading only. Say which branch you could not exercise.
- Never `measured`: a simplification claims no speed.

## Steering

`quality-code-policy`, `lang-<language>-quality` for the language's idioms, `quality-test-audit` when protection is missing across a whole module.
