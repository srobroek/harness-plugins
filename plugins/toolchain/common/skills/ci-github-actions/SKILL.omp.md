---
name: ci-github-actions
description: Use when writing GitHub Actions workflows, required checks, matrices, caches, action pinning or build attestation.
---
# GitHub Actions CI defaults

Language-neutral workflow structure. Language-specific cache and toolchain setup lives in the
language plugin's skills when installed.

## One required gate

Make one `ci-gate` job the only required status check. It runs with `if: always()`, depends on
every other job, and fails unless each job passed or was allowed to skip.

## Build attestations

Use GitHub's artifact attestation for published build outputs. Scope workflow permissions to the
jobs that need them and pin third-party actions to reviewed versions.
