---
name: grilling
description: Interviews the user relentlessly about a plan or decision in rounds; triggers on grill me or stress-test my thinking.
---

<!--
Vendored from mattpocock/skills 1.2.3, path skills/productivity/grilling/SKILL.md, copied
2026-10-08. Licensed under the MIT License, Copyright (c) 2026 Matt Pocock. The full
licence text is in the LICENSE file beside this one.

THIS FILE HAS BEEN MODIFIED from the original. Changes:
  1. Fact lookups: upstream dispatched a sub-agent for every fact from the environment.
     Cheap lookups (a few reads, one grep) now run inline; a sub-agent is reserved for
     wide exploration.
  2. Rewrote the frontmatter description to this repository's authoring contract.
  3. Ported to opencode-plugins: references to other skills name the skill instead
     of an Oh My Pi skill URI.
  4. Rounds use your preferred question tool when available, or the chat format below.
     Questions carry a node id, kind and rationale; deferred answers and notes
     feed the next round.
The design-tree framing, the frontier rounds, the round format, and the completion
condition are upstream's and are unchanged in substance.
-->

# Grilling

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

## Workflow

1. Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: questions you can ask now without guessing at answers you have not heard yet. Ask the whole frontier in one round, each question with your recommended answer and why, then wait for the answers before the next round. See **Asking questions** for the channel and format.
2. Fold the answers into the tree. An answer settles its node; a note on it becomes a constraint on the nodes below. A deferred or unanswered question stays on the frontier: decide whether to look up a fact or to ask someone else, and say which in the next round. Follow-ups belong in the next round through the same channel.
3. Each round reshapes the tree: settled decisions push the frontier outward and unblock dependent questions. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a later round.
4. Find facts yourself. Look up a fact inline when a few reads or one grep answer it. Dispatch a sub-agent only for wide exploration, and do not block on it: only questions downstream of that fact wait; ask the rest of the frontier now.
5. Decisions belong to the user: ask and wait for their answer.

## Asking questions

Write each frontier question once, with a stable `id`, short `title`, markdown `body`, `kind`, `options` when needed, `recommended`, and one-line `rationale`.

Pick the kind from the decision: `pick_one` or `show_options` for alternatives; `confirm` for yes or no; `pick_many` for several items; `rank` for an order; `slider` for a number; `ask_text` for open answers.

Use your preferred question tool when available. If no question tool is available, or it cannot handle the round, print the round in chat and wait:

```
**Q1** - **Question title** (`node.id`): question body, which may run to several
paragraphs and list several choices
> your recommended answer, because {rationale}

**Q2** - **Question title** (`node.id`): question body
> your recommended answer, because {rationale}
```

When the frontier is empty, put the settled tree to the user for approval through your preferred question tool or in chat.

## Rules

MUST End the session only when the frontier is empty: every branch of the design tree visited, nothing left silently assumed.
NOT Act on the plan before the user confirms that you share an understanding.
NOT Ask the user for a fact a read, grep, or sub-agent can find.
