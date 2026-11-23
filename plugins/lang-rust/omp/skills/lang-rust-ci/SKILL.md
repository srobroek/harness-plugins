---
name: lang-rust-ci
description: Rust-specific CI workflow configuration, cache and testing policy.
---
# Rust CI

Use the project toolchain and committed lockfile in CI. Run formatting, clippy, tests, and
configured dependency checks in separate named steps. Use `--locked` for Cargo commands. Follow
the project's policy for compiler caches; keep build output repository-scoped or worktree-local.
