---
name: business-rules-cel
description: "Use when a project adopts CEL: the type pipeline, structural scopes, presence, rule formats, bundles, cel-policy, tools and CEL packages."
metadata:
  opencode/autoinvoke: false
---

# CEL adoption standard

This standard applies to every project that adopts CEL (Common Expression Language) for business rules. It has
four layers:

1. The **general rules** (G1 to G8) apply to every project.
2. The **protobuf portability profile** (P1 to P4) applies when rules are typed against a FileDescriptorSet and
   cross processes or languages as `CheckedExpr` messages. A project whose rules run in one engine with native
   types can drop it, and follows the native-only path (see The pipeline).
3. The **engine and tooling choices** are a dated list. Replace the list when the evidence changes. The rules do
   not depend on it.
4. The **cel-policy profile** (C1) applies only to a project that writes rule lists as cel-policy files.

Each rule names the check that enforces it. The evidence is a language-neutral engine spike and a review of how
Kubernetes uses CEL, both from 2026-11. Tests are in the `business-rules-testing` skill, and the CI layout is in
the `business-rules-ci` skill.

## The pipeline

This is the pipeline under the protobuf portability profile. A project that drops that profile follows the
native-only path at the end of this section.

```text
TypeSpec (*.tsp)
  -> published JSON Schema                  (the contract standard)
  -> generator, per structural scope        (G6, G7)
       -> FileDescriptorSet                 (types)
       -> profile manifest                  (declarations, extensions with versions, options)
       -> profile digest                    (SHA-256 of the manifest's RFC 8785 JCS encoding)
  -> reference checker, over every rule file (verifies the descriptor-set bytes first)
  -> CheckedExpr bundle                     (profile digest, payload SHA-256 per entry, checker of record)
  -> engine: verify the descriptor-set bytes and the bundle, then evaluate
```

1. **Contract.** The record types are TypeSpec models, and the published JSON Schema is emitted from them. The
   `quality-code-design` skill's `contracts.md` reference has that standard. Never write a second schema for
   rules.
2. **Scopes.** A scope names the variables that one kind of rule sees. Each variable points at one node of a
   published schema, for example `decision: record/decision.schema.json#/$defs/gate_decision`. A scope can omit a
   field. A rule that reads an omitted field fails the check.
3. **Generator.** The generator walks every node that a rule can reach, refuses a scope that is not structural
   (G7), and writes three artifacts:
   - `.proto` files, compiled to a FileDescriptorSet with `buf build --exclude-source-info`;
   - one profile manifest per scope, `<scope>.profile.json`;
   - optionally, the cel-go environment YAML for tools that read it, such as the `cel-expr` CLI.
4. **Profile manifest.** It holds:
   - `descriptor_set`: the file name and the SHA-256 of its exact bytes;
   - `variables`: each declaration, as a CEL type name (a primitive or a message);
   - `extensions`: each extension with a pinned version, in cel-go's numbering;
   - `options`: `cross_type_numeric_comparisons` and `homogeneous_aggregate_literals`;
   - `checkers_of_record`: the checkers (engine and version) whose bundles an evaluator may run;
   - `container` and `manifest_version`.
