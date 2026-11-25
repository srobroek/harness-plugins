# Cross-language and wire contracts

Read when two sides of a boundary must agree on names, shapes, or casing: a new or changed contract, generated bindings or clients (OpenAPI, protobuf, GraphQL, ts-rs, specta), IPC command registries, or JSON payloads shared between a backend and a frontend. API and event compatibility across versions is in [release.md](release.md).

## Generated code is committed and drift-checked

**Do:** generate bindings from the authoritative side, commit the output, and in CI regenerate and run `git diff --exit-code`. That one gate covers the whole generated surface; consumers use it without repeating it.
**Do not:** generate in a postinstall step nobody reviews, or hand-edit generated files. Change the source or the generator.

## TypeSpec is the source of every contract

**Do:** author every data or API contract that crosses a process, language or repository boundary in TypeSpec, and emit everything from it: OpenAPI 3.1, JSON Schema 2020-12 and each language's types. Commit the output and gate it with the drift check above. Publish a JSON Schema with a root entry point that `$ref`s the top-level model, so validating against the published file rejects an invalid document. Derive any generator-specific copy (a normalized schema) with a pinned script in CI, and never publish it. `toolchain-api` has the routes, versions and CI gates; each `lang-<language>-libraries` has the generator entry.
**Do not:** hand-write a model class, Zod schema, serde struct or Go struct for such a contract, keep a second schema beside the source, or let a hand-edited emitted file stand in for a source change. A contract change is a TypeSpec change plus a regenerate.

| Exception | Reason |
| --- | --- |
| Protobuf and gRPC services keep `.proto` | Binary wire format; `buf lint` and `buf breaking` own the checks (`toolchain-api`) |
| A contract another party owns | Their published file is the source: generate from it, never re-author it |

Any other departure is a recorded decision in the engineering doc with its reason. A construct the spike did not cover (nested unions, recursive models, `int64` or decimal precision, `bytes`) still goes in TypeSpec: add a fixture for it first.

### Why not another source

Measured on the spike's 29 fixtures, 2026-11-25. None beats TypeSpec on any language (Pydantic 28/29, Zod 28/29, Rust 29/29, Go 28/29).

| Alternative | Result | Reason |
| --- | --- | --- |
| Protobuf with protojson | 23/29 best | Cannot carry a `kind`-tagged union or present-but-null; its published JSON Schema fails to compile in Ajv |
| Smithy | Ties | Only after 8 OpenAPI overrides kept outside the IDL |
| quicktype | 13/29 to 19/29 | Enforces types, not constraints |
| Typical | No JSON route | Binary format only, no constraints |

### Known issues and workarounds

| Issue | Workaround |
| --- | --- |
| Pydantic reads `\d` as Unicode and accepts `٣` (rust-regex engine) | Write `[0-9]` (pattern rule below); keep the default engine |
| A lowercase `t` or `z` in a date-time is rejected on the Zod routes (`z.iso.datetime()`) and all Go routes (`time.Parse`) but accepted by Ajv, Python and Rust | No generator fixes it. Narrow the contract or keep the fixture as a documented known failure |
| `@hey-api/openapi-ts` drops field descriptions and `datamodel-code-generator` drops model docstrings (3/6 each) | Read documentation from the published JSON Schema; keep the docs fixture check |
| No generator reads the emitted `unevaluatedProperties` or bundle `$id` refs | The pinned schema normaliser rewrites them into the generator input; it fails loudly on a construct it cannot rewrite, so run it in the regenerate gate |
| `cargo-typify` does not enforce ranges, item counts or optional-not-null (25/29) | Validate the raw `serde_json::Value` with the `jsonschema` crate before deserializing (29/29) |
| The emitted schema is only `$defs`, so it accepts any document | Publish a root `$ref`; test it with an invalid document |
| Fractions longer than 6 digits (Pydantic) or 9 digits (typify, ogen) are truncated on round trip; `ogen` orders open-object extras randomly | Compare parsed values, not bytes, in round-trip and golden tests |

