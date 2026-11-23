# Lens: observability

Find places where a failure or slowdown would be invisible.

- errors logged without context, or logged and rethrown (double logging), or swallowed
- no request or correlation id across a service boundary; unstructured logs; `print` or `console.log` left in
- no metric or trace around I/O, queues or retries; high-cardinality labels
- secrets or personal data in logs; log levels misused
- health or readiness missing where a platform expects it

Prefer the framework's middleware (one place for ids, logs, traces and metrics) over per-call edits, and OpenTelemetry over OTLP as the telemetry standard.

## Evidence needed

- `proven`: the call path shown with `path:line` where the signal is missing, and the failure it would hide.
- `hypothesis`: the signal may exist elsewhere (a sidecar, a gateway). Say where you did not look.

## Steering

`toolchain-quality-observability` (the standard stack and checks), `lang-<language>-quality` (log and lint rules), `quality-code-policy` (cross-cutting concerns live in middleware).
