# UX Copy Guidance

Design-source connectors are out of scope. Take context from code and the running surface instead: the `design-system-audit` skill for the system, and the `ui-review` skill to read character budgets and truncation in place.

## Principles

1. **Clear**: Say exactly what you mean. No jargon, no ambiguity.
2. **Concise**: Use the fewest words that convey the full meaning.
3. **Consistent**: Same terms for the same things everywhere.
4. **Useful**: Every word should help the user accomplish their goal.
5. **Human**: Write like a helpful person, not a robot.

## Copy Patterns

### CTAs
- Start with a verb: "Start free trial", "Save changes", "Download report"
- Be specific: "Create account" not "Submit"
- Match the outcome to the label

### Error Messages
Structure: What happened + Why + How to fix
- "Payment declined. Your card was declined by your bank. Try a different card or contact your bank."

### Empty States
Structure: What this is + Why it's empty + How to start
- "No projects yet. Create your first project to start collaborating with your team."

### Confirmation Dialogs
- Make the action clear: "Delete 3 files?" not "Are you sure?"
- Describe consequences: "This can't be undone"
- Label buttons with the action: "Delete files" / "Keep files" not "OK" / "Cancel"

### Tooltips
- Concise, helpful, never obvious

### Loading States
- Set expectations, reduce anxiety

### Onboarding
- Progressive disclosure, one concept at a time

### Landing and Docs Pages
Structure: What it is + Who it serves + What it does for them + Where to go next
- Read the project's README, design plan, architecture overview and the ADRs or specs a page summarises before you write it. Describe the product from them, not from the last change.
- Write lasting documentation. A reader next year should find every sentence still true.
- Mark planned capability as planned, in a short label or aside, never as working and never as a progress diary.
- Leave out dates and status words ("today", "currently", "as of", "so far", "for now") from hand-written prose. Phase or release status belongs in generated data.
- Leave out repository history: commits, branches, rebases, "previously", "replaced", "was added". Changelogs and release notes carry that.
- Hero: one line that names the product and its outcome. Calls to action name the destination ("Read the plan", "Contracts").
- Feature card: the concept's name, then one sentence on what it gives the user.

## Voice and Tone

Adapt tone to context:
- **Success**: Celebratory but not over the top
- **Error**: Empathetic and helpful
- **Warning**: Clear and actionable
- **Neutral**: Informative and concise

## Output Template

```markdown
## UX Copy: [Context]

### Recommended Copy
**[Element]**: [Copy]

### Alternatives
| Option | Copy | Tone | Best For |
|--------|------|------|----------|
| A | [Copy] | [Tone] | [When to use] |
| B | [Copy] | [Tone] | [When to use] |
| C | [Copy] | [Tone] | [When to use] |

### Rationale
[Why this copy works, covering user context, clarity, action-orientation]

### Localization Notes
[Anything translators should know, such as idioms to avoid, character expansion, cultural context]
```

## Tips

1. Be specific about context: "Error message when payment fails" is better than "error message."
2. Share the brand voice: "We're professional but warm" helps match the tone.
3. Consider the user's emotional state: error messages need empathy; success messages can celebrate.
