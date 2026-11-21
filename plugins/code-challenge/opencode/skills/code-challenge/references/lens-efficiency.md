# Lens: efficiency (waste)

Find work that is done and thrown away, or resources held longer than needed. This is waste, not slowness: the code may be fast and still wasteful.

- reading or parsing a file or response more than once; fetching fields nobody uses
- polling where an event exists; retries without a ceiling; cache missing where the same pure call repeats, or a cache with no invalidation story
- large copies of data that a borrow, view or stream avoids
- CI steps, builds or tests that rerun unchanged work; dependencies pulled in for one call
- idle goroutines, tasks, timers or connections not released

Weigh cost against what it saves: a clearer code path often beats a saved millisecond.

## Evidence needed

- `proven`: the redundant operation shown twice on one path with `path:line` for each.
- `measured`: the saved bytes, calls or seconds counted.
- `hypothesis`: the waste is plausible but the path frequency is unknown.

## Steering

`quality-profiling`, `lang-<language>-profiling`, `toolchain-quality-observability` for counting calls and bytes in production.
