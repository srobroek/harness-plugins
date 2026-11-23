---
name: toolchain-quality-observability
description: Use when adding logging, tracing, metrics, or quality and security scanners to a service, worker or CI.
---
# Quality and observability defaults

Checked 2026-11-12.

## Observability

Emit structured logs with stable fields and redact credentials and sensitive values. Add metrics
for service-level indicators and traces at external boundaries. Keep telemetry configuration
explicit and testable.

## Security scanners

Run scanners in CI and on a schedule. Every suppression names an owner and expiry. Rescan on pull
requests as well as on a schedule. Per-language checks are in `toolchain-languages`' concerns and
each language's quality skill.
