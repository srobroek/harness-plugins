# SCAN

Phase SCAN uses analyzers the repository can already run, with an isolated lens profile that does not edit repo config and respects its suppressions. No custom rules and no sandbox. A hit from a rule the repository does not enable is tagged "rule not enabled in repo".

Run analyzers through `challenge_scan`. It plans per language, lens and depth, runs each recipe and returns normalised candidates plus a coverage list. Write the result to `scan.json`.

Input (all optional):
- `root`: target root; default the session directory.
- `files`: files, directories or globs inside the root to scope the scan.
- `languages`: `ts`, `python`, `go`, `rust`; auto-detected by default.
- `lenses`: lenses to keep; all by default.
- `depth`: `quick`, `standard` (default) or `deep`.
- `timeoutSeconds`: per analyzer, default 120, at most 900.
- `runId`: raw tool output goes to `<git-dir>/code-challenge/<runId>/scan/`.
- `staticOnly`: run only recipes that execute no repository or downloaded code. Nothing is asked; the others are gaps.

Output (JSON text): `root`, `languages`, `depth`, `candidates`, `candidateCount`, `truncated` (inline list capped at 500), `coverage`, `timings` and `rawDir`. A candidate is `{lens, tool, rule, file, line, message, ruleEnabledInRepo}`. `file` and `line` are `null` when the tool gave none (for example an import-linter module with no file). `ruleEnabledInRepo` is `true` or `false` where the scan could tell (ruff, golangci-lint) and `null` otherwise. A coverage entry is `{recipe, tool, language, status, reason?}` with status `ran`, `skipped` or `gap`.

Consent: recipes that execute repository or downloaded code (clippy, golangci-lint, deadcode, knip, import-linter, and every one-off `bunx`, `uvx` or `go run`) are listed in one prompt, bound to the root and exactly those recipes. Approval runs only that set; a recipe that turns risky later is a gap ("not approved for this run"). A plan with no such recipe asks nothing. Rejecting the prompt ends the step; to scan without those recipes, pass `staticOnly`.

| Language | Analyzers | Needs a build |
|---|---|---|
| TypeScript | `biome`, `oxlint` (perf rules), `@e18e/depend`, `knip` | knip with project references |
| Python | `ruff` (SIM, PERF, FURB, UP, C4, PIE, RET, TRY, BLE, ASYNC, LOG, G, T20, ERA, F401, F841), `vulture` | no |
| Go | `golangci-lint` (staticcheck, unused, prealloc, perfsprint, gocritic, modernize, usestdlibvars, bodyclose, sloglint), `deadcode` | yes |
| Rust | `cargo clippy` (perf, complexity, suspicious, `manual_*`), `cargo-machete` | yes |
| All | `lizard` (cyclomatic complexity and function length) | no |

Rules:
- `quick` depth runs no analyzer that needs a build.
- A missing analyzer is a gap in the report, never an install. Install commands live in `lang-*-quality`.
- Use the analyzer version the repository pins: its own `node_modules/.bin`, lockfile or toolchain file, not a global shim at another version. In a checkout without installed dependencies (no `node_modules`, no virtualenv), the pinned tools are a gap ("dependencies not installed"); never run `bun install`, `npm ci`, `uv sync` or the like to fill it. Ask the user to install, or report the gap.
- Zero hits from a run whose tools did not start is a gap, never a clean result.
- Output a tool did not produce in its format is a gap, never "no findings".
- A hit is a lead for CHALLENGE; it becomes a finding only with its own evidence.
- Record per hit: tool, rule, `path:line` (null when unknown), message, `rule_enabled_in_repo` (from `ruleEnabledInRepo`).
