---
name: to-questionnaire
description: Turns a decision the user cannot answer alone into a questionnaire for others; triggers on write a questionnaire for.
metadata:
  disable-model-invocation: true
---
# To Questionnaire

TRIGGER
+ "write a questionnaire for", "what should I ask them", "ask them to fill in"
+ the user needs knowledge only one other person holds before deciding
- the user can answer the questions themself → use `grilling`

Turn something the user cannot answer alone into a **questionnaire**: a Markdown document
they hand to one person to fill in asynchronously or during a meeting. The recipient holds
knowledge the user lacks; the questionnaire gathers it.

**Grill the send, not the subject.** Interview the user only about the send: who receives it,
and what the user needs back. The questionnaire targets the gap between what the recipient
knows and what the user needs.

## Workflow

Ask steps 1 and 2 together in one round through `grilling`'s question channels: your preferred
question tool when available, otherwise chat. Ask two `ask_text` questions (`send.recipient` and `send.needs`) with
no recommendation unless the conversation suggests one. Both answers are needed before step 3.

1. **Who receives it?** Ask the recipient's role, expertise, and relationship to the user.
   This sets the questionnaire's tone and context.
2. **What do you need back?** Ask for the specific decisions or facts the user needs from this
   person. The answer defines what the questionnaire must cover.
3. **Write the questionnaire.** Draft questions aimed at the gap from steps 1-2, following the
   document structure below. Write it to the path the user names; otherwise use the system
   temp directory, never the current directory. If your preferred question tool can show a
   document for review, show the draft there before writing and apply any revisions. Report the
   absolute path.

## Document structure

Frame the document as a discovery questionnaire: the user lacks context, the recipient holds it.
Order questions most-important first. Group them under `##` headings when there are several.

```markdown
# {Questionnaire title}

**Purpose:** why this questionnaire exists and the decision riding on it.

**From:** {the user}, **To:** {the recipient}, **How your answers will be used:** {where they go}

## Context

One paragraph orienting a recipient who was not in the user's head. Enough to answer well, not a page.

## How to answer

Deadline and rough effort. Partial answers and "I don't know" are useful: flag anything you are unsure of rather than skipping it.

## {Theme heading}

### What load is the system expected to handle at launch?

_Why this matters: it decides whether we provision for burst traffic now or defer it._

>

## Anything else?

A closing catch-all: anything we did not ask that we should know?
```

Use one `##` section per theme. Under each, order questions by importance. Each question asks one
thing and has an answer stub beneath it. Add a one-line _why this matters_ only when the question
could be misread or invite a throwaway answer.

## Rules

NOT Write the questionnaire into the current directory or any repository checkout unless the
user names that path.
NOT Send the questionnaire; the user hands it over.
