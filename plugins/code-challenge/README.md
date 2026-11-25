# code-challenge

Challenge existing code for simplification, performance, stability, hand-rolled code and structure. Every finding carries a locator and an evidence tier (`proven`, `measured` or `hypothesis`). The plugin plans; it never edits source.

The plugin ships to OpenCode and OMP (`harnesses: ["opencode", "omp"]`). It has no Claude Code tree: the skill needs the `challenge_*` tools and subagents.
## Install

```sh
pi install npm:@srobroek/pi-code-challenge
```

## Use

`/code-challenge [auto] [quick|standard|deep] [target]` loads the `code-challenge` skill. `auto` runs it autonomously: INTAKE is the only phase that asks questions, and then only what the arguments and the repository cannot answer.

| Depth | Phases |
| --- | --- |
| `quick` | INTAKE, SCAN, CHALLENGE, DELIVER (chat report only; no build-needing analyzers, no REFUTE) |
| `standard` (default) | INTAKE, SCAN, CHALLENGE, RESEARCH, REFUTE, DECIDE, DELIVER |
| `deep` | standard, with every finding refuted, the reverse dependency direction researched and benchmarks run |

A run stores its files in `<git-dir>/code-challenge/<run-id>/`: `intake.json`, `scan.json`, `findings.json`, `research.json`, `verdicts.json`, `decisions.jsonl`, `report.json` and `report.md`. The two JSON Schemas for `report.json` and `decisions.jsonl` ship in the skill's `references/`.

## Lenses

Thirteen lenses, one reference each: scope (the code against its design and docs: missing requirements, drift, unrequested features and features built beyond the design), simplification, over-engineering, optimisation, performance, efficiency, stability, hand-rolled code (standard library or framework), hand-rolled code (third-party library), dead code, observability, structure and tests. Each reference lists what to look for, the evidence it needs and the steering skills to load (`quality-profiling`, `lang-*-profiling`, `lang-*-libraries`, `lang-*-quality`, `toolchain-quality-observability`, `quality-code-policy`, `quality-test-audit`).

## Pi subagent tools

`code-challenger` adds `symbol_search`, `module_report`, `project_report`, `read_symbol`, `read_enclosing`, `ast_grep_search`, `ast_grep_outline`, `lens_diagnostics`, `pi_lens_activate_tools`, `web_search`, `fetch_content`, `get_search_content`, `source_check`, `quality_test_summarize`, `quality_test_compare`, `repomix_pack`, `dep_scan`, `version_gap_scan`, and `mcp:context7` to its existing tools.

`refactor-challenger` adds `symbol_search`, `module_report`, `project_report`, `read_symbol`, `read_enclosing`, `ast_grep_search`, `ast_grep_outline`, `lens_diagnostics`, `pi_lens_activate_tools`, `quality_test_summarize`, `quality_test_compare`, `repomix_pack`, `dep_scan`, `version_gap_scan`, and `mcp:context7` to its existing tools.

`code-challenger` can use `quality-test-audit` from the Pi skills catalog loaded by `@srobroek/pi-code-quality`.


Pi-lens keeps `ast_grep_search` and `ast_grep_outline` inactive until `pi_lens_activate_tools` runs; activation takes effect on the next turn. `lsp_navigation` and `ast_grep_replace` are not granted.

Required Pi packages: `pi-lens`, `pi-web-access`, `@srobroek/pi-code-quality`, `@srobroek/pi-repomix`, `@srobroek/pi-dep-update`, and `@srobroek/pi-whats-new`. Configure the `context7` Pi MCP server in `~/.pi/agent/mcp.json` for `mcp:context7`.

## Agents

| Agent | Tier | Role |
| --- | --- | --- |
| `code-challenger` (steps 60) | reviewer | Read-only and advisory. Always autonomous: skips INTAKE and takes its target and lens from the brief. Never a blocking verdict. One per lens at CHALLENGE. |
| `refactor-challenger` (steps 60) | reviewer | Read-only critic at REFUTE. Accepts the sniff brief and the code-challenge brief. Attacks library swaps (maintenance, edge-case coverage, migration cost), performance claims without a measurement, simplifications that drop behaviour, and changes to code no test protects. |
## Developing this plugin

Maintainers build the composed agents with `bun run build` from `agents.src/` and
the shared review core. The Pi source is `pi-src/index.ts`; the maintainer build
bundles it to `pi/extensions/index.js` and copies it to `omp/extensions/index.js`.
OMP loads Pi extensions unchanged. Both agents are composed from `agents.src/` and
the shared review core; `refactor-challenger` also ships in `sniff` until the
change dropping its copy is released. Do not release this plugin before that
sniff release. Bun is used for maintainer builds, not required at plugin runtime.

## Tools

| Name | Kind | Purpose |
| --- | --- | --- |
| `/code-challenge` | command | Load the skill with the mode, depth and target |
| `challenge_setup` | tool | Copy the formulas into a beads workspace's `.beads/formulas/` |
| `challenge_lib_facts` | tool | Registry, OSV and GitHub facts for 1 to 6 packages (npm, pypi, crates, go); facts only |
| `challenge_validate` | tool | Check a run's `report.json` and `decisions.jsonl` against the shipped JSON Schemas |
| `challenge_scan` | tool | Run the SCAN analyzers and return normalised candidates. Recipes that run repository or downloaded code run only with `allowCode: true` |

## OMP

The OMP tree has the same skill, agents and formulas. Its extension registers the four tools and `/code-challenge`. The tools take the same parameters as the OpenCode ones and return the same text, with the OpenCode metadata as `details`.

Skill text: the `*.omp.md` files name OMP's `ask` and `read` tools instead of OpenCode's `question` tool and `webfetch`. The CHALLENGE brief names each lens reference by its `skill://code-challenge/references/` URI.

## Code-running analyzers

Some recipes execute repository or downloaded code: clippy, golangci-lint, deadcode, knip, import-linter and the one-off `bunx`, `uvx` and `go run` runs.

- By default `challenge_scan` skips them. Each one is a coverage gap that names what it would run and says to pass `allowCode: true`.
- With `allowCode: true`, every planned recipe runs.
- The tool shows no dialog, so it behaves the same with and without an interactive UI, in OpenCode and in OMP.
- The skill passes `allowCode` only for a repository the user trusts, or after asking them.
- In OMP the tool declares the `exec` approval tier, so OMP's approval mode governs each call, and a `tools.approval.challenge_scan: deny` entry blocks it.

`allowCode` replaced `staticOnly` in 2.0.0. The default now runs static recipes only, and no call asks for consent.

## Beads formulas

`challenge_setup` installs nine formulas. Pour the full run with `bd mol pour code-challenge --var target=<paths> --var run_id=<run-id>`. Each phase also runs alone as `mol-challenge-<phase>` (`intake`, `scan`, `challenge`, `research`, `refute`, `decide`, `deliver`) with `--var target= --var run_id= --var depth= --var mode=`. The lead agent sequences the phases and writes every file, bead and log line. Only two steps route to a subagent, both read-only: `mol-challenge-lens` (`analyse-lens`, to `code-challenger`, bonded once per lens by `mol-challenge-challenge`) and `mol-challenge-refute` (`attack-findings`, to `refactor-challenger`). The formulas declare what those steps need in `requires_actions`, and a test checks that the agent's permissions allow it.