5. **Profile digest.** It is the SHA-256 of the manifest's canonical JSON under RFC 8785 (JCS), never of
   protobuf bytes or of the environment YAML. RFC 8785 is normative: the canonical bytes are the ones it defines,
   whatever encoder an adapter uses. The generator refuses a manifest with any of these:
   - a float;
   - a non-ASCII string, as a value or as a key;
   - an integer `n` with |n| > 2^53, in either sign.

   The bound keeps every integer exact as a double. Without the negative bound, a decoder that reads JSON
   numbers as doubles rounds `-9007199254740993` while another keeps it, and the two digests differ. For this
   subset, RFC 8785 output is:
   - the members of every object sorted by key, compared as UTF-16 code units, which for ASCII keys is byte
     order;
   - no whitespace;
   - integers in plain decimal;
   - in strings, `"` and `\` escaped with a backslash, `\b`, `\t`, `\n`, `\f` and `\r` in their short forms,
     any other character below U+0020 as `\u00xx` in lowercase hex, and every other character literal,
     including `/` and DEL (U+007F).

   These encoders can write it:
   - Python: `json.dumps(manifest, ensure_ascii=False, separators=(",", ":"), sort_keys=True)`, encoded as
     UTF-8. The default `ensure_ascii=True` writes DEL as `\u007f`, and RFC 8785 leaves it literal. `sort_keys`
     compares code points, which gives the RFC 8785 order only for ASCII keys, so keep the generator's refusal
     of non-ASCII keys;
   - Go 1.22 or later: `encoding/json` through a `json.Encoder` with `SetEscapeHTML(false)`, over maps, whose
     keys it sorts. Earlier releases write `\b` and `\f` as `\u0008` and `\u000c`;
   - Rust: `serde_json` without `preserve_order`;
   - TypeScript: a serializer that writes each object's members in sorted order itself. `JSON.stringify` writes
     integer-like keys such as `"9"` and `"10"` first, in numeric order, whatever order they were inserted in.

   A candidate encoder counts only when it reproduces the cross-adapter test vector: a manifest, its canonical
   bytes and its digest. The vector covers key order, escaping (DEL included), both integer bounds and the end
   of the output. The canonical bytes end at the closing brace, with no trailing newline, although some encoders
   append one (Go's `json.Encoder.Encode` does).
6. **Descriptor-set bytes.** Before it builds an environment, every adapter hashes the descriptor-set bytes it
   loaded and refuses them when the SHA-256 differs from the manifest's. The profile digest covers only the
   manifest. Without this check, a replaced descriptor set leaves the digest and every bundle check unchanged.
   The reference checker and each host make the check.
7. **Reference checker.** A pinned cel-go build checks every rule against the manifest's exact environment and
   writes a `CheckedExpr` for each rule (see [go.md](references/go.md)).
8. **Bundle.** It carries the profile digest and the checker. Each entry carries the SHA-256 of its exact
   payload bytes and of its source, its path and its output type (P2).
9. **Engine.** Each runtime verifies the descriptor-set bytes, builds its environment from the manifest,
   verifies the bundle, and evaluates the `CheckedExpr` without checking it again.

Records enter as JSON. Validate each record against its JSON Schema first (G2). Then parse it into the declared
message with the language's protobuf JSON parser, set to ignore unknown fields. No generated Rust or TypeScript
structs are needed to evaluate a rule.

**Native-only path.** A project whose rules run in one engine with native types keeps steps 1 and 2. Its
generator still refuses a scope that is not structural (G7), and writes the scope's declarations, extensions
and options from the same schemas (G6), typed with the engine's native types. It writes no descriptor set, so
steps 5 to 9 do not apply: there is no profile digest, no `CheckedExpr` and no bundle. At load, the host:

1. builds the typed environment from the generated declarations, with the pinned extensions and options (G4);
2. checks every rule, and the output type of each slot, and collects every issue (G1);
3. evaluates only the rules that checked.

The one engine is the checker of record, and G1 to G8 still apply.

## Structural scopes

A scope is structural when every node a rule can reach has one shape. The generator refuses a scope with any of
these on a reachable path, and reports the path and the reason:

- a `oneOf` or `anyOf` whose branches carry different shapes (a union);
- an `allOf` that merges shapes;
- an untyped node (`true` or `{}`), which would be `dyn`;
- an object with properties that is not sealed;
- a map of lists;
- a message or `null`, because it has two readings of absence (`null` and `{}`);
- a field whose name is a CEL reserved word.

Validation-only keywords do not change the shape, so the generator ignores them: `pattern`, bounds,
`if`/`then`/`else`, `not`, and a `oneOf` of `required` clauses. Kubernetes does the same: it types CRD rules from
the schema skeleton only.

| JSON Schema | proto3 | CEL |
| --- | --- | --- |
| Required `string`, `integer`, `number`, `boolean` | `string`, `int64`, `double`, `bool` | `string`, `int` (64-bit), `double`, `bool` |
| Optional scalar | `optional` scalar (field presence) | The scalar; `has()` tells absent from zero. |
| Nullable scalar (`[T, null]`, or `oneOf` of a scalar and `null`) | `google.protobuf.*Value` wrapper | `wrapper(T)`; null when absent. |
| Sealed object | message | message |
| `additionalProperties: {schema}` | `map<string, V>` | `map(string, V)` |
| Array | `repeated` | `list(T)` |
| `enum` of strings | `string`, with the values in a comment | `string`; the checker does not check the values. |

A message or `null` is not a nullable scalar, so the generator refuses it as a union. Flatten a real union in the
schema (a `kind` discriminator plus optional members, as Kubernetes does in KEP-1027), or omit the field from the
scope. No path that a rule can reach is typed `dyn`, and there is no exception list.

## Presence

After the protobuf JSON parser, what a rule reads depends on the field's kind. The spike measured every cell on
four engines (cel-go, cel-expr-python, cel-core and @bufbuild/cel), through the activation path.

| Field kind | Missing | Explicit `null` | Zero (`""`, `0`, `false`, `{}`) |
| --- | --- | --- | --- |
| Nullable scalar (wrapper) | Reads `null`. `has()` is false. Arithmetic on it is an evaluation error. | The same as missing: `has()` is false, and `== null` is true. | `has()` is true; reads the zero. |
| Optional scalar | Reads the zero value. `has()` is false. | The parser loads it as missing: `has()` is false. | `has()` is true. |
| Required scalar | Reads the zero value. `has()` is false. | The parser loads it as missing: `has()` is false. | `has()` is **false**: proto3 cannot tell zero from missing. |
| Message | `has()` is false; selecting through it reads defaults. | The same as missing. | `{}` is present: `has()` is true. |

What `has()` can tell apart:

- **Missing from zero:** a nullable scalar, an optional scalar and a message. For a message, `{}` is present and
  missing is not. A required scalar cannot: at its zero value it looks missing.
- **Missing from explicit `null`:** no kind. For a nullable scalar and a message, the two collapse by design, and
  both mean absent. For an optional or a required scalar, the parser loads a `null` as missing, even when the
  schema forbids that `null`.
- **What a missing value reads as:** a nullable scalar reads `null`. An optional or a required scalar reads its
  zero, and selecting through a missing message reads defaults.

So:

- Validate every record against its JSON Schema before activation. A `null` that the schema forbids then fails
  validation, and does not reach a rule as "missing".
- Guard a read with `has()` when the rule must tell a value from its absence. That works for a nullable scalar, an
  optional scalar and a message, and never for a required scalar at its zero value.
- Lint for presence (G2): flag a bare read of an optional or nullable field outside a `has()` guard, and a `has()`
  on a required scalar.

## General rules

**G1. Check before the first evaluation.**

- Check every rule when it loads, or in a compile step before it can run.
- Return every issue with its file path, line and column.
- Check the output type of each slot, for example `bool` for a guard. For a rule list, check the type of the
  compiled list's result against the slot type that the rule-list contract declares for the list's kind.
- A rule that fails to check or to evaluate never counts as a pass.
- An engine without a checker runs only rules that a checker of record checked in the same environment.
- A string enum becomes a CEL `string`, so the checker does not catch a misspelt value. Add a load-time lint that
  compares each string literal with the enum of the field it is compared to.
- Check: the adapter tests, and the enum lint's own cases.

**G2. Document presence.**

- For each field kind (nullable, optional and required scalar, message), write down what a rule reads when the
  field is missing, explicitly `null` and zero, and what `has()` returns. The table above is that record for the
  protobuf mapping.
- Validate every record against its schema before activation, because a parser can load a forbidden `null` as if
  the field were missing.
- Check: presence cases for every kind and every state, run on each engine through the activation path (parse
  the record, then evaluate). Also a presence lint: it flags a read of an optional or nullable field outside a
  `has()` guard, and a `has()` on a required scalar.

**G3. Test each engine by its role.**

- Give each engine a role: checker of record, evaluator, or source-checking alternative (see Engine roles). What a
  passing run proves depends on that role.
- In CI, each selected engine passes the supported-profile cases of its role, for every profile.
- A checker of record passes these cases:
  - typed accept, reject, profile and presence cases;
  - reject cases for a wrong field, a wrong operand type, a read of an omitted field and an undeclared variable;
  - profile cases in which an enabled feature checks and an excluded one fails;
  - tampered-bundle cases on its own bundles.
- An evaluator passes these cases:
  - the presence cases, run through the activation path (parse a record, then evaluate);
  - the tampered-bundle cases, refused by the host's verifier;
  - every `CheckedExpr` that a checker of record shipped, evaluated to its expected value.
- Every checker of record checks every standalone expression that the project ships. Fail CI when two of them
  disagree on whether it checks, or on its output type.
- A policy file (`.celpolicy`) is compiled only by the policy-capable reference checker (cel-go). Every other
  engine evaluates the `CheckedExpr` that it wrote, as a shipped case, and never parses the policy file.
- Run cel-spec's simple tests on every engine against a committed failure baseline. Fail on a missing engine, a
  new failure or a new pass. The scores are diagnostic data about the subset that ran. An evaluator's own
  checker results are diagnostic too.
- Check: the CI gate.

**G4. Pin behavior.**

- Pin each engine's version, its checker and parser options, and each extension's version. Record them with
  every checked rule.
- Enable only extensions that every engine that runs the rules has.
- Each adapter keeps an explicit inventory of the extension versions it supports, and refuses any other at
  load. Do not rely on the engine to reject a version it does not have.
- Use one pinned version of the reference engine for checking and for the conformance oracle.
- Check: a test per adapter that an unknown extension version is refused, and a test that an excluded function
  or syntax fails to check.

**G5. Enforce only real bounds.**

- A static cost figure is an *estimate*. It becomes a bound only when both of these hold:
  - every input limit it assumes (each collection's `maxItems`, each string's `maxLength`) is enforced before
    activation;
  - every enabled operation has a conservative cost model.
- Until both hold, report the estimate in CI, and do not present it as a guarantee.
- At runtime, a limit counts only if the engine can stop the evaluation. A timeout around an evaluation that
  cannot be interrupted only reports.
- Check: the CI cost step labels its figure an estimate unless both conditions hold. An adapter test shows an
  over-budget rule failing where the engine supports a limit.

**G6. Generate the environment.**

- The type environment is data, generated from the schema that is the source of truth: the declarations, their
  types, the extensions and the options.
- Never hand-write it.
- Check: a CI job regenerates it and fails on a diff.

**G7. Type structural scopes only.**

- Every node a rule can reach has one shape (see Structural scopes).
- Refuse a shape-changing union and an untyped node on a reachable path, with its path and reason.
- Ignore what does not change the shape: validation-only combinators.
- A two-branch union of a **scalar** and `null` is a nullable scalar. A message, a list or a map with `null` is a
  union.
- Flatten a real union in the schema, or omit the field from the scope. Do not type it `dyn`.
- Check: the generator exits non-zero on a refused scope.

**G8. Point rule-writing agents at the generated environment.**

- Agent skills and tools that write or test CEL read the generated environment, and never author their own.
- When no generated environment covers a scope, the agent stops and asks for one.
- Check: the project's agent skills have no step that authors an environment. The
  `business-rules-cel-authoring`, `business-rules-cel-debugging` and `business-rules-cel-testing` skills follow
  this rule.

## Protobuf portability profile

**P1. Map presence to protobuf wrappers.**

- A nullable scalar becomes a `google.protobuf.*Value` wrapper. An optional scalar becomes a proto3 `optional`
  field. A required scalar becomes a plain field, and an object becomes a message.
- Record G2's presence table for this mapping. It has the lossy cases above by design.
- Check: G2's activation-path cases, per kind.

**P2. Ship checked rules as CheckedExpr bundles.**

- A rule crosses a process or language boundary as a `cel.expr.CheckedExpr` in a `google.protobuf.Any`.
- The bundle's identity is three things:
  - the profile digest;
  - the checker (engine and version);
  - the SHA-256 of each entry's exact payload bytes.
- A writer's bytes are not reproducible: map entries in the type and reference maps change order between runs.
  So hash the payload as shipped, when the checker writes it. A re-check writes new bytes and a new bundle
  together.
- The manifest names the descriptor set's SHA-256 and the checkers of record.
- Each entry also carries its source's path and SHA-256, and its output type.
- A verifier refuses another profile's digest, a checker that the profile does not list as of record, and a
  payload whose hash differs.
- The producer verifies the sources when it checks them. The host verifies them again at load. An evaluator that
  has only the bundle verifies the rest.
- At load, the host makes these checks in this order:
  1. it refuses a descriptor set whose bytes do not match the manifest's SHA-256;
  2. it builds its environment from the manifest and computes the profile digest;
  3. it refuses a bundle whose profile digest differs;
  4. it refuses a bundle whose checker is not of record in the manifest;
  5. it refuses an entry whose payload SHA-256 differs;
  6. it hashes each rule source, and refuses a source with no entry or with an entry whose source SHA-256 differs.
- A refusal stops the load. It names the file and the command that rebuilds the bundle.
- Check: tampered-bundle tests in each adapter, including a substituted payload and a checker not of record, and
  a refusal fixture for a descriptor set whose bytes differ from the manifest's.

**P3. Use protobuf JSON at the edges.**

- Records enter the activation through the engine's protobuf JSON parser against the generated
  FileDescriptorSet, after schema validation (G2).
- Test files use the protobuf JSON form, which loads with a plain JSON parser in every language.
- Values leave an adapter as `cel.expr.Value` protobuf JSON, so results compare across languages with one
  comparator.
- Check: the activation-path cases parse real records, and the conformance runners read the JSON suite.

**P4. Wrap each engine in the same adapter.** Each runtime has one adapter with the same five operations:

```text
load(manifest, descriptor_set) -> Environment | [Issue]   refuse descriptor bytes that differ from the manifest's
                                                          SHA-256, and an extension version or option it lacks
