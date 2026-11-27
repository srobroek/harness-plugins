---
name: business-rules-cel-debugging
description: "Use to diagnose and fix a CEL compile or evaluation error against the project's generated environment."
metadata:
  opencode/autoinvoke: false
---

# CEL debugging

Adapted from the `cel-debugging` skill of [cel-expr/skills](https://github.com/cel-expr/skills) (Apache-2.0). The
[NOTICE](NOTICE) lists the upstream commit and the changes.

Use this skill only when you diagnose or fix a broken CEL expression or `.celpolicy`. Do not run `cel-expr` during
read-only triage, where no expression is written or debugged.

Install `cel-expr` only from a release whose checksum, signature and provenance you verify (the
`install-cel-expr` recipe in the `business-rules-ci` skill). Never install it with `go install …@latest`.

## Workflow

1. **Identify the phase.** Decide whether the error is a compile error (syntax and types) or an evaluation error.
2. **Locate the generated environment.** Read the scope's generated environment file
   (`<generated>/env/<scope>.env.json`) and its profile manifest, to confirm the declared variables, types, field
   names and extensions. The descriptor set is `<generated>/types.binpb`. Read these before you search the
   evaluator's code. When no generated environment covers the scope, stop and ask for one to be generated.
3. **Apply the fix.** Correct the expression or the `.celpolicy`. Never edit the environment: it is generated. When
   the fix needs a new variable, field, extension or option, stop and ask for a change to the scope or the profile.
4. **Verify.** Run `cel-expr eval` again (or `cel-expr compile` when no test bindings are needed), then the
   project's reference checker. The `cel-expr` `v0.4.0` release has no `-format=policy`, so verify a `.celpolicy`
   with the reference checker.

## Common compile errors

These errors occur before execution, because of typos, unknown names or a wrong operand type.

### 1. "Undeclared reference" or "undefined field"

The expression names a variable, function or field that the environment does not declare.

- Issue (typo): `user.amin`, a typo for `user.admin` or `user.is_admin`.
- Solution: correct the name against the generated environment and the descriptor set. Field names keep their
  case: `job.exitCode`, not `job.exitcode`.
- Issue: the name is spelt right, but the scope does not declare it. The scope omits the field, or the variable
  is not in the scope.
- Solution: stop, and ask for the scope to be changed and regenerated. Do not add the variable, `protoTypes` or
  `imports` yourself.

### 2. "Type mismatch" or "no matching overload"

A function or operator gets argument types it has no overload for:

- Issue: `"123" + 456`, or `request.path.startsWith(123)`.
- Solution: convert explicitly, for example `int("123")` or `string(456)`.
- Issue: `job.progress.fraction > 1` compares a `double` with an `int`.
- Solution: write the literal as a double, `job.progress.fraction > 1.0`.
- Issue: `decision.status == 1` compares a string with an int.
- Solution: compare with a value of the field's type, `decision.status == "approved"`.

### 3. "Syntax error"

Unclosed brackets, mismatched parentheses or invalid operators:

- Issue: `user.age > 18 || (user.country == 'US'`.
- Solution: `user.age > 18 || (user.country == 'US')`.
- Issue: `request.time > now & request.path != "secret"`.
- Solution: `request.time > now && request.path != "secret"`.

## Evaluation errors

These errors occur at runtime, when a valid compiled expression meets missing or unexpected data. Read the
presence table in `business-rules-cel` first: in a message-typed scope, an unset field reads its default value,
and only a nullable field reads `null`.

### 1. "No such field", "no such key", or arithmetic on `null`

The expression reads an unset field, a missing map key, or a nullable field that is `null`:

- Issue: `user.profile.website == "goog.com"`, when `profile` may be unset.
- Solution A, presence with `has()`: test presence first. When a `has()` is false, `&&` is false and ignores an
  error on its other side:

  ```text
  has(user.profile) && has(user.profile.website) &&
  user.profile.website == "goog.com"
  ```

- Solution B, optional chaining with `.?`: traverse unset fields with `.?` and `.orValue()`. This needs the
  `optional` extension. Use it only when the profile manifest lists it:

  ```text
  user.?profile.?website.orValue("") == "goog.com"
  ```

- Solution C, a map field (`map<string, V>`): guard the key with `in`:

  ```text
  'website' in user.links && user.links['website'] == "goog.com"
  ```

- Solution D, a map field with the `optional` extension: guard the key with `[?]` and `orValue()`:

  ```text
  user.links[?'website'].orValue("") == "goog.com"
  ```

Solutions C and D apply only to map-typed fields. A message field is selected with `.`, and its presence is tested
with `has()`.

### 2. "Division by zero"

The denominator is `0` at runtime:

- Issue: `x / y > 10` fails when `y == 0`.
- Solution: guard the denominator, and decide what the rule means when it is zero. `y != 0 && x / y > 10` is
  false at zero. Write `y == 0 || x / y > 10` when zero must pass.

Do not convert the operands to `double` to avoid the error. A `double` divided by zero is infinite, not an error,
so `double(x) / double(y) > 10.0` is true when `y` is zero and `x` is positive: the guard passes.

### 3. "No such overload" at runtime

The runtime types of a value do not match the function's signature, or a function's extension is not enabled:

- Issue: the function belongs to an extension that the profile does not list, for example `math.greatest`.
- Solution: the expression may use only the extensions in the profile manifest. Rewrite the expression without
  the function, or stop and ask for a profile change.
- Issue: a value is `dyn`. A structural scope has no `dyn` (rule G7). If one appears, the scope is not structural.
  Report it, and do not guard around it with `type()` checks.

## Strategies for isolating faults

1. **Decompose the expression.** Split a long `&&` or `||` rule into smaller sub-expressions, and test each one.
2. **Start from a minimal input.** Begin with a minimal JSON binding, and add fields one at a time to find the
   failing read.
3. **Check the runtime type.** Evaluate `type(val)` in a scratch expression to see what a value really is.

## Verification with the `cel-expr` CLI

Validate the corrected expression with `cel-expr eval`, against the generated environment. The `-tests` format is
in the `business-rules-cel-testing` skill's `references/test_cases_schema.json`:

```sh
cel-expr eval -env <env.json> -fds <types.binpb> -expr "<expression>" \
  -bindings '{"decision": {"status": "approved"}}' -expected true
# or with an inline test suite array, or a file:
cel-expr eval -env <env.json> -fds <types.binpb> -expr "<expression>" \
  -tests '[{"testCase": "case1", "bindings": {"decision": {"status": "approved"}}, "expected": true}]'
```

Then run the project's reference checker on the rule file. A fix counts only when the reference checker accepts the
rule.
