---
name: lang-rust-packaging
description: Rust crate and workspace layout guidance.
---
# Rust Packaging

Keep crates cohesive and dependency direction explicit. Use a workspace when crates share a
release, toolchain, or lockfile. Put executable entrypoints in binary crates; expose stable,
minimal APIs from libraries. Keep generated artifacts out of version control unless they are part
of the published contract.
