# Lens: optimisation (algorithm)

Find algorithmic cost that a better structure removes. This lens is about complexity class, not machine time; machine time belongs to [lens-performance.md](lens-performance.md).

- nested loops over the same collections (O(n*m) where a map lookup gives O(n+m))
- repeated linear search, `includes` in a loop, sorting inside a loop, repeated regex compile
- N+1 queries or calls, recomputation of a pure value, missing early exit
- string building by repeated concatenation in a loop

Judge n from the code: unbounded user data or a fixed list of five. A quadratic over five items is no finding.

## Evidence needed

- `proven`: the complexity argument plus the origin of n (a request size, a table, a config list) quoted at `path:line`.
- `measured`: a benchmark at a realistic n shows the cost; the output is in the finding.
- `hypothesis`: n unknown or the hot path unconfirmed.

## Steering

`quality-profiling` before any speed claim, `lang-<language>-profiling` for the language's profiler and benchmark tool.
