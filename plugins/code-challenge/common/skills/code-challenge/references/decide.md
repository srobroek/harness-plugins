# DECIDE and DELIVER

## DECIDE

Input: findings that survived REFUTE (KEEP or DOWNGRADE). `DROP` findings are listed in the report as dropped and are not offered.

Order by impact, then evidence tier (`proven` and `measured` first), then low blast radius.

### Interactive

Offer findings through `parley_ask` (fallback: the `question` tool) in batches of up to 12, highest impact first. Each question shows the finding id, title, evidence tier, `test_protection`, the proposal and a recommended answer. Choices: accept, defer, reject. Log each answer to `decisions.jsonl` with `by: user`. Findings the user does not reach stay `deferred`.

### Autonomous

No questions. Accept a finding only when all hold:
1. REFUTE verdict is KEEP (after downgrade it is a DOWNGRADE, which defers).
2. Evidence tier is `proven` or `measured`.
3. `blast_radius` is `low` and `changes_contract` is not true.
4. The lens is not `scope`. Whether the code or the design is wrong is the user's call.

When REFUTE ran, its `tier`, `blast_radius` and `changes_contract` for a finding replace the scout's: the critic checked the claim apart from the scout, so its values are the ones the rule reads. Write them into the finding and log each changed value as a `choice` line naming the old and the new value. A field the critic left empty keeps the scout's value, and the empty field is a gap. A bug fix that restores documented behaviour and keeps every public signature, wire format and config key does not change the contract; if it changes any of those, the critic's `changes_contract: true` stands.

Everything else is `deferred`. Set `decided_by: autonomous-rule` and log one line per finding, plus a line for every blocker, ambiguity and choice made along the way. Autonomous mode never edits code, never posts, and never asks.

## DELIVER

1. Write `report.json` (validate against `report.schema.json`) and `report.md`; print `report.md` in chat with the run directory path. Start with counts, then accepted findings, then deferred ones.
2. Standard and deep depth: create a beads epic for the run and one child bead per accepted finding, carrying the finding's evidence, proposal and test protection. Without `bd`, list the findings in the report and say so in `gaps`.
3. Draft a PR or MR comment in `comment_draft` when the target is a branch with an open PR. Post it only after the user confirms; autonomous mode never posts.
4. Plan only. Hand accepted beads to the coder on approval; this skill changes no source file. Hand deep test-suite work to `quality-test-audit`.
5. List every gap: missing analyzers, benchmarks not run, areas not read, lenses skipped.
