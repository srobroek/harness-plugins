---
name: grilling
description: Interviews the user relentlessly about a plan or decision in rounds; triggers on grill me or stress-test my thinking.
---

Interview the user until you reach a shared understanding. Map this as a **design tree**:
every decision branches into the decisions that depend on it.

## Workflow

1. Work the tree in rounds. The frontier is every decision whose prerequisites are settled.
Ask the whole frontier in one round, with a recommended answer and why, then wait for answers.
2. Fold the answers into the tree. An answer settles its node; a note becomes a constraint on
nodes below it. A deferred or unanswered question stays on the frontier. Decide whether a fact
needs lookup or a question needs another person.
3. Each round reshapes the tree. Recompute the frontier and ask the next round. Put dependent
questions in a later round.
4. Find facts yourself. Look them up inline when a few reads or one grep can answer them.
Dispatch a sub-agent only for wide exploration, and do not block on it.
5. Decisions belong to the user. Ask and wait for their answer.

## Asking questions

Write each frontier question once, with a stable `id`, short `title`, markdown `body`, `kind`,
`options` when needed, `recommended`, and one-line `rationale`.

Pick the kind from the decision: `pick_one` or `show_options` for alternatives; `confirm` for yes
or no; `pick_many` for several items; `rank` for an order; `slider` for a number; `ask_text` for
open answers.

Deliver each round through your preferred question tool when available. In OMP that is usually
the interactive `ask` tool: send one question per call, with the title as the header, the first
paragraph plus `Why: {rationale}` as the question, and the recommended option first with
`(Recommended)` on its label. Use Yes/No for `confirm`, multiple choice for `pick_many`, preset
values for `slider`, and one `Use recommended` option for `rank` and `ask_text`.

If no question tool is available, or the tool cannot handle the round, print the round in chat
and wait:

```
**Q1** - **Question title** (`node.id`): question body, which may run to several
paragraphs and list several choices
> your recommended answer, because {rationale}

**Q2** - **Question title** (`node.id`): question body
> your recommended answer, because {rationale}
```

When the frontier is empty, put the settled tree to the user for approval through your
preferred question tool or in chat.

## Rules

MUST End the session only when the frontier is empty: every branch visited, nothing left
silently assumed.
NOT Act on the plan before the user confirms that you share an understanding.
NOT Ask the user for a fact a read, grep, or sub-agent can find.
