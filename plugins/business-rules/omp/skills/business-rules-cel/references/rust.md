# Rust

Versions are the ones the spike pinned and tested, as of 2026-11. Pin each crate with `=`, and rerun the
supported-profile suite on every bump (`business-rules-ci`).

| Crate | Version (2026-11) | Role | Use it for |
| --- | --- | --- | --- |
| `cel-core`, `cel-core-proto` | `=0.5.1` | Candidate evaluator of reference-checked rules | Evaluating bundles in a Rust component or provider |
| `prost-reflect` (feature `serde`) | `0.16` | Activation parser | `DynamicMessage` from protobuf JSON |
| `cel-cxx` | `0.2.5` | Source-checking alternative | Checking source where a C++ toolchain and Bazel are acceptable |
| `cel` | `0.16.1` | None | Do not use it for typed rules |

## cel-core: an evaluator of reference-checked rules

cel-core is the only pure-Rust engine with a checker and with `CheckedExpr` input and output (MIT OR Apache-2.0).

- Environment: `Env::with_standard_library().with_proto_registry(Arc::new(registry))`, where the registry is a
  `ProstProtoRegistry` over the FileDescriptorSet. Add each listed extension from the manifest, for example
  `with_extension(cel_core::ext::string_extension())`. The adapter maps the names by hand (about 40 lines), so
  keep its inventory explicit (G4).
- Read a bundle entry: decode the `google.protobuf.Any`, then `CheckedExpr::decode(any.value.as_slice())`, then
  `Ast::new_checked(from_parsed_expr(&parsed)?, "", check_result_from_proto(&checked)?)`.
- Activation: `DynamicMessage::deserialize` from the record's protobuf JSON, after schema validation.
- Shared cel-spec suite: 1639 of 1640. That score measures the evaluation of good expressions only. The reject
  cases below measure its checker.

Why it is an evaluator and not a checker of record:

- Its checker accepts `decision.status == 1` (string against int), which cel-go and cel-cpp reject.
- Its parser always expands `cel.bind`, even when the profile excludes bindings. The adapter cannot turn that off.
- So a rule that only cel-core checked is unchecked for this standard. A Rust tool that writes or checks rules
  validates each one with the reference checker before the rule ships or counts.
- It has no runtime `cel.@block`, so it cannot run a compiled policy that uses `variables`.

It needs an owner before it becomes a required engine: one maintainer, and no push between 2026-02-16 and the
spike in 2026-11. The licence allows a fork, but a pinned version and a licence do not supply anyone to do the
upgrades, the upstream fixes or the fork. Name that owner in the project's engineering doc.

A Python host can reach cel-core through a pyo3 binding of its own. In the spike it took 87 lines of Rust and
built an abi3 wheel. Its checks still need the reference checker.

## cel-cxx: source checking only

cel-cxx wraps cel-cpp, the checker that cel-expr-python uses. It rejected 7 of 7 bad rules.

- Its Rust API has no `CheckedExpr` input or output, so it cannot run a bundle.
- `cargo build` runs Bazel 8.3.1, which it downloads, to compile cel-cpp. It needs a C++ toolchain and leaves a
  large `target/`.
- Shared suite: 1512 of 1640. 87 of the failures are `disableCheck` tests: the Rust API compiles only with the
  checker.

## The `cel` crate has no checker

`cel` (0.16.1) is the most used Rust crate. It has no type checker and no protobuf support: values are dynamic,
from serde, and `google.protobuf.*` literals fail. A rule with a wrong field passes until a record lacks that
field. Do not use it for typed rules. `cel-interpreter` and `cel-parser` are its old names.

ferricel and rscel were not run in the spike.
