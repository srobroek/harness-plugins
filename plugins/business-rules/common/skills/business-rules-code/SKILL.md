---
name: business-rules-code
description: "Use to code business rules in host code: named guards, rule tables, and the engine adapter: check first, no silent pass, errors, explanations."
metadata:
  opencode/autoinvoke: false
---

# Business rules in host code

This skill covers the code around a rule, wherever the rule lives: a named guard, a rule table that code reads, and
the adapter around a rule engine. The `business-rules-guide` skill says which place fits. The `business-rules-cel`
standard defines the adapter's five operations (P4). This skill says how to write them and the code that calls
them. The packages and gotchas for each language are in the `business-rules-cel` skill's references: `python.md`,
`go.md`, `rust.md`, `typescript.md` and `gotchas.md`.

## Named guards

- A guard is a pure function with a domain name, such as `can_close_order(order)`. It takes the records as
  arguments and does no I/O. Pass the time in as an argument (`now`). Never read the clock inside a guard.
- Return the decision with its reason when anyone will ask why, for example
  `Decision(allowed=False, rule="order.close.open_invoices", reason="2 invoices are open")`. A bare `bool` is
  enough only for a guard that nobody audits.
- Give the guard a third outcome when it can lack the data to decide: an explicit "unknown" or a typed error. For
  missing data it returns that outcome.
- Define each guard once. Every call site calls it. Another layer that needs the answer, such as a UI, shows the
  result that the owner computed or calls the same function through an API. It does not re-implement the guard.
- Test a guard as code, with a table of cases over each boundary (the `quality-testing` skill).

## Rule tables read by code

A rule table holds the values of a rule as data: thresholds, rates, lists or mappings. The logic stays in a named
guard that reads the table.

- Keep the table in a file with a JSON Schema, authored in TypeSpec like every other contract. Validate it at
  load. Refuse the whole table when any row is invalid, and report every issue with its path.
- Give the table a closed set of columns. When a column starts to hold operators (`">="`) or field names, the table
  has become an expression language. Move the conditions to CEL under the `business-rules-cel` standard instead of
  growing an interpreter.
- Decide how rows combine: the first match wins, or exactly one row must match. Test for overlapping rows and for
  gaps. A "no match" is an explicit default row or an error, never an implied pass.
- Load the table once, at startup or on a change, not on each call.

## The engine adapter

### One adapter per runtime

- All calls to a rule engine go through one adapter module per runtime, with P4's five operations: `load`,
  `check`, `program`, `eval` and `identity`. No other module imports the engine.
- Only the adapter knows the engine's API, its options and its error forms. A change of engine changes that one
  module.
- Two runtimes have two adapters, for example a Python host and a Go checking tool in CI. Both run the same case
  files (`business-rules-testing`).

### Check before use

At load, in this order, the adapter:

1. hashes the descriptor-set bytes it read, and refuses them when the SHA-256 differs from the manifest's;
2. builds the environment from the profile manifest, and refuses an extension version outside its own inventory
   or an option it cannot set;
3. checks every standalone expression and collects every issue: its path in its file, line, column and a caret;
4. checks the output type of each expression against its slot, for example `bool` for a guard;
5. verifies each bundle: the profile digest, the checker of record, each payload's SHA-256 and each source's
   SHA-256 (`business-rules-cel`, P2).

A refusal stops the load. It names the file and the command that fixes it, such as the project's rules compile
command. Never check a rule lazily, at its first evaluation.

### No silent pass

- An evaluation has three outcomes: a value, a different value, or "unknown" because the rule failed to evaluate.
  Make the result type force the caller to handle "unknown", for example a `Value | EvalError` union that the
  caller matches on.
- A gate whose rule is "unknown" does not pass. Record a finding with an unknown result.
- A slot with no rule fails the load. A slot that may be empty says so in its contract.
- Never wrap an evaluation in a catch-all that turns an exception into `true` or `false`.

### Error values versus exceptions

- CEL reports an evaluation error as a value. cel-expr-python returns a value whose type is `ERROR`.
  cel-go's `Program.Eval` returns a non-nil `error`. For cel-core and @bufbuild/cel, pin the form with an adapter
  test, because the spike did not record it.
- The adapter turns each engine's form into one form at its edge:
  - load and check failures become a list of issues, each with its path, line and column;
  - evaluation failures become `EvalError` values;
  - exceptions and panics are left for bugs in the host.
- `&&` and `||` absorb an error when the other operand decides the result, so `false && 1 / 0 == 1` is `false`
  (`gotchas.md`). An error can vanish inside a rule, so test the slots, not just the operators.
- Test it with one case per slot whose activation makes the rule fail to evaluate, which expects "unknown".

### Explanations

- For each evaluation, record:
  - the rule's path in its file;
  - the profile digest and the entry's source SHA-256;
  - the variables it read;
  - the result or the error.

  Record field paths, not whole records, when a record holds personal or secret data.
- The restricted cel-policy profile excludes `explanation`. When a reader must know which choice of a rule list
  matched, make the output say it: give each choice a distinct output, or an output type with a reason code.
- Show a user the rule's path and the reason, not the CEL source alone.

### No duplicated logic

- A rule lives in one place: in its rule file or in a named guard, never in both. Code that needs a CEL rule's
  answer calls the adapter, also when it wants speed, a fallback or a preview.
- The restricted profile has no `variables`, so a sub-expression that several conditions share is repeated in each
  one. Keep that repetition inside the rule file. Do not move it to a host-code copy.
- Values that code and rules both use, such as enum values, come from the schema. Do not copy them as literals.
  The enum lint (G1) compares a rule's string literals with the schema's enum.

## Per language

| Language | Checker and evaluator | Reference |
| --- | --- | --- |
| Python | cel-expr-python: checks standalone expressions at load and evaluates bundles | `business-rules-cel` `python.md` |
| Go | cel-go: the reference checker, the policy compiler and an evaluator | `business-rules-cel` `go.md` |
| Rust | cel-core: evaluates reference-checked bundles; cel-cxx checks source only | `business-rules-cel` `rust.md` |
| TypeScript | @bufbuild/cel: evaluates reference-checked bundles in the restricted profile | `business-rules-cel` `typescript.md` |

The rule tests and the adapter tests are in `business-rules-testing`, and the CI jobs are in `business-rules-ci`.
