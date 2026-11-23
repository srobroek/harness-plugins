---
name: code-challenge
description: Challenges code for scope against its design, simplification, performance, stability and structure; triggers on challenge this code.
---

# Code challenge

Challenge existing code and return findings with evidence. Plan only: this skill edits no source file. Started by the `/code-challenge` command (`auto` runs it autonomously) or by a request such as "challenge this module", "what can we simplify" or "is any of this hand-rolled".

TRIGGER
+ a request to find simplification, performance, stability, dead-code, library or structure wins in existing code
+ a request to check code against its design or docs: missing requirements, drift, scope creep, features built beyond the design
+ a large diff, a new module or a new dependency that needs a second look
- reviewing a diff for defects before merge -> `code-reviewer` agent
- a single suspected bug -> `quality-code-design`
- auditing the test suite itself -> `quality-test-audit`

GATES
ASK Running benchmarks in interactive mode, once, at INTAKE.
ASK Posting a PR or MR comment. Autonomous mode never posts.
ASK Installing an analyzer. Report a missing one as a gap.
ASK Passing `allowCode` to `challenge_scan`, unless the user said they trust the repository. Without it, report the skipped analyzers as gaps.

## Modes and depth

Mode: **interactive** (default) asks through `parley_ask`, falling back to the `question` tool, at INTAKE and DECIDE. **Autonomous** (`auto`) asks only at INTAKE, and only what the arguments and the repository cannot answer; it decides by the rule in [references/decide.md](references/decide.md) and logs every choice.

| Depth | Phases | Rules |
|---|---|---|
| `quick` | INTAKE, SCAN, CHALLENGE, DELIVER (chat report only) | no build-needing analyzers, no RESEARCH, no REFUTE, no beads; every finding is marked unrefuted |
| `standard` (default) | all seven | build-needing analyzers allowed; REFUTE checks every finding above low impact |
| `deep` | all seven | REFUTE checks every finding; RESEARCH also runs the reverse direction (dependencies replaceable by native code); benchmarks run; test protection gaps handed to `quality-test-audit` |

Each phase is also a beads formula (`mol-challenge-<phase>`) and the full run is `code-challenge`; install them with `challenge_setup`. A phase can run alone when its input file exists in the run directory. The formulas are optional tracking: the run directory holds the run's data and is the source of truth. Pour the `code-challenge` molecule only when the user wants a step per phase in beads; the pour carries the same `run_id`, and its steps do not replace the files. A run that skips the pour loses nothing.

## Rules

MUST Give every finding a lens, a locator, an impact, a blast radius and an evidence tier (`proven`, `measured` or `hypothesis`): [references/evidence.md](references/evidence.md).
MUST Record test protection (`protected`, `partial`, `unprotected`) on every simplification, library and structure finding.
MUST Write `decisions.jsonl` as you go: every decision, blocker, ambiguity, choice and inference is one JSON line, appended when it happens and never rewritten. Schema: [references/schemas.md](references/schemas.md).
MUST Store the run in `<git-dir>/code-challenge/<run-id>/`: [references/run-storage.md](references/run-storage.md).
NOT Report a performance claim without a measurement. A suspicion is a `hypothesis`.
NOT Report a finding as `proven` from analyzer output alone.
NOT Invent a lens or an analyzer rule; use the thirteen lenses below.

## Lenses

One reference per lens, each with what to look for, the evidence needed and the steering skills to load. A steering skill is optional: `lang-<language>-…` takes the target's language (`lang-go-quality`), and a skill that is not installed is skipped and named in the report's `gaps`.

| Lens | Reference |
|---|---|
| scope (design and docs conformance) | [lens-scope.md](references/lens-scope.md) |
| simplification | [lens-simplification.md](references/lens-simplification.md) |
| over-engineering | [lens-over-engineering.md](references/lens-over-engineering.md) |
| optimisation (algorithm) | [lens-optimisation.md](references/lens-optimisation.md) |
| performance (measured) | [lens-performance.md](references/lens-performance.md) |
| efficiency (waste) | [lens-efficiency.md](references/lens-efficiency.md) |
| stability | [lens-stability.md](references/lens-stability.md) |
| hand-rolled, standard library or framework | [lens-hand-rolled-stdlib.md](references/lens-hand-rolled-stdlib.md) |
| hand-rolled, third-party library | [lens-hand-rolled-library.md](references/lens-hand-rolled-library.md) |
| dead code | [lens-dead-code.md](references/lens-dead-code.md) |
| observability | [lens-observability.md](references/lens-observability.md) |
| structure (including abstraction seams) | [lens-structure.md](references/lens-structure.md) |
| tests (light, static) | [lens-tests.md](references/lens-tests.md) |

