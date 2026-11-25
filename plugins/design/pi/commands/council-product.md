---
description: Run a bounded product decision council with the UX, end-user, advocate and skeptic advisors
argument-hint: "<question> [--scope ...] [--non-goals ...]"
---

Run a council on the user's product question and constraints at the end of this prompt. If the user gave no question, ask for one.

1. Before you orchestrate, call `subagent({ action: "guide", options: { topic: "council" } })`.
2. Read the council protocol it returns and follow it, with its required references. Do not type or invoke another slash command.
3. Use exactly this roster: `council-ux,council-user,council-advocate,council-skeptic`.
4. Cap the council at three passes.
5. Frame the question with these parts:
   - the product or UI decision, and who it is for
   - scope and non-goals
   - evidence targets
   - evidence on the users and the tasks the decision touches: research, analytics, journeys, support notes
   - evidence on the design system and the current surface: tokens, components, `DESIGN.md`, rendered-surface reports
6. Tell the user the roster, the known context modes and the pass cap.
7. Ask every advisor for an independent assessment. Each advisor challenges the framing and cites evidence.
8. Run the independent first pass with the council protocol.
9. Synthesize the reports. Cross-examine only disputed claims and missing proof.
10. Write the council memo. You alone decide which feedback holds.

Question and options:

$@
