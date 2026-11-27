# Python

Versions are the ones the spike pinned and tested, as of 2026-11. Pin each one exactly, and rerun the
supported-profile suite on every bump (`business-rules-ci`).

| Package | Version (2026-11) | Role | Use it for |
| --- | --- | --- | --- |
| `cel-expr-python` | `0.1.4` | Checker of record for expressions checked at load; evaluator | Checking and evaluating rules in a Python host |
| `protobuf` | `7.36.2` | Activation parser | `descriptor_pool` from the FileDescriptorSet, `json_format.ParseDict` for records |
| `common-expression-language` | `0.10.0` | None | Do not use it for typed rules (below) |

## cel-expr-python

`cel-expr-python` is Google's Python binding over cel-cpp, the same checker that cel-cxx wraps. It is young
(0.1.x): pin it with `==`.

- Import: `from cel_expr_python import cel`.
- Types come from protobuf descriptors. Hash the FileDescriptorSet's bytes and refuse them when the SHA-256
  differs from the manifest's. Then load them into a `descriptor_pool`, and declare each variable as a message or
  a primitive.
- Build the environment from the profile manifest, not from a hand-written file:
  `cel.NewEnv(descriptor_pool=pool, config=cel.NewEnvConfigFromYaml(env_yaml))`, where `env_yaml` is the cel-go
  environment YAML that your adapter renders in memory from the manifest. It reads message-typed variables.
- Check: `env.compile(expr)` type-checks and raises `RuntimeError` on an issue. Check each slot's output type as
  well (G1).
- Write a `CheckedExpr`: `expr.serialize()`. Read one: `env.deserialize(data)`.
- Evaluate: `expr.eval(data={"decision": message, ...})`. An evaluation error comes back as a value whose
  `type().name()` is `"ERROR"`, not as an exception. Test for it on every result before you read `.value()`.
- Activation: validate the record against its JSON Schema first, then
  `json_format.ParseDict(record, message, ignore_unknown_fields=True)`.

The spike results for 0.1.4:

- Typed demo: 7 of 7 bad rules rejected at check, including `decision.status == 1` (string against int).
- Shared cel-spec suite: 1610 of 1640.
- It evaluated every `CheckedExpr` that cel-go and cel-core wrote.

### Gotchas

- **No policy API.** 0.1.4 cannot parse a `.celpolicy`. Compile rule lists with the cel-go reference checker, and
  load the one `CheckedExpr` per list from the bundle. Its runtime does run the `cel.@block` form that cel-go's
  policy composer writes.
- **Bindings numbering.** Its environment config knows `bindings` version 0 only. cel-go declares `cel.@block` in
  bindings version 1, so a profile that lists bindings 1 must be refused by the Python adapter at load (G4).
- **Options.** The adapter accepts only the checker options that match cel-cpp's defaults, and refuses a manifest
  that asks for others.
- **`transformMap`** fails with "no overload for cel.@mapInsert", a gap in the binding's comprehensions extension
  (6 suite failures). Keep two-variable comprehensions out of the profile, or test them per engine first.
- **Double formatting.** `string(-0.0045)` gives `-0.0044999999999999997`. Do not compare formatted doubles across
  engines.
- **No cost API.** Cost estimates come from cel-go in CI (G5). In the Python host, a timeout around an evaluation
  that cannot be interrupted only reports.
- **Enum values.** A misspelt enum literal such as `decision.status == "aproved"` passes the check (G1's enum
  lint catches it).

## common-expression-language is not a checker

`common-expression-language` (PyPI) wraps the Rust `cel` crate. That crate has no type checker and no protobuf
support (see [rust.md](rust.md)). A rule with a wrong field name passes until a record lacks that field, so the
package cannot satisfy G1. Do not use it for typed rules or as a checker of record.
