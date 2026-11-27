---
name: business-rules-testing
description: "Use to write or review business-rule tests: CEL rule tables, the supported-profile suite per engine, presence and bundle cases."
metadata:
  opencode/autoinvoke: false
---

# Business rule tests

This skill covers the project's rule test suite: the cases that every engine runs, and the gate they feed. The
rules they test are in the `business-rules-cel` skill (G1 to G8, P1 to P4, C1). The general testing rules are in
the `quality-testing` skill.

Use the `business-rules-cel-testing` skill for a different job: raising the node and branch coverage of one
expression with the `cel-expr` CLI while you write it. Its cases can then join this suite.

## One case file, every engine

Keep the cases as data, one file per scope, for example `rules/tests/<scope>.cases.json`. Every engine's test
runner reads the same file, so a case is written once. Use JSON, with records in protobuf JSON form, so each
language loads it with a plain JSON parser (P3).

Each case has:

- `name`: unique in the file;
- `kind`: one of the kinds below;
- `rule`: the expression, or the path of a rule file and the rule's path in it;
- `activation`: one record per variable, as JSON (omit it for a case that only checks);
- `expect`: one of `{"value": …}`, `{"check_error": "<substring>"}`, `{"eval_error": true}` or `{"refused": "<reason>"}`.

```json
{
  "scope": "gate_guard",
  "cases": [
    {
      "name": "approved decision passes",
      "kind": "accept",
      "rule": "decision.status == \"approved\"",
      "activation": { "decision": { "status": "approved" } },
      "expect": { "value": true }
    },
    {
      "name": "misspelt field fails at check",
      "kind": "reject",
      "rule": "decision.approvel.channel == \"web\"",
      "expect": { "check_error": "undefined field 'approvel'" }
    }
  ]
}
```

A `check_error` case also asserts the issue's line and column when the rule comes from a file (G1). An
`eval_error` case asserts that the caller records the result as unknown, never as a pass (P4).

## The supported-profile suite, by engine role

Each engine runs the case kinds of its role. All of them are required in CI (G3).

| Kind | What it proves | Checker of record | Evaluator |
| --- | --- | --- | --- |
| `accept` | A good rule checks and evaluates to the expected value | Required | |
| `reject` | A bad rule fails at check | Required | Diagnostic, if it has a checker |
| `profile` | Each enabled feature works, and each excluded one is refused | Required | Diagnostic for check-time options |
| `presence`, `presence_record` | The presence table holds for every kind and state | Required | Required |
| `bundle` | A tampered bundle is refused | Required, on its own bundle | Required, refused by the host's verifier |
| `shipped` | Every `CheckedExpr` a checker of record wrote evaluates to the expected value | | Required |
| `portability` | A `CheckedExpr` from a writer that is not of record reads across engines | | Diagnostic |

- Values must match exactly. Compare results as `cel.expr.Value` protobuf JSON, with one comparator for every
  language (P3).
- Fail CI when two checkers of record disagree on whether a standalone expression checks, or on its output type.
- A policy file is compiled only by the policy-capable reference checker (cel-go). Every other engine evaluates
  the `CheckedExpr` that it wrote, as a `shipped` case, and never parses the policy file.
- Run cel-spec's simple tests on every engine against a committed failure baseline. A missing engine fails the
  run. A new failure and a new pass both fail it too, so an upgrade that changes behavior gets reviewed and the
  baseline is updated on purpose. The scores themselves are diagnostic: they say how much of cel-spec an engine
  covers, and most of what it misses is outside any profile.
- cel-spec's tests only check that good expressions pass. They miss checker gaps: cel-core scores 1639 of 1640
  and still accepts `decision.status == 1`. The `reject` cases are the only checker test.

## The cases every project needs

### Wrong field fails at check, per scope

For each scope, at least one `reject` case of each of these:

- a misspelt field (`decision.approvel.channel`);
- a field with the wrong case (`job.exitcode` for `exitCode`);
- a wrong operand type (`job.progress.fraction + "x"`, `decision.status == 1`);
- a read of a field that the scope omits (`part.intent.route.size() > 0`);
- an undeclared variable (`undeclared.x == 1`);
- a misspelt enum literal (`decision.status == "aproved"`), which only the enum lint catches (G1).

### Presence

One case per field kind and per state, for both forms:

- `presence`: build the value with a message literal in the rule, so every engine evaluates the same input;
- `presence_record`: take a valid record, remove the field, set it to `null` or set it to its zero value, parse
  it with the engine's own protobuf JSON parser, then evaluate.

| Kind | States | Asserts |
| --- | --- | --- |
| Nullable scalar (wrapper) | Missing, `null`, zero, set | The read value, `has()`, and that arithmetic on a missing value is an evaluation error |
| Optional scalar | Missing, `null`, zero, set | The read value and `has()` |
| Required scalar | Missing, `null`, zero, set | `has()` is false at zero |
| Message | Missing, `null`, `{}`, set | `has()` and a read through it |

Also add the presence lint's cases (G2): a bare read of an optional or nullable field outside a `has()` guard is
flagged, and so is a `has()` on a required scalar.

### Bundle tampering

Run these on the reference checker's bundle, on every engine (P2). Build each one from a copy of the bundle
directory:

