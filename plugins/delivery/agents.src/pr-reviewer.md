---
description: "Reviews a GitHub pull request diff for code quality, security, correctness, and coverage. Read-only; returns a verdict. Not for Beads run nodes."
x-omp-tools: github
mode: subagent
steps: 80
model: "amazon-bedrock/global.anthropic.claude-opus-5-5#high"
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
  - action: shell
    resource: "glab mr view *"
    effect: allow
  - action: shell
    resource: "glab mr diff *"
    effect: allow
  - action: shell
    resource: "glab api *-X GET*"
    effect: allow
  - action: shell
    resource: "glab api *--method GET*"
    effect: allow
---

{{include shared/pr-reviewer}}
