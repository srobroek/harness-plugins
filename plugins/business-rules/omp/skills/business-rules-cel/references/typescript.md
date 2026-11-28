# TypeScript

Versions are the ones the spike pinned and tested, as of 2026-11. Pin each package exactly, and rerun the
supported-profile suite on every bump (`business-rules-ci`).

| Package | Version (2026-11) | Role | Use it for |
| --- | --- | --- | --- |
| `@bufbuild/cel` | `0.6.2` | Evaluator, restricted profile only | Evaluating reference-checked bundles, in the browser or in Node |
| `@bufbuild/protobuf` | `2.17.0` | Registry and activation parser | `createFileRegistry`, `fromBinary`, `fromJson` |
| `@marcbachmann/cel-js` | `8.0.0` | None for typed rules | Not for rules that cross a boundary (below) |

## @bufbuild/cel: evaluate CheckedExprs only

`@bufbuild/cel` (Apache-2.0, beta) evaluates a `CheckedExpr` with `plan(env, checkedExpr)`. It evaluated all 24
`CheckedExpr` messages from four writers in the spike.

- Environment: first hash the FileDescriptorSet's bytes and refuse them when the SHA-256 differs from the
  manifest's. Then call `createFileRegistry(fromBinary(FileDescriptorSetSchema, bytes))`, then
  `celEnv({ registry, variables, funcs })`, with `objectType(desc)` for each message-typed variable. Build the
  variables from the profile manifest.
- Activation: `fromJson(schema, record, { ignoreUnknownFields: true })`, after schema validation.
- **No public checker.** A checker ships in `dist/` but is not exported (pull requests #237 and #344 would export
  it). The internal one throws "Unsupported expression kind" on any call or macro. Never use it for checking.
- **It ignores the type and reference maps** of a `CheckedExpr` and resolves names again by itself. So it is only
  as safe as the reference checker's check in the same profile.
- **It does not enforce check-time options or declarations.** Evaluated unchecked, `job.progress.fraction > 0`
  (a double against an int) returned `true`, though the profile excludes cross-type comparison.
- **Restricted profile only.** Only the strings extension ships. Run it only on bundles whose profile has no
  optional and no bindings extension. Make its adapter refuse any extension but strings version 4, and a container.
- Shared cel-spec suite: 1324 of 1640, almost all of the failures in extensions it does not ship.

## @marcbachmann/cel-js maps nullable to dyn

`@marcbachmann/cel-js` (MIT) has a public `env.check()`, but:

- A nullable scalar (a protobuf wrapper) has no cel-js type and becomes `dyn`. So `job.progress.fraction + "x"`
  and `part.mass_target > "1"` pass its check: it rejected 5 of 7 bad rules.
- It has no protobuf AST, so it cannot read or write a `CheckedExpr`, and cannot run a bundle.
- Its defaults differ from cel-spec: homogeneous list and map literals are on, and optional types are off.
- Shared suite: 1037 of 1640.

Do not use it as a checker of record or for rules that cross a boundary. `cel-js` (0.8.2) was archived in 2026-04.
