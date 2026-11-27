---
name: business-rules-guide
description: "Use for business rules, policies, guards, validation rules or expressions in config: CEL, host guards, or neither."
---

# Business rules guide

Decide first where a rule lives. A rule is a condition or a choice that the code applies to a record: a guard
on a transition, a policy, a validation rule, or an expression that a config file holds.

## Where a rule lives

| Situation | Where the rule lives |
| --- | --- |
| Only your own team writes and changes the rule. It ships with the code, and it reads in-process types. | A named guard in host code: a pure function with a domain name, such as `can_close_order(order)`, tested as code. |
| People other than the code's authors write rules: users, operators or policy providers. | CEL, under the `business-rules-cel` standard. |
| Rules change without a release of the code that runs them. | CEL, under the `business-rules-cel` standard. |
| One rule must give the same answer in two languages or processes. | CEL, with the protobuf portability profile of `business-rules-cel`. |
| The rule only constrains the shape of a record: required fields, ranges, patterns, a closed set of values. | Neither. Put it in the contract's JSON Schema, authored in TypeSpec (the `quality-code-design` skill's `contracts.md`). |
| The rule needs I/O, state, side effects, or a loop over data without a size limit. | Neither. It is a program: write it as host code. |

Signs that a named guard is enough:

- The rule has one author team and one runtime.
- A change to the rule is a code change with a review, so a typo fails the build.
- The rule reads in-process types that are not published.

Signs that CEL is the right choice:

- A rule file is data that someone edits outside the code base.
- A rule crosses a process or language boundary, for example a browser preview of a server-side rule.
- The project must check each rule against the published types before the rule runs.

## Why CEL, and the alternatives that were ruled out

CEL has a type checker that checks a rule against declared types before the rule runs. Its engines exist for Go,
C++ (and Python through it), Rust and TypeScript. A checked rule (a `CheckedExpr`) moves between them as a
protobuf message. CEL is not Turing complete, and cel-go gives a static cost estimate. Kubernetes uses it for
CRD validation rules and admission policies. The `business-rules-cel` standard has the measured evidence: an
engine spike from 2026-11.

The reasons below come from each project's upstream docs, read in 2026-11. No spike measured them.

| Alternative | Why it was ruled out | Source |
| --- | --- | --- |
| Rego (Open Policy Agent) | Its schema type checking supports only part of JSON Schema. The docs list these as not supported: additional properties, pattern properties, additional items, `contains`, `oneOf`, `not`, `enum` and `if`/`then`/`else`. A schema given by reference is ignored unless the command passes `--schema`. | <https://www.openpolicyagent.org/docs/policy-language> (Schema annotations, Limitations) |
| Cedar | It is a language for authorization policies only. Each policy permits or forbids a request of a principal, an action and a resource, and the answer is Allow or Deny. A business rule that returns a value, such as a route or a list of checks, does not fit. | <https://docs.cedarpolicy.com/>, <https://docs.cedarpolicy.com/policies/syntax-policy.html> |
| JSONata | It is a query and transformation language for JSON, with no static type check against a schema. A path to a field that does not exist returns nothing, and the docs say no error occurs. | <https://docs.jsonata.org/overview>, <https://docs.jsonata.org/simple> |
| JSON Logic | Rules are JSON trees that read data at run time, with no type declarations and no checker. `var` takes a default for a missing field, and `==` coerces types (`1 == "1"`). | <https://jsonlogic.com/>, <https://jsonlogic.com/operations.html> |
| expr-lang (Expr) | It is an expression language for Go. Its types come from the Go types of the environment, and the project has no engine in another language. | <https://expr-lang.org/docs/getting-started>, <https://github.com/expr-lang/expr> |
| Starlark | It is a full language, a dialect of Python for configuration, with statements, functions and loops. Its spec declares no types for inputs, so it has no typed expression checking. Execution is finite, but the spec gives no cost estimate, which makes it hard to bound. | <https://github.com/bazelbuild/starlark/blob/master/spec.md> |
| Named guards in host code | Not ruled out. They are the right choice when only your own team writes the rules (first table). | |