## Tools

`challenge_lib_facts` returns library facts from deps.dev, OSV, the registries and GitHub (see [references/library-scoring.md](references/library-scoring.md) for its input and output). `challenge_scan` runs the SCAN analyzers (see [references/scan.md](references/scan.md) for its input and output). `challenge_validate` checks a run's `report.json` and `decisions.jsonl` against the schemas (see [references/schemas.md](references/schemas.md)).

## Workflow

1. INTAKE: LOAD [references/intake-questions.md](references/intake-questions.md) and ask its batch (interactive), or infer the answers and ask only for a missing target or depth (autonomous). Create the run directory and `run_id`. -> `intake.json` written; the pluggability answer and its signal logged to `decisions.jsonl`.
2. SCAN: LOAD [references/scan.md](references/scan.md) and run the analyzers for the languages in the target; `quick` skips build-needing ones. `challenge_scan` runs only analyzers that execute no repository or downloaded code unless you pass `allowCode: true`; pass it only for a repository the user trusts or after asking them, and never on your own judgment for a repository you did not write. -> `scan.json` listing every hit with tool, rule, `path:line` and whether the rule is enabled in the repo, and every analyzer that could not run named as a gap.
3. CHALLENGE: for each selected lens, LOAD its reference and spawn one `code-challenger` agent per lens in parallel (reviewer tier), with a brief naming the lens, the target, the scan hits and the frozen surfaces, and for the scope lens the design sources from `intake.json`. The brief MUST list the absolute paths of `references/lens-<lens>.md` and `references/evidence.md`, resolved from the skill's base directory: a scout sees a sampled file list and otherwise reads no lens reference. When the host caps parallel subagents, group related lenses and run the scouts one after another: simplification, over-engineering and dead-code; scope alone; optimisation, performance and efficiency; the rest by pairs. A grouped brief names every lens and reference path of its group. Log the grouping as a `choice` line in `decisions.jsonl` and name it in `gaps`. Reject a scout reply that lacks the line `References read:` or lists fewer references than the brief named (every lens reference of its group plus `evidence.md`); re-ask once with the missing paths. The line ends the reply, after the agent's own `VERDICT:` first line; a brief never asks for it first. If the second reply is still short, record a gap naming the lens and the unread references, and mark its findings as read without the reference. The scouts and the critic only read and reply; you (the lead) spawn them, merge the replies, collapse one root cause into one finding, and write every file. -> `findings.json` with each finding at a locator, a tier and a test-protection value.
4. RESEARCH (standard, deep): for each library-lens finding LOAD [references/library-scoring.md](references/library-scoring.md); gather facts, score 2 to 4 candidates, apply the gates. -> `research.json` with per-criterion scores, gate results and the "keep what exists" baseline for each finding.
5. REFUTE (standard, deep): you send the findings to the `refactor-challenger` agent (reviewer tier) as a brief of observable facts only: locator, claim, tool or reading, proposal, evidence. Split a finding that bundles proposals which can be decided separately into one entry per proposal, each with its own tier, blast radius and contract flag. Keep what was observed in the code, what is inferred from it and what a command reproduced in separate fields. An empty reply is not a verdict: send the same brief again once; if the second reply is empty too, log a `blocker` line and mark those findings unrefuted. -> `verdicts.json` with KEEP, DOWNGRADE or DROP and a cited rationale per finding; a DROP leaves the offer list.
6. DECIDE: LOAD [references/decide.md](references/decide.md). Interactive: batches of up to 12 through `parley_ask`. Autonomous: accept only a surviving, `proven` or `measured`, low-blast-radius finding that keeps its contract and is not a scope finding; defer the rest. -> every finding has a status and `decided_by`, with one `decisions.jsonl` line each.
7. DELIVER: write `report.json` against [references/report.schema.json](references/report.schema.json) and `decisions.jsonl` against [references/decisions.schema.json](references/decisions.schema.json); print the report in chat; create the epic and child beads for accepted findings (standard, deep); draft the PR comment. -> both files pass `challenge_validate`, the chat report names the run directory, and the comment is posted only after the user confirms.

## Subagents

- `code-challenger`: read-only, advisory, always autonomous. It skips INTAKE and takes its target and lens from the brief. Its verdict never blocks a merge. The orchestrator may also spawn it beside `code-reviewer` for large diffs.
- `refactor-challenger`: read-only critic that attacks each finding at REFUTE. It accepts this skill's brief and the sniff skill's brief.
