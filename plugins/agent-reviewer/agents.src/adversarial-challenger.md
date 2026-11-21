---
description: "Read-only challenger that stress-tests a claim, plan, design or decision and returns evidence-backed counter-arguments."
mode: subagent
steps: 60
request:
  headers:
    x-opencode-model-role: reviewer
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: read
    resource: "*.env"
    effect: ask
  - action: read
    resource: "*.env.*"
    effect: ask
  - action: read
    resource: "*.env.example"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: skill
    resource: "quality-*"
    effect: allow
  - action: skill
    resource: "lang-*"
    effect: allow
  - action: skill
    resource: "architecture-*"
    effect: allow
  - action: "lsp_*"
    resource: "*"
    effect: allow
  # {{rules read-only-shell}}
  - action: external_directory
    resource: "*"
    effect: ask
  - action: webfetch
    resource: "*"
    effect: allow
  - action: websearch
    resource: "*"
    effect: allow
---

{{include shared/adversarial-challenger}}
