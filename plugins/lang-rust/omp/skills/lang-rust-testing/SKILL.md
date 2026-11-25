---
name: lang-rust-testing
description: Rust testing with nextest, property tests, snapshots, and integration fixtures.
---
# Rust Testing

Use the repository's configured Rust test runner (usually `cargo test`). When the project adopts
`cargo-nextest`, use it for unit and integration tests and run `cargo test --doc` separately
because nextest does not run doctests. Add property-based tests for invariants and parsers;
use snapshots for stable, reviewable output. Exercise concurrency and persistence with real
dependencies where practical. Keep tests isolated from shared files, ports, and databases.
