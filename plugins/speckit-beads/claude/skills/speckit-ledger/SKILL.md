---
name: speckit-ledger
description: Use when a SpecKit command writes, reads or changes a feature's tasks; they live as beads under the implement step, never in tasks.md.
---

# SpecKit ledger

A SpecKit feature keeps its tasks as beads under the `implement` step of its molecule.
`specs/<NNN-slug>/tasks.md` holds no state. Nothing creates, edits or copies it, and the
speckit-beads plugin refuses the write. Once per session, run `bd prime` for the general
`bd` reference. This skill adds only the SpecKit conventions.

## Find the implement step

1. `bd query 'spec_id="<NNN-slug>"' --json` lists the spec's beads. The run root is the
   epic or molecule titled `speckit-basic`, `speckit-lean` or `speckit-feature`.
2. `bd mol current <root-id>` shows the steps. Note the id of the `implement` step.

## Write the task graph

Where `/speckit.tasks` says to write `tasks.md`, write `specs/<NNN-slug>/tasks.graph.json`
with the same breakdown:

```json
{
  "nodes": [
    {
      "key": "T001",
      "title": "Add the parser",
      "description": "What to change and where.",
      "parent_id": "<implement-step-id>",
      "spec_id": "<NNN-slug>",
      "acceptance_criteria": "The observable result that proves it done."
    },
    {
      "key": "T002",
      "title": "Wire the parser into the CLI",
      "parent_id": "<implement-step-id>",
      "spec_id": "<NNN-slug>",
      "acceptance_criteria": "The CLI reads its input through the parser.",
      "metadata": { "execution_agent_type": "<agent>" }
    }
  ],
  "edges": [{ "from_key": "T002", "to_key": "T001", "type": "blocks" }]
}
```

| Field | Rule |
| --- | --- |
| `key` | Unique within the file. Reuse the task ids of the upstream breakdown (`T001`). |
| `parent_id` | The implement step's id, on every node. |
| `spec_id` | The spec id, on every node. `bd list --spec` and `bd query` find tasks by it. |
| `acceptance_criteria` | On every node. Name an observable result, not an activity. |
| `metadata` | Routing only, such as `execution_agent_type` where the project routes tasks to named agents. Leave it out otherwise. |
| `edges` | Top level. `from_key` waits for `to_key`. Add an edge only for a true dependency. Tasks that the breakdown marks `[P]` get none. |

## Create and read back

1. `bd create --graph specs/<NNN-slug>/tasks.graph.json --dry-run --json`. Fix every
   error and warning first: `bd` drops unknown fields with a warning.
2. `bd create --graph specs/<NNN-slug>/tasks.graph.json --json`. It prints the bead id
   of each key.
3. `bd list --parent <implement-step-id> --json`. Compare each task with the file:
   - the title and `spec_id`
   - the acceptance criteria
   - the dependencies
4. Report the bead ids.

A second live create adds every node again. After a failed create, read the tasks back
first. Then add only the missing tasks, one at a time.

## Change tasks later

- Add a task: `bd create "<title>" --parent <implement-step-id> --spec-id <NNN-slug> --acceptance "<criteria>" --json`.
- Add a dependency: `bd dep add <waiting-id> <prerequisite-id>`.
- Fix coverage or wording, as `/speckit.analyze` findings ask: `bd update <id> --acceptance "…"` or `--description "…"`.
- Read the tasks wherever a command reads `tasks.md`: `bd list --parent <implement-step-id> --json`.

The graph file is input to one create. Beads holds the state afterwards, so do not edit
the file to record progress.

## Work the tasks

`bd ready` picks work, `bd update <id> --claim` claims it and `bd close <id> --reason "<evidence>"`
closes it. Keep the implement step open until you close its last child.

## Never

- Write `tasks.md` to get past a check. Skip `check-prerequisites.sh --require-tasks` and
  read the beads instead.
- Mirror the tasks into a second tracker. The plugin refuses the taskstoissues commands.
  Link an existing GitHub issue with `bd update <id> --external-ref gh-<number>` instead.
