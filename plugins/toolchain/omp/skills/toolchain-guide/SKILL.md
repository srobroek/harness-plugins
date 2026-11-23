---
name: toolchain-guide
description: Routes toolchain questions to focused skills for OMP projects.
---
# Toolchain guide

This guide only routes. Before answering or acting, load each matching skill by id in this turn,
then answer from the loaded skill.

| Question | Load |
| --- | --- |
| Stack, language or package manager | `toolchain-stack-defaults`, `toolchain-languages` |
| Frontend | `toolchain-frontend` |
| Infrastructure | `toolchain-infrastructure` |
| Logging, tracing, security scanners or observability | `toolchain-quality-observability` |
| GitHub Actions | `ci-github-actions` |
| Caches or worktrees | `ops-toolchain-cache-policy`, `coexistence-worktree` |
| Global Cargo target | `ops-no-global-cargo-target` |
| Shell | `shell-language` |
| Terraform or OpenTofu | `terraform-language` |
