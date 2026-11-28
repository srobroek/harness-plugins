# Tools

This reference lists the tools of the standard, as of 2026-11, and where each one runs. The versions and the
details of the Go tools are in [go.md](go.md). The CI jobs and the split between a laptop and CI are in the
`business-rules-ci` skill.

| Tool | Role | Runs | Limits |
| --- | --- | --- | --- |
| TypeSpec compiler (`tsp`) | Emits the published JSON Schema from the contract | Wherever the contract standard runs it | The `quality-code-design` skill's `contracts.md` |
| The project's generator | Writes the `.proto` files, one profile manifest per scope, and the `cel-expr` environment | Locally after a schema change; CI checks drift | Refuses a scope that is not structural (G7) |
| `buf` | Compiles the generated `.proto` files to a FileDescriptorSet with `buf build --exclude-source-info` | With the generator | |
| The reference checker: a small Go program over `cel.dev/cel-go` and its `policy` module | Verifies the descriptor-set bytes, checks every rule file, compiles rule lists, checks slot types, writes and verifies the bundle, reports the cost estimate | CI, a local recipe, and the project's rules compile command for users | The checker of record. It builds its environment from the manifest and appends nothing. |
| `cel.dev/cel-go/tools/compiler` | None | Nowhere | It appends the latest `optional` and `bindings` extensions, so it cannot check against an exact profile. |
| `cel-expr` CLI, `v0.4.0` | Authoring: `cel-expr eval -tests` with node and branch coverage, `compile`, `prompt` | Locally while writing a rule; the CI `authoring-tests` job | No `-format policy`, no `-proto_db` and no `conformance` in the release. It reads a JSON environment only, and writes no `CheckedExpr`, so it is never the checker. |
| `cel-expr` MCP server (`cel-expr-mcp`, same release) | The agent tool for G8, in fixed-environment mode | In an agent session | Do not use its `cel_create_environment` tool. |
| `cosign`, `slsa-verifier` | Verify the `cel-expr` release's checksum signature and provenance before the binary runs | Every CI install, and one time by hand | |
| `mise` | Pins the toolchain: Go, uv, Rust, Node, buf, cosign, slsa-verifier and just | Everywhere | One updater owns the pins. |
| `just` | One recipe per CI step, so a laptop and CI run the same commands | Everywhere | |
| The vendored skills: `business-rules-cel-authoring`, `business-rules-cel-debugging`, `business-rules-cel-testing` | Write, fix and cover one expression with `cel-expr`, against the generated environment | In an agent session | Each one stops when no generated environment covers the scope (G8). |

Engines are libraries, not tools. Their packages and pins are in the per-language references: [python.md](python.md),
[go.md](go.md), [rust.md](rust.md) and [typescript.md](typescript.md).
