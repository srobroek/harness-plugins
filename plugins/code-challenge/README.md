# code-challenge

Challenge existing code for simplification, performance, stability, hand-rolled code and structure. Every finding carries a locator and an evidence tier (`proven`, `measured` or `hypothesis`). The plugin plans; it never edits source.

OpenCode only: the skill depends on OpenCode tools (`parley_ask`, `challenge_*`, subagents). The plugin sets `harnesses: ["opencode"]` in its `agent-plugins` key, so the build ships no Claude Code tree.

## Use

`/code-challenge [auto] [quick|standard|deep] [target]` loads the `code-challenge` skill. `auto` runs it autonomously: INTAKE is the only phase that asks questions, and then only what the arguments and the repository cannot answer.

| Depth | Phases |
| --- | --- |
| `quick` | INTAKE, SCAN, CHALLENGE, DELIVER (chat report only; no build-needing analyzers, no REFUTE) |
| `standard` (default) | INTAKE, SCAN, CHALLENGE, RESEARCH, REFUTE, DECIDE, DELIVER |
| `deep` | standard, with every finding refuted, the reverse dependency direction researched and benchmarks run |

A run stores its files in `<git-dir>/code-challenge/<run-id>/`: `intake.json`, `scan.json`, `findings.json`, `research.json`, `verdicts.json`, `decisions.jsonl`, `report.json` and `report.md`. The two JSON Schemas for `report.json` and `decisions.jsonl` ship in the skill's `references/`.

## Lenses

Twelve lenses, one reference each: simplification, over-engineering, optimisation, performance, efficiency, stability, hand-rolled code (standard library or framework), hand-rolled code (third-party library), dead code, observability, structure and tests. Each reference lists what to look for, the evidence it needs and the steering skills to load (`quality-profiling`, `lang-*-profiling`, `lang-*-libraries`, `lang-*-quality`, `toolchain-quality-observability`, `quality-code-policy`, `quality-test-audit`).

## Agents

| Agent | Tier | Role |
| --- | --- | --- |
| `code-challenger` (steps 60) | standard | Read-only and advisory. Always autonomous: skips INTAKE and takes its target and lens from the brief. Never a blocking verdict. One per lens at CHALLENGE. |
| `refactor-challenger` (steps 60) | reviewer | Read-only critic at REFUTE. Accepts the sniff brief and the code-challenge brief. Attacks library swaps (maintenance, edge-case coverage, migration cost), performance claims without a measurement, simplifications that drop behaviour, and changes to code no test protects. |

Both are composed by `bun run build` from `agents.src/` and the shared review core.

`refactor-challenger` also ships in the `sniff` plugin until the sniff change that drops its copy is released. An agent id belongs to one plugin, so do not release this plugin before that sniff release.

## Tools and command

| Name | Kind | Purpose |
| --- | --- | --- |
| `/code-challenge` | command | Load the skill with the mode, depth and target |
| `challenge_setup` | tool | Copy the formulas into a beads workspace's `.beads/formulas/` |
| `challenge_scan`, `challenge_lib_facts` | tools | Planned, ship in a later PR. The skill names them and falls back to the shell and `webfetch` until then |

## Beads formulas

`challenge_setup` installs nine formulas. Pour the full run with `bd mol pour code-challenge --var target=<paths> --var run_id=<run-id>`. Each phase also runs alone as `mol-challenge-<phase>` (`intake`, `scan`, `challenge`, `research`, `refute`, `decide`, `deliver`) with `--var target= --var run_id= --var depth= --var mode=`. The lead agent sequences the phases and writes every file, bead and log line. Only two steps route to a subagent, both read-only: `mol-challenge-lens` (`analyse-lens`, to `code-challenger`, bonded once per lens by `mol-challenge-challenge`) and `mol-challenge-refute` (`attack-findings`, to `refactor-challenger`). The formulas declare what those steps need in `requires_actions`, and a test checks that the agent's permissions allow it.