| Case | Expect |
| --- | --- |
| The bundle names another profile's digest | Refused |
| A source file was edited after the check | Refused, where the verifier has the sources |
| A rule source has no entry in the bundle | Refused, where the verifier has the sources |
| One entry's payload replaced by another entry's payload, metadata unchanged | Refused |
| The checker is not one of the profile's checkers of record | Refused |
| Verification with no sources | Passes: digest, checker and payloads only |

A bundle from a writer that is not of record never runs as a gate case. Evaluate it under `portability`.

### The effective environment

`profile` cases prove that each engine runs exactly the manifest's environment (G4):

- one case per enabled feature, which must evaluate as expected: for strings version 4,
  `"a".upperAscii() == "A"` and `"%s".format(["x"]) == "x"`; with homogeneous aggregate literals off, a
  mixed-type list literal;
- one case per excluded feature, which the checker must refuse: a math function, optional syntax (`.?`),
  `cel.bind`, an encoder, a lists-extension function, and a `double` compared with an `int`;
- one adapter test per engine that a manifest with an unknown extension version (strings 99) is refused at load;
- one refusal fixture per adapter: a descriptor set whose bytes differ from the manifest's SHA-256, refused before
  any environment is built.

An evaluator cannot enforce a check-time option, so its result on an excluded option is diagnostic. It is
safe only because it runs reference-checked bundles.

### The JCS vector

One committed test vector holds a manifest, its RFC 8785 canonical bytes and its digest. Every adapter that
computes the profile digest reproduces both exactly. The vector covers:

- key order, at the top level and in nested objects;
- string escaping: a quote, a backslash, a control character with a short form (`\b`), one without (U+001F),
  a `/`, and DEL (U+007F), which stays literal;
- both integer bounds, `9007199254740992` and `-9007199254740992`;
- the end of the output: the bytes end at the closing brace, with no trailing newline.

Add refusal cases for the generator: a float, a non-ASCII string, a non-ASCII key, and an integer one past each
bound.

### Standalone expressions

When config files hold expressions (`business-rules-cel`, `formats.md`):

- a file with two bad expressions reports both issues in one load, each with its JSON Pointer path, line and
  column in the file;
- an expression whose output type differs from its slot is refused, for example an `int` where a guard needs a
  `bool`;
- both checkers of record agree on whether each standalone expression checks, and on its output type;
- a YAML fixture with a duplicate key, and one with an unquoted `!has(...)`, fail at load.

### Policies

When the project uses cel-policy (C1), only the reference checker compiles the policy files. The other engines
run the compiled `CheckedExpr`:

- one refusal fixture per excluded feature: `variables`, `aggregate`, a nested `rule`, `explanation` and
  `imports`;
- refusal fixtures for the choice rules: a non-final choice with no `condition`, and a final choice with one;
- a refusal fixture for a list whose result type differs from its slot type, for example every choice with a
  `dyn` output in a `bool` slot;
- the compiler's own refusals: a literal `false` condition, a literally true choice before the last one, and an
  output whose type does not match the other outputs;
- one accepted fixture with a condition that is always false without being the literal `false`, which documents
  the gap;
- value cases for the compiled list on every evaluator, including the final "unknown" choice, which the host
  records as an unknown result.

## Running the cases

Each runner loads the case file, builds the environment from the profile manifest through the project's
adapter (P4), and runs one test per case, named by `name`. The adapter's five operations do the work, so the
runner stays a loop. The snippets use the adapter's names (`load`, `check`, `program`, `evaluate`), so map them
to your adapter.

pytest (`lang-python-testing`):

```python
CASES = json.loads(Path("rules/tests/gate_guard.cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_rule_case(case: dict, gate_guard_env: Environment) -> None:
    result = run_case(gate_guard_env, case)  # check, then evaluate the activation
    assert result == expected_of(case)
```

go test:

```go
func TestRuleCases(t *testing.T) {
    env := loadProfile(t, "gate_guard")
    for _, c := range loadCases(t, "rules/tests/gate_guard.cases.json") {
        t.Run(c.Name, func(t *testing.T) {
            got := runCase(env, c)
            if diff := cmp.Diff(c.Expect, got, protocmp.Transform()); diff != "" {
                t.Errorf("%s: (-want +got)\n%s", c.Name, diff)
            }
        })
    }
}
```

cargo test: a plain `#[test]` cannot make one test per case at run time. Collect the failures, and report every
one of them by name:

```rust
#[test]
fn rule_cases() {
    let env = load_profile("gate_guard");
    let failures: Vec<String> = load_cases("rules/tests/gate_guard.cases.json")
        .iter()
        .filter_map(|c| run_case(&env, c).err().map(|e| format!("{}: {e}", c.name)))
        .collect();
    assert!(failures.is_empty(), "{} failing cases:\n{}", failures.len(), failures.join("\n"));
}
```

vitest:

```ts
const { cases } = JSON.parse(readFileSync("rules/tests/gate_guard.cases.json", "utf8"))

test.each(cases)("$name", (c) => {
  expect(runCase(env, c)).toEqual(expectedOf(c))
})
```

Run each engine's runner in its own CI job (`business-rules-ci`), so a missing engine shows as a failed job.
