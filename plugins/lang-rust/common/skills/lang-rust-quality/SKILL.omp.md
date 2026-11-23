---
name: lang-rust-quality
description: Use to run Rust format, lint, and test checks with the project toolchain.
metadata:
  opencode/autoinvoke: false
  omp/autoinvoke: false
---
# Rust Quality

Run these checks from the crate or workspace root in this order:

| Step | Command |
|---|---|
| Format check | `cargo fmt --check` |
| Lint | `cargo clippy --all-targets --all-features -- -D warnings` |
| Test | `cargo nextest run` and `cargo test --doc` |
| Docs | `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features` |
| Dependencies | Configured `cargo deny check` and one unused-dependency check (`cargo shear` or `cargo machete`) |
| API break | `cargo semver-checks` for published libraries |
| Mutation | `cargo mutants --in-place --no-shuffle --in-diff git.diff` for changed code |
| Unsafe code | `cargo +nightly miri nextest run` or `cargo +nightly careful test` |
| Format fix | `cargo fmt` when requested |

Run checks in order and stop at the first failure you need to fix. In a workspace, add
`--workspace` to clippy and test, or `-p <crate>` to narrow them.

Default to cargo-nextest locally and in CI; run `cargo test --doc` beside it because nextest
does not run doc tests. Nextest isolates tests by process and runs them in parallel. Shared files,
ports and databases still need isolation. Keep retries off by default. Use plain `cargo test` only
when nextest cannot be installed.

Use `cargo-shear` as the unused-dependency gate. It parses with rust-analyzer, checks workspace
members, and offers `--fix`; it does not evaluate `cfg` and can miss macro-generated references
unless passed `--expand` on nightly. `cargo-machete` is fast but imprecise; triage false positives.

Keep the configured deny gate for advisories, licences, bans and sources. Use one unused
dependency tool; they do not replace rustc `dead_code` warnings. Check supported feature and
target combinations before deleting findings.

Run mutation tests under default `cargo test` so doctests count; `--test-tool=nextest` skips them.
A test-only diff selects no mutants. Run Miri or `cargo careful` on a schedule for crates with
unsafe code. Skip them under `#![forbid(unsafe_code)]` only when no unsafe dependency is in scope.
Run `cargo semver-checks` for published libraries only.

Tool choices are in `lang-rust-libraries`' `references/testing.md` and `references/quality.md`.
Detect a tool, recommend its install command (`cargo binstall`, `cargo install --locked`, or
`rustup component add`), and ask before installing. Report missing or declined tools as not run.
For cognitive complexity, use Lizard after checking scores on representative files, or SonarQube;
do not gate on Clippy `cognitive_complexity`.

After an edit spanning files or changing a signature, run `cargo check --all-targets` (add
`--workspace` in a workspace) or the project's script or task. CI runs the same steps with
`--locked`; workflow settings are in `lang-rust-ci`.

A missing `Cargo.toml` or `cargo` means the check did not run. Report it as not run, never as a
pass. Read failures as the project's actual toolchain output; do not invent extra linters.

## Lint baseline

- **Rule:** In `[workspace.lints.clippy]`, set `pedantic = { level = "warn", priority = -1 }` and
  add restriction lints deliberately: `unwrap_used`, `expect_used`, `panic`, `clippy::todo`,
  `unimplemented`, `dbg_macro`, `print_stdout` and `print_stderr` (libraries),
  `allow_attributes_without_reason`, `undocumented_unsafe_blocks`, `clone_on_ref_ptr`, and
  `indexing_slicing` and `string_slice` in untrusted parsers. Enable `nursery` lints one by one;
  CI runs clippy with `-D warnings`.
- **Rule:** `#[allow]` and `#[expect]` need `reason = "..."`, and only where the lint blocks.
  Prefer `#[expect]`. Never allow a lint crate-wide to silence new code.
- **Rule:** exempt tests in `clippy.toml`, not with attributes. A large backlog may use crate-level
  allows marked `TEMPORARY`, each with a reason naming a tracked task. New code must not grow them.
- **Note:** `missing_docs_in_private_items` is usually too noisy; use `missing_docs` for published
  libraries. See `lang-rust-libraries`' `references/quality.md`.
- **Source:** [Clippy lint groups](https://doc.rust-lang.org/clippy/lints.html), [Clippy configuration](https://doc.rust-lang.org/clippy/configuration.html), [lint attributes and `reason`](https://doc.rust-lang.org/reference/attributes/diagnostics.html#lint-check-attributes), [Cargo `[lints]`](https://doc.rust-lang.org/cargo/reference/manifest.html#the-lints-section).

## Results, errors and numeric conversions

- **Rule:** Do not discard `#[must_use]` values or `Result`s using `.ok()`, `let _ =`, or unused
  bindings. Handle or propagate them. Where ignoring a failure is correct, use a comment or a
  reasoned `#[expect(...)]`. Never silently ignore writes, flushes, filesystem, or cache operations.
- **Rule:** `map_err` preserves its source error. Wrap the cause; `.map_err(|_| Error::Io)` loses
  useful diagnostics.
- **Rule:** Use `From` / `into` for lossless widening and `try_from` for narrowing. Use `as` for
  truncation or saturation only when that behavior is specified.
- **Lints:** `let_underscore_must_use`, `let_underscore_untyped`, and `map_err_ignore` flag
  discarded values and errors. `unused_io_amount` flags ignored read or write counts. Pedantic
  cast lints flag lossless or lossy `as` casts.
- **Source:** [`#[must_use]`](https://doc.rust-lang.org/reference/attributes/diagnostics.html#the-must_use-attribute), [`TryFrom`](https://doc.rust-lang.org/std/convert/trait.TryFrom.html), [`From`](https://doc.rust-lang.org/std/convert/trait.From.html), [API Guidelines C-GOOD-ERR](https://rust-lang.github.io/api-guidelines/interoperability.html#error-types-are-meaningful-and-well-behaved-c-good-err), [Clippy lint list](https://rust-lang.github.io/rust-clippy/master/index.html).
