# Serialized and published contracts

Read when you add or change a serialized or published contract (an HTTP API, a config, file or record format, CLI or tool JSON output, an event or message payload, an MCP tool schema), or when two sides must agree on names, shapes, or casing: generated bindings or clients (OpenAPI, protobuf, GraphQL, ts-rs, specta), IPC command registries, or JSON payloads shared between a backend and a frontend. API and event compatibility across versions is in [release.md](release.md).

## Generated code is committed and drift-checked

**Do:** generate bindings from the authoritative side, commit the output, and in CI regenerate and fail on `git status --porcelain -- <generated dirs>`. It covers the whole generated surface, newly emitted untracked files included (`git diff --exit-code` misses them); consumers use it without repeating it.
**Do not:** generate in a postinstall step nobody reviews, or hand-edit generated files. Change the source or the generator.

## TypeSpec is the source of every owned contract

**Do:** In every project, author each serialized or published contract you own in TypeSpec, even when it stays within one process, language, or repository. Use `@typespec/http` and `@typespec/openapi3` for internal and external HTTP APIs. Use `@typespec/json-schema` for config, file and record formats, CLI and tool JSON output, event and message payloads, and MCP tool input and output schemas. Keep `.proto` for protobuf and gRPC wire contracts and GraphQL SDL for GraphQL APIs. Keep channels and bindings in AsyncAPI and reference the emitted payload schemas until a stable TypeSpec AsyncAPI emitter is available. Vendor third-party schemas as published; do not re-author them. In-memory types that are never serialized or published are out of scope. Generate and commit the applicable artifacts, and generate OpenAPI, JSON Schema, API reference docs and reference documentation from the same source; never edit generated output by hand. Publish a JSON Schema through a generated entry point (each public model emitted separately with `@jsonSchema`, or a root `$ref` wrapper), so validating against the published file rejects an invalid document. Derive any generator-specific copy (a normalized schema) with a pinned script in CI, and never publish it. Complete docs live in the published schema. `toolchain-api` has the routes, versions and CI gates; each `lang-<language>-libraries` has the generator entry.
**Do not:** hand-write a model class, Zod schema, serde struct or Go struct for such a contract, keep a second schema beside the source, or let a hand-edited emitted file stand in for a source change. A contract change is a TypeSpec change plus a regenerate. A framework schema (FastAPI, Zod, Pydantic, Huma) is a runtime adapter generated from or checked against the emitted output, never a competing source.

| Exception | Reason |
| --- | --- |
| Protobuf and gRPC wire contracts keep `.proto` | Binary wire format; `buf lint` and `buf breaking` own the checks (`toolchain-api`) |
| GraphQL APIs keep GraphQL SDL | The schema language is the contract |
| Channels and bindings stay in AsyncAPI | They reference the emitted payload schemas until a stable TypeSpec AsyncAPI emitter exists |
| A third-party contract | Vendor their published file as published; generate from it, never re-author it |
| In-memory types never serialized or published | Out of scope |

Any other departure is a recorded decision in the engineering doc with its reason. A construct the spike did not cover (nested unions, recursive models, `int64` or decimal precision, `bytes`) still goes in TypeSpec: add a fixture for it first.

### Why not another source

Observed on the spike's 29 fixtures for one contract, 2026-11-25. None beat TypeSpec on any language (Pydantic 28/29, Zod 28/29, Rust 29/29, Go 28/29).

| Alternative | Result | Reason |
| --- | --- | --- |
| Protobuf with protojson | 23/29 best (protojson plus protovalidate; Rust typify route 23/29) | Cannot carry a `kind`-tagged union or present-but-null; its published JSON Schema fails to compile in Ajv |
| Smithy | Ties | Only after 8 OpenAPI overrides kept outside the IDL |
| quicktype | Standalone bindings 13/29 to 19/29; Rust with a separate validator 29/29 but 3/12 on exact round-trip | Enforces types, not constraints |
| Typical | No JSON route | Binary format only, no constraints |

### Known issues and workarounds

| Issue | Workaround |
| --- | --- |
| Pydantic reads `\d` as Unicode and accepts `٣` (rust-regex engine) | Write `[0-9]` (pattern rule below); keep the default engine |
| A lowercase `t` or `z` in a date-time is rejected on the Zod routes (`z.iso.datetime()`) and all Go routes (`time.Parse`) but accepted by Ajv, Python and Rust | No tested generator fixes it. Narrow the contract, or record an exception for that route and fixture with its exact expected result; every other fixture must still match its label |
| `@hey-api/openapi-ts` drops field descriptions and `datamodel-code-generator` drops model docstrings (3/6 each) | The published schema must carry complete docs and is tested for them; test the docs a binding claims to support in that binding, and record the gap per route |
| No tested generator handled the emitted bundle unchanged (`unevaluatedProperties`, bundle `$id` refs) | The pinned schema normaliser rewrites them into the generator input; it fails loudly on a construct it cannot rewrite, so run it in the regenerate gate |
| `cargo-typify` does not enforce ranges, item counts or optional-not-null (25/29) | Validate the raw `serde_json::Value` with the `jsonschema` crate before deserializing (29/29) |
| The emitted bundle is only `$defs`, so it accepts any document; the spike's 29/29 was measured on the `RunRequest` subschema, not the bundle root | Generate an entry point (a separate file per public model, or a root `$ref` wrapper) and run valid and invalid fixtures against the exact published artifact |
| `ogen` orders open-object extras randomly | Compare parsed JSON, not bytes, in golden tests (this fixes key order only) |
| Fractions longer than 6 digits (Pydantic) or 9 digits (typify, ogen) are truncated on round trip | Comparing parsed JSON does not recover lost precision. Test the significant fractional digits, then constrain the precision in the contract or use a lossless representation (an integer count or a string) |

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
