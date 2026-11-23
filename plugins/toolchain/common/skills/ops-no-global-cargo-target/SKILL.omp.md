---
name: ops-no-global-cargo-target
description: Use when Cargo, shell, mise or CI config would set CARGO_TARGET_DIR or build.target-dir to a machine-global directory.
---
# No global Cargo target directory

Keep Cargo build output repository-scoped or worktree-local. Do not set `CARGO_TARGET_DIR` or a
global `[build].target-dir`; concurrent repositories can collide on fingerprints and reuse
artifacts silently.

Compiler caching is the supported way to share build work across repositories. Use sccache on
the shared cache root. Cache roots, eviction, and environment knobs are in
`ops-toolchain-cache-policy`.
