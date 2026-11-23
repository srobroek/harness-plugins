# Intake questions

Phase INTAKE. Ask in one batch with `parley_ask`; fall back to the `ask` tool when parley is absent. Put a recommended answer on every question. Autonomous mode asks only what the command arguments and the repository cannot answer, and logs each inference to `decisions.jsonl` with kind `inference`.

| # | Question | Default when unanswered | Inferred from (autonomous) |
|---|---|---|---|
| 1 | Target: which paths, packages or diff range? | the whole repository | command argument, current branch diff |
| 2 | Depth: `quick`, `standard` or `deep`? | `standard` | argument; `quick` for a diff under 300 lines |
| 3 | Lenses: all 13, or a subset? | all 13 | a lens named in the request |
| 4 | Is pluggability expected (more backends or providers, or frequent change in this area)? | no | see the seam signals below |
| 5 | Which behaviour is frozen (public API, wire format, config keys, CLI flags)? | the public surface (see below) and everything documented | exports, docs, schema files |
| 6 | May the run execute benchmarks and build-needing tools? (No: the performance lens is dropped, see [lens-performance.md](lens-performance.md).) | interactive: ask once; autonomous: yes at `standard` and `deep` | depth |
| 7 | How are tests run, and how long do they take? | the repo's check command | `package.json` scripts, `justfile`, CI |
| 8 | Deliver beads for accepted findings and a PR comment draft? | beads yes, comment no | an open PR for the branch |
| 9 | Which documents define what the target must do (spec, plan, decision record, bead, issue, PR description)? | every design source that the search below finds | see the design sources below |

## Public surface (question 5 default)

An `export` keyword alone does not make code public. Freeze what a consumer outside the module tree can reach:
- the package's entry points: the files its manifest names (`main`, `exports`, `bin`, a plugin's registered entry) and what they export;
- registered tool, command and hook names and their schemas, wire formats, config keys and CLI flags;
- a shared library's exports that have an importer outside their own package;
- anything the docs describe.

An export that is none of the frozen surfaces above and has no importer outside its own module tree (none in other packages, `tests/` or `scripts/`) is internal. An entry point counts as frozen even with no source importer, because the host loads it through its manifest. Removing an internal export changes no contract: a dead-code finding for it may carry `blast_radius: low` and `changes_contract: false`, provided the reachability searches in [lens-dead-code.md](lens-dead-code.md) found no importer. Log the frozen list to `intake.json`.

## Design sources (question 9, autonomous)

The scope lens ([lens-scope.md](lens-scope.md)) reads these sources. Collect every one that exists and covers the target, and log each with its path or id:
- `specs/<feature>/`: `spec.md`, `plan.md` and `tasks.md`
- `docs/`, the decision records in `docs/adr/` or `docs/decisions/`, and the README sections about the target
- the bead named in the branch name or the commit messages: `bd show <id>` gives its description, design and acceptance fields and its parent epic
- the open PR or MR description, and the issues it links

When the search finds no source, the answer is "none", and the scope lens checks only the docs against the code.

## Pluggability signals (question 4, autonomous)

Answer yes when at least one holds, and log which one:
- two or more implementations of one interface, or two or more providers of one kind
- provider config keys (`provider`, `backend`, `driver`, `adapter`) in config or schema files
- the roadmap, README or `docs/` mention more backends, providers or plugins
- an existing `adapters/`, `providers/` or `backends/` directory

Answer no otherwise. With no signal, an extra abstraction layer is an OVER-ENGINEERING finding, never a STRUCTURE gap.

## Output

Write `intake.json` in the run directory (see [run-storage.md](run-storage.md)): target, depth, lenses, pluggable (bool plus the signal), frozen surfaces, benchmark allowance, test command, delivery choices, design sources.
