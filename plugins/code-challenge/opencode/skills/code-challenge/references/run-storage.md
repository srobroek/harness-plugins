# Run storage

Every run writes to `<git-dir>/code-challenge/<run-id>/`, so nothing lands in the working tree and `git status` stays clean. Resolve the directory with `git rev-parse --git-dir` (in a linked worktree this is the worktree's own git directory). Create it with `mkdir -p`.

`<run-id>` is `YYYYMMDD-HHMMSS-<slug>`, the UTC start time plus a slug of the target (lowercase, `-` separated, at most 24 characters). Reuse the id to resume: a phase whose file exists is complete, so skip it unless the user asks to redo it.

| File | Written by | Content |
|---|---|---|
| `intake.json` | INTAKE | the answers from [intake-questions.md](intake-questions.md) |
| `scan.json` | SCAN | analyzer hits, each with tool, rule, `path:line`, and `rule_enabled_in_repo` |
| `findings.json` | CHALLENGE | one finding per root cause, schema in [schemas.md](schemas.md) |
| `research.json` | RESEARCH | candidate libraries with scores and gate results |
| `verdicts.json` | REFUTE | KEEP, DOWNGRADE or DROP per finding, with the rationale |
| `decisions.jsonl` | every phase | append-only log, one JSON object per line |
| `report.json` | DELIVER | the final report, validated by `report.schema.json` |
| `report.md` | DELIVER | the same report as the chat message |

Rules:
- Append to `decisions.jsonl`, never rewrite it.
- Write each phase file once, at the end of the phase, before the next phase starts.
- Never commit the directory. Quote its path in the report so the user can open it.
- Delete nothing. The user prunes old runs.
