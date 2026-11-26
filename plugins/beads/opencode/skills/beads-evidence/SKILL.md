---
name: beads-evidence
description: The evidence every Beads close needs beyond the bd prime reason string; load before closing or reviewing a bead.
metadata:
  opencode/autoinvoke: false
---

`bd prime` documents `bd close ID --reason` without saying what a reason must
contain. This skill sets that bar.

MUST include checkable evidence with every close: the command run, the file path
changed, or the test result. A reason that only restates the title is not
evidence.
MUST treat a completion claim without evidence as not closed.
MUST have the worker finish, record evidence, and report; a worker NEVER closes its own bead. The PARENT or a REVIEWER closes the bead only after review.

## When to close

Record the acceptance verdict when the reviewer verifies the work. Close only after the delivery requirement named on the bead is also met:

| Delivery requirement | Evidence for closure |
|---|---|
| PR merge | A landing receipt or verified merge for the reviewed change. Passing checks on an open PR are insufficient. |
| Accepted result without a PR | The accepted deliverable and the coordinator's or reviewer's verdict. No merge is required. |
| Deployment or sign-off | Evidence of the required deployment or approval. A merge alone is insufficient. |

If acceptance passes before delivery, leave the bead open and record the remaining step and its owner. For a feature or epic, check the parent's own requirements before closing it.

## Check a handoff

Use `work_check.py` beside this skill. It reads one bead in the active ledger. It never runs commands from a comment or changes the issue. Use the full bead ID. Supply the expected actor and unique event ID from the assignment, not from the comment under review. Use the work unit's completion time as the inclusive lower bound, at the ledger's timestamp precision.

For `progress`, the worker posts one comment starting with `beads-work/v1 ` followed by JSON:

```text
beads-work/v1 {"kind":"progress","event":"job-42","result":"Parser rejects an empty header","evidence":"test run 19, parser/empty passed","next":"review"}
```

```sh
python3 work_check.py progress proj-42 --actor worker --event job-42 --since 2026-01-01T12:00:00Z
```

A helper without ledger access returns its result to the coordinator. The coordinator posts the checkpoint under its own actor. Check that actor and the helper's event ID.

For `acceptance`, the coordinator or reviewer checks the evidence against the actual artifact first. Post a verdict for each nonblank line of the bead's acceptance criteria. Use distinct lines. Copy the criterion text exactly, ignoring surrounding whitespace. Name the commit or artifact digest the reviewer inspected:

```text
beads-work/v1 {"kind":"acceptance","event":"job-42","subject":"<commit>","checks":[{"criterion":"Reject an empty header","verdict":"pass","evidence":"CI run 19, parser/empty"}]}
```

```sh
python3 work_check.py acceptance proj-42 --actor reviewer --event job-42 --subject "$reviewed_head" --since 2026-01-01T12:00:00Z
```

The latest matching comment by that actor decides the result. Exit 0 means the record matches. Exit 1 means missing or insufficient evidence. Exit 2 means invalid input or unavailable ledger data. A matching attestation does not prove the cited test ran, authorize a close, or establish that a PR merged. Check the delivery requirement separately.
