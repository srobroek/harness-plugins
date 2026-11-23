---
name: ops-toolchain-cache-policy
description: Use when configuring toolchain download or compiler caches, worktree build output, or cache root and size knobs.
---
# Toolchain Cache Policy

Share bounded download and compiler caches across worktrees and clones. Keep repository outputs
repository-scoped or worktree-local.

## Shared caches

Use a shared machine-level cache root for sccache, uv/pip, Go build/modules, npm/pnpm/Bun/Deno,
pre-commit/Ruff, golangci-lint, Gradle, NuGet, Trivy, and Restic. Override it with
`DEVELOPMENT_CACHE_HOME`; default is `~/.cache/development`.

Set explicit cache size limits and eviction policies. Missing tools or unwritable paths degrade
to an advisory; never block a session on cache policy.
