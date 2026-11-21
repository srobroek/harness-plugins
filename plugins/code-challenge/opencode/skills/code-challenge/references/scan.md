# SCAN

Phase SCAN uses analyzers the repository can already run, with an isolated lens profile that does not edit repo config and respects its suppressions. No custom rules and no sandbox. A hit from a rule the repository does not enable is tagged "rule not enabled in repo".

Run analyzers through `challenge_scan` (ships in a later PR with per-language recipes). Until it ships, run the commands below with the shell tool, read-only, and write the normalised hits to `scan.json`.

| Language | Analyzers | Needs a build |
|---|---|---|
| TypeScript | `biome`, `oxlint` (perf rules), `@e18e/depend`, `knip` | knip with project references |
| Python | `ruff` (SIM, PERF, FURB, UP, C4, PIE, RET, TRY, BLE, ASYNC, LOG, G, T20, ERA, F401, F841), `vulture` | no |
| Go | `golangci-lint` (staticcheck, unused, prealloc, perfsprint, gocritic, modernize, usestdlibvars, bodyclose, sloglint), `deadcode` | yes |
| Rust | `cargo clippy` (perf, complexity, suspicious, `manual_*`), `cargo-machete` | yes |
| All | `lizard` (cyclomatic complexity and function length) | no |

Rules:
- `quick` depth runs no analyzer that needs a build.
- A missing analyzer is a gap in the report, never an install without asking. Detect with `command -v`; install commands live in `lang-*-quality`.
- A hit is a lead for CHALLENGE; it becomes a finding only with its own evidence.
- Record per hit: tool, rule, `path:line`, message, `rule_enabled_in_repo`.
