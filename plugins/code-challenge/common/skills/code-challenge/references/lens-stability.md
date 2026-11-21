# Lens: stability

Find code that fails under conditions it will meet.

- swallowed errors, broad catch or bare `except`, ignored return values, `unwrap` or non-null assertions on external data
- missing timeouts, cancellation, retries with backoff, or limits on size, depth and concurrency
- races: shared mutable state, check-then-act on files or rows, non-atomic writes
- resource leaks: files, sockets, processes, temp directories, listeners
- unclear failure behaviour at boundaries (partial writes, half-applied batches)
- unsafe assumptions: clock, locale, path separators, encoding

Name the trigger: the input or event that makes it fail.

## Evidence needed

- `proven`: a failing test or a reproduction command with output; or a type or lint rule that flags it.
- `hypothesis`: a trigger argued from the code and not reproduced. Say what would reproduce it.

## Steering

`lang-<language>-quality` (error handling and lint rules), `quality-code-policy`, `toolchain-quality-observability` for the signals that show the failure in production.
