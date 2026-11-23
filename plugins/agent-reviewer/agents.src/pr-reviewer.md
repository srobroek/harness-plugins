---
description: "Reviews a GitHub pull request diff for code quality, security, correctness, and coverage. Read-only; returns a verdict. Not for Beads run nodes."
tools: read, grep, find, ls, bash, github
mode: subagent
steps: 80
hidden: true
request:
  headers:
    x-opencode-model-role: reviewer
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: skill
    resource: "quality-*"
    effect: allow
  - action: skill
    resource: "lang-*"
    effect: allow
  - action: skill
    resource: "review-*"
    effect: allow
  - action: shell
    resource: "gh pr view *"
    effect: allow
  - action: shell
    resource: "gh pr diff *"
    effect: allow
---

{{include shared/pr-reviewer}}
