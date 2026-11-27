---
name: business-rules-cel-testing
description: "Use to test one CEL expression with cel-expr: derive cases from its input schema and raise node and branch coverage."
metadata:
  opencode/autoinvoke: false
---

# CEL expression testing

Adapted from the `cel-testing` skill of [cel-expr/skills](https://github.com/cel-expr/skills) (Apache-2.0). The
[NOTICE](NOTICE) lists the upstream commit and the changes.

Use this skill to test one CEL expression with many inputs while you write it, until its coverage is complete,
with the `cel-expr` CLI. For the project's suite, which runs on every engine, use the `business-rules-testing`
skill. The cases you write here join that suite.

Install `cel-expr` only from a release whose checksum, signature and provenance you verify (the
`install-cel-expr` recipe in the `business-rules-ci` skill). Never install it with `go install …@latest`.

Every command reads the scope's generated environment and descriptor set: `-env <generated>/env/<scope>.env.json
-fds <generated>/types.binpb`. When no generated environment covers the scope, stop and ask for one to be generated.
Never write an environment for a test.

## Workflow

1. **Compile the expression.** Run `cel-expr compile` (or `cel-expr eval` with no cases) against the generated
   environment, and read the `inputSchema` and `outputSchema` it prints.
2. **Generate test cases.** Write cases from the input and output schemas, and from the field kinds in the
   descriptor set.
3. **Evaluate.** Run the cases with `cel-expr eval -tests`.
4. **Raise coverage.** Add cases until `cel-expr eval` reports 100% node and branch coverage. The coverage
   threshold is the check.

### 1. Compile the expression

```sh
cel-expr eval -env <generated>/env/<scope>.env.json -fds <generated>/types.binpb -expr "<expression>"
```

On success, the output contains the `inputSchema` and the `outputSchema` of the expression. When the compile
fails, fix the expression with the `business-rules-cel-debugging` skill.

The `inputSchema` has a known bug: after `has(part.mass_target)` it reports the field as `boolean` where the field
is a `double`. Take each field's type from the generated environment and descriptor set, not from `inputSchema`.

The `cel-expr` `v0.4.0` release has no `-format=policy`. Test a `.celpolicy` through the project's suite until a
verified release has the flag.

### 2. Generate test cases

Write a test suite file in the format of [test_cases_schema.json](references/test_cases_schema.json), copied
unchanged from upstream. A suite is a top-level JSON array of test cases. `bindings` gives each variable that the
expression reads, in the record's JSON form. `expected` matches the `outputSchema`:

```json
[
  {
    "testCase": "approved by a reviewer",
    "bindings": {
      "decision": { "status": "approved", "approval": { "channel": "review" } }
    },
    "expected": true
  }
]
```

- When the input schema has an `additionalProperties` or `items` key, write cases where the map or list is
  populated, and cases where it is empty.
- For each field the expression reads, write the presence states from the presence table in `business-rules-cel`:
  missing, explicit `null` and zero, for its field kind.

### 3. Run the tests

Pass the cases as a file, as an inline JSON array, or as one case with `-bindings` and `-expected`:

```sh
cel-expr eval -env <env.json> -fds <types.binpb> -expr "<expression>" -tests <suite>.json
cel-expr eval -env <env.json> -fds <types.binpb> -expr "<expression>" \
  -tests '[{"testCase": "approved", "bindings": {"decision": {"status": "approved"}}, "expected": true}]'
cel-expr eval -env <env.json> -fds <types.binpb> -expr "<expression>" \
  -bindings '{"decision": {"status": "approved"}}' -expected true
```

`cel-expr eval` exits 1 when a case fails.

### 4. Evaluate coverage and iterate

Read the result of each case and the node and branch coverage. Add cases until both reach 100%, and drop cases
that do not raise it. Then:

1. Save the suite next to the rule, where the project's `rules-cli-tests` recipe finds it (`business-rules-ci`).
2. Add the cases that cover a distinct behavior to the project's case file (`business-rules-testing`), so every
   engine runs them.
