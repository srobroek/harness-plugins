---
description: "Answers one scoped research question from code, docs and the web with cited observations and inferences; edits nothing."
mode: subagent
steps: 80
request:
  headers:
    x-opencode-model-role: standard
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
    resource: repomix
    effect: allow
  - action: skill
    resource: "quality-*"
    effect: allow
  - action: skill
    resource: "lang-*"
    effect: allow
  - action: skill
    resource: "toolchain-*"
    effect: allow
  - action: skill
    resource: aws-guidance
    effect: allow
  - action: skill
    resource: whats-new
    effect: allow
  - action: execute
    resource: "*"
    effect: allow
  - action: "lsp_*"
    resource: "*"
    effect: allow
  - action: external_directory
    resource: "*"
    effect: ask
  - action: shell
    resource: "*"
    effect: allow
  - action: webfetch
    resource: "*"
    effect: allow
  - action: websearch
    resource: "*"
    effect: allow
  - action: repomix_pack
    resource: "*"
    effect: allow
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: explore
    effect: allow
---

{{include shared/researcher}}
