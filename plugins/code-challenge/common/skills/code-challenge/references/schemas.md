# Report and decisions schemas

Two JSON Schemas (draft 2020-12) ship beside this file. Validate before DELIVER ends and fix the file, not the schema: call `challenge_validate` with the absolute run directory. It checks `report.json` and every line of `decisions.jsonl` and lists each error with its file and line.

| File | Validates |
|---|---|
| [report.schema.json](report.schema.json) | `report.json`: the run header, a summary, and one object per finding |
| [decisions.schema.json](decisions.schema.json) | each line of `decisions.jsonl` |

## Finding

A finding is one root cause. When the same cause recurs, report it once: `location` is the first or clearest site, `also_at` lists the other sites, and `recurs` is the total count (one more than the length of `also_at`).

| Field | Meaning |
|---|---|
| `id` | `F1`, `F2`, ... stable for the run |
| `lens` | one of the 12 lenses; see [lens-simplification.md](lens-simplification.md) and its siblings |
| `location` | `path` and `line` of the code challenged |
| `also_at` | the other `path` and `line` sites of a recurring cause; absent when `recurs` is 1 |
| `evidence.tier` | `proven`, `measured` or `hypothesis`; see [evidence.md](evidence.md) |
| `impact` | value if applied: `high`, `medium` or `low` |
| `blast_radius` | how much code and how many callers the change touches |
| `changes_contract` | true when a public signature, wire format, config key or documented behaviour changes; never `low` blast radius |
| `test_protection` | `protected`, `partial` or `unprotected` for simplification, library and structure findings; `not-applicable` otherwise |
| `refute` | the REFUTE verdict and rationale; absent at `quick` depth |
| `status` | `accepted`, `deferred`, `rejected` (the user said no) or `dropped` (REFUTE said DROP) |
| `decided_by` | `user`, or `autonomous-rule` when the autonomous acceptance rule fired |

## Decisions line

Log every decision, blocker, ambiguity, choice and inference the moment it happens, in the phase that made it. `by` is `user` for an answer the user gave, `agent` for a judgement call, `autonomous-rule` when the rule in [decide.md](decide.md) fired. A line carries the alternatives considered when there were any.

Example line:

```json
{"ts":"2026-11-20T10:15:00Z","run_id":"20261120-101200-lib","phase":"INTAKE","kind":"inference","subject":"pluggability expected","choice":"yes","reason":"two storage providers implement StoreClient","by":"agent"}
```