## Pattern dialect

Schema `pattern` values run in a different regex engine in each language (ECMAScript, Rust `regex`, RE2, Python `re`, pydantic-core), and they disagree on `\d`, `\w`, `\s`, `$` and Unicode classes. Spike evidence, 9 engines, 2026-11-24.

**Do:**

- Write ECMA-262 patterns that compile with the `u` flag, anchored as a whole: `^(?:a|b)$`. `^a|b$` anchors one alternative each.
- Spell classes out: `[0-9]`, `[A-Za-z0-9_]`. Replace `\S` with an explicit class equal to ECMAScript whitespace (space, `\t\n\v\f\r`, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF). `[^ \t\n\r\f\v]` is not equal: it accepts NBSP, which `\S` rejects. Otherwise record the narrowing as a contract change.
- Use `\p{..}` only for one- or two-letter general categories (`\p{L}`, `\p{Nd}`), and only with a generator that emits the `u` flag. `@hey-api/openapi-ts` does; `json-schema-to-zod`, `z.fromJSONSchema`, `typespec-zod` and the kattebak emitter do not.
- Keep pydantic-core's default `rust-regex` engine. Python `re` rejects `\p{..}` and its `$` accepts a trailing newline.
- Lint every emitted schema in CI (no `\d \D \w \W \s \S \b \B`, no lookaround, no backreference, whole-pattern anchoring) and cover each pattern with corpus cases: NBSP, a non-ASCII digit, a trailing newline.

**Do not:** rely on RE2, Rust `regex` or pydantic-core for lookaround or backreferences, or claim a pattern migration preserves behavior before the conformance suite has rerun on it. The spike did not rerun on a rule-compliant contract.

## Names are tested, not trusted

**Do:** when one side registers commands or operations by name and the other calls them by string, add a test that fails when the registered set and the called set differ.
**Do not:** rely on a typo surfacing at runtime in the one code path that uses it.

## One wire casing

**Do:** pick one casing for the wire (usually `camelCase` for JSON consumed by JavaScript) and set it once per side: a serializer-wide naming policy, not per-field renames. Add a test that serializes a representative value and checks the keys.
**Do not:** mix casings across payloads. One mismatched key makes the whole payload fail or, worse, silently drops a field.

## Conformance against the real surface

**Do:** run contract or conformance tests against the real backend or the real generated client, at least for the names, casing, and schema of each operation.
**Do not:** let a mock transport stand in for the contract. A mock agrees with whatever the client sends, so name, casing, and schema mismatches pass.

**Exception:** unit tests of client logic can use a fake transport, as long as the fake is itself checked against the real surface (see [verification.md](verification.md)).

## Stubs behind a contract

Read when a consumer is built before the provider exists. When to stub and how to swap are in `quality-code-policy`; the conformance suite is in `quality-testing`'s `doubles.md`.

**Do:** put the dependency behind the contract's interface (trait, interface, protocol). Consumers take the interface, so a swap changes only wiring. Use the contract's shared types (generated from the schema, or the one shared types module).
**Do not:** copy a contract type into a stub or consumer, or define the interface inside the stub.

**Do:** mark each stub `// STUB(<task-id>): what this fakes` (`#` in Python, TOML and YAML). One marker names one task; a task may cover several markers. Keep stubs minimal and deterministic: implement the contract, nothing more.
**Do not:** let a stub on a production path silently return plausible fake data. Where it affects behavior, say so with a capability flag or a "not yet supported" error.

Drift checks above still apply: regenerate shared types in the same change as a contract change. When two languages share a contract, both consume the same generated schema files: `toolchain-api` has the gates and `quality-testing`'s `shared-contracts.md` the tests. Language examples: [rust.md](rust.md), [python.md](python.md), [typescript.md](typescript.md), [go.md](go.md).
