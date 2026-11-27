---
name: business-rules-cel-authoring
description: "Use to write or change a CEL expression or .celpolicy against the project's generated environment, then compile and test it."
metadata:
  opencode/autoinvoke: false
---

# CEL authoring

Adapted from the `cel-authoring` skill of [cel-expr/skills](https://github.com/cel-expr/skills) (Apache-2.0). The
[NOTICE](NOTICE) lists the upstream commit and the changes.

Use this skill only when you write or change a CEL expression or a `.celpolicy`. Do not run `cel-expr` during
read-only triage, where no expression is written or changed.

Install `cel-expr` only from a release whose checksum, signature and provenance you verify (the
`install-cel-expr` recipe in the `business-rules-ci` skill). Never install it with `go install …@latest`.

## Workflow

1. **Locate the generated environment.** Find the generated environment and descriptor set for the rule's scope.
   Stop when none covers the scope.
2. **Generate a prompt (optional).** Skip it when you have read a short environment file.
3. **Create, evaluate and test.** Write the expression, run `cel-expr eval` with test cases, and reach more than
   95% node and branch coverage.
4. **Check it with the reference checker.** The rule ships only after the project's reference checker accepts it.

## Locate the generated environment

The environment is generated from the published schemas (`business-rules-cel`, rules G6 and G8). Never write
one.

1. Find the generated artifacts for the rule's scope. The project's engineering doc or its `rules-gen` recipe
   names the directory. Expect:
   - `env/<scope>.env.json`: the environment in the JSON form that `cel-expr` reads;
   - `types.binpb`: the FileDescriptorSet;
   - `profile/<scope>.profile.json`: the profile manifest, with the variables, extensions and options.
2. Read the environment file and the manifest. Use only the variables, fields, extensions and options they list.
3. Pass `-env <generated>/env/<scope>.env.json -fds <generated>/types.binpb` to every `cel-expr` command.

**Stop and ask** in any of these cases. Report the scope, and the variable or schema node that is missing:

- No generated environment covers the scope.
- The rule needs a field that the scope omits.
- The rule needs an extension or an option that the profile excludes.

Each of these is a change to the scope or the profile, made in the generator's config and regenerated. It is not a
change to the rule. While you wait:

- do not write or edit an `envConfig`;
- do not add variables, `protoTypes`, `imports` or extensions;
- do not build a descriptor set with `protoc`;
- do not edit a generated file.

## Generate a prompt (optional)

Skip `cel-expr prompt` when you have read a short environment file, and go to `cel-expr eval`. Use the prompt for
a large environment, or to expand the field paths of the descriptor set:

```sh
cel-expr prompt -env <generated>/env/<scope>.env.json -fds <generated>/types.binpb -prompt "<user request>"
```

## Create, evaluate and test

Write the simplest expression that meets the requirement. Run `cel-expr eval` to compile, type-check and evaluate
it in one step. Use `cel-expr compile` when you need no test cases. Fix a compile or evaluation error with the
`business-rules-cel-debugging` skill.

For a single test case, pass `-bindings` and `-expected`. A message-typed variable takes the record's JSON form:

```sh
cel-expr eval -env <env.json> -fds <types.binpb> -expr "<expression>" \
  -bindings '{"decision": {"status": "approved"}}' -expected true
```

For a test suite, pass `-tests` with a file path or an inline JSON array. The payload is a top-level JSON array of
`{"testCase", "bindings", "expected"}` objects. The schema is `references/test_cases_schema.json` in the
`business-rules-cel-testing` skill:

```sh
cel-expr eval -env <env.json> -fds <types.binpb> -expr "<expression>" \
  -tests '[{"testCase": "approved", "bindings": {"decision": {"status": "approved"}}, "expected": true}, {"testCase": "rejected", "bindings": {"decision": {"status": "rejected"}}, "expected": false}]'
```

Test cases must cover edge cases and missing fields. Take the missing-field states from the presence table in
`business-rules-cel`: missing, explicit `null` and zero, for each field kind the rule reads. Prune cases that do
not raise coverage.

Guard every map key and list index:

- Before: `m[k]`. After: `k in m && m[k]`, or `m[?k].orValue(<default>)`.
- Before: `l[i]`. After: `l.size() > i && l[i]`, or `l[?i].orValue(<default>)`.

The `?` forms need the `optional` extension. Use them only when the profile manifest lists it.

`cel-expr eval` reports node and branch coverage as percentages. Add cases until both are above 95%. Report the
results with both coverage figures.

Then:

1. Run the project's reference checker on the rule file (the `rules-check` recipe). `cel-expr` writes no
   `CheckedExpr`, so its compile result does not make a rule shippable.
2. Add the cases to the project's case file (the `business-rules-testing` skill), so every engine runs them.

## Authoring CEL policies (`.celpolicy`)

Write a rule list in the supported policy profile (`business-rules-cel`, rule C1):

- a `name`, and a `rule` with one `match` block: the choices evaluate in order, and the first match wins;
- every choice has an `output`, and every choice except the final one has a `condition`;
- no `variables`, no `aggregate`, no nested `rule`, no `explanation` and no `imports`;
- a final choice with no condition, whose output the rule list's schema reserves for "no match", such as
  `- output: '"unknown"'`. Without it, the composed policy returns an optional value, which the profile excludes;
- outputs of the slot type that the rule-list contract declares for the list's kind. The reference checker
  refuses a list whose result type differs.

The `cel-expr` `v0.4.0` release has no `-format=policy`. Until a verified release has it, compile the policy with
the project's reference checker, and run its test cases through the project's suite. With a verified release that
has the flag, pass `-format=policy` to `cel-expr compile` or `cel-expr eval`. The expression input is a file path
or inline policy YAML:

```sh
cel-expr compile -env <env.json> -fds <types.binpb> -format=policy -expr <policy.celpolicy>
cel-expr eval -env <env.json> -fds <types.binpb> -format=policy -expr <policy.celpolicy> -tests <tests.json>
```