check(env, path, expr, slot)    -> CheckedExpr | [Issue]   absent where the engine has no checker
program(env, bundle_entry)      -> Program | [Issue]       refuse another profile's digest or a stale source
eval(program, activation)       -> Value | EvalError       activation: variable -> record (JSON) or message
identity()                      -> {engine, version, options}
```

- An `Issue` is `{path, line, column, message}`.
- The eval operation returns an error for a rule that fails to evaluate. The caller records it as a finding with
  an unknown result, never as a pass.
- The `business-rules-code` skill covers how to write the adapter and the code that calls it.
- Check: each adapter's tests call the five operations.

## Engine roles

An engine's role decides what its results can prove.

- **Checker of record.** Its check decides whether a rule ships. The reference checker (cel-go) checks rule lists
  and every rule that ships across a boundary, and it alone compiles policy files. A host that checks standalone
  expressions at load (cel-expr-python in a Python host) is a second checker of record for those expressions
  only.
- **Evaluator.** It runs only `CheckedExpr` messages that a checker of record wrote in the same profile, after the
  bundle check. Its own checker, if it has one, is diagnostic.
- **Source-checking alternative.** It checks and evaluates source, but cannot read or write a `CheckedExpr`. It
  cannot run a bundle.

## Engine and tooling choices (2026-11)

This list records the choices as of 2026-11. Replace it when the evidence changes. The criteria are:

- a checker;
- `CheckedExpr` input and output;
- environment-file input;
- the project's supported-profile result;
- maintenance and licence.

| Language | Choice | Role | Reference |
| --- | --- | --- | --- |
| Go | cel-go, through a small reference checker that builds the environment from the manifest with explicit options and appends nothing | Checker of record and conformance oracle | [go.md](references/go.md) |
| Python | cel-expr-python | Checker of record for expressions checked at load; evaluator | [python.md](references/python.md) |
| Rust | cel-core, with a named owner | Evaluator of reference-checked rules | [rust.md](references/rust.md) |
| Rust | cel-cxx, where a C++ toolchain and Bazel are acceptable | Source-checking alternative | [rust.md](references/rust.md) |
| TypeScript | @bufbuild/cel, in a profile with no optional or bindings extension | Evaluator | [typescript.md](references/typescript.md) |
| Tooling | The `cel-expr` CLI, installed only from a release whose signature and provenance you verify | Authoring and typed test cases with coverage; it writes no `CheckedExpr` | [go.md](references/go.md) |

The `cel-expr` MCP server, in fixed-environment mode, is the agent tool that satisfies G8. Do not use its
`cel_create_environment` tool: that is a hand-written environment in tool form.

The gotchas that apply to every engine are in [gotchas.md](references/gotchas.md). Read them before writing a rule
or an adapter.

## cel-policy profile

This part applies only when a project writes rule lists as cel-policy files (`.celpolicy`).

**C1. Write a rule list in the supported policy profile.**

- An ordered first-match list is a cel-policy `match` block: `condition` is the "when", and `output` is the
  "then".
- The supported profile is an allow-list of what was shown to run on every evaluator:
  - a `name`, and a `rule` with one `match` block, evaluated first-match;
  - each choice has an `output`, and every choice except the final one has a `condition`;
  - the final choice has no condition, so it always matches;
  - conditions and outputs in the rule list's profile manifest. For a browser evaluator, that is the restricted
    profile: no optional and no bindings extension.
- Every other cel-policy field is outside the profile: `variables`, `aggregate`, a nested `rule`, `explanation`
  and `imports` among them. The compile step refuses an excluded feature before the policy compiler runs, in
  every profile, with no exception by profile name. The compiler alone accepts `aggregate`, `variables` and a
  match with no final choice.
- Compile the list with a pinned policy compiler, and ship the one `CheckedExpr` it writes (P2).
- Know what the compiler checks:
  - output-type assignability across the choices;
  - a literal `false` condition;
  - a literally true choice before the last one.
- Know what it does not catch:
  - A condition that is always false without being the literal `false`.
  - A `match` with no final choice. Without a final choice, the output becomes an optional, which needs the
    optional extension in every evaluator.
  - A list whose choices agree on the wrong type. A `dyn` output is assignable to anything. So the compile step
    also checks the compiled list's result type against the slot type that the rule-list contract declares for
    the list's kind, and refuses a list whose type differs (G1).
- A "no match" result is an explicit final choice, such as `- output: '"unknown"'`, with a value that the rule
  list's schema reserves. The host records it as an unknown result, never as a pass. A list of another kind ends
  with an explicit default of the same type as its other outputs, so the output-type check still holds.
- Add each further feature (`variables`, `aggregate`, nested rules, `explanation`) only when tests of its emitted
  `CheckedExpr` pass on every target evaluator. Compiling is not enough: `variables` compiled to `cel.@block`
  and then failed on two of three evaluators.
- Check: refusal fixtures for each excluded feature, for a non-final choice with no condition, and for a list
  whose result type differs from its slot type; and the policy test cases on each evaluator.

The file layout, standalone expressions in config, the bundle's fields, versioning and YAML hygiene are in
[formats.md](references/formats.md).

## References

| Read when | Reference |
| --- | --- |
| Rule formats: the cel-policy file, standalone expressions in config, the bundle's fields, versioning, YAML hygiene | [formats.md](references/formats.md) |
| Tools: the reference checker, the `cel-expr` CLI and its release limits, buf, mise pins, the vendored skills | [tools.md](references/tools.md) |
| Python: cel-expr-python, and why `common-expression-language` is not a checker | [python.md](references/python.md) |
| Go: cel-go as the reference checker, the policy package, the `cel-expr` CLI | [go.md](references/go.md) |
| Rust: cel-core, cel-cxx and the `cel` crate | [rust.md](references/rust.md) |
| TypeScript: @bufbuild/cel and @marcbachmann/cel-js | [typescript.md](references/typescript.md) |
| Numbers, `has()`, wrappers, errors, enums, `size()`, time zones, extension versions | [gotchas.md](references/gotchas.md) |
