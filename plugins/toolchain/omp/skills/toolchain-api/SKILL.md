---
name: toolchain-api
description: Use when choosing or designing an API (REST/OpenAPI, gRPC, Connect, GraphQL, events, webhooks, MCP) or its tests.
---
# API standards

Checked 2026-11-12. Per-language frameworks and generators are in the `lang-<language>-libraries`
skills (`services.md`); wire-contract hygiene (committed codegen, one casing, conformance tests)
is in `quality-code-design`'s `contracts.md`.

## Pick the style

| Situation | Default | Choose instead when | Costs to plan for |
| --- | --- | --- | --- |
| Resource APIs | REST with OpenAPI | Clients require typed RPC contracts | Versioning, validation and compatibility tests |
| Internal RPC | Connect or gRPC | Existing ecosystem requires another protocol | Codegen and client support |
| Flexible querying | GraphQL | The UI needs different projections over a stable graph | Resolver authorization and query-cost limits |
| Domain events | Versioned event schemas | A synchronous response is required | Delivery, replay, idempotency and schema evolution |

Test the chosen contract and error behavior at its boundary. Use `new-project` when wiring OMP
MCP servers.
