---
name: business-rules-guide
description: "Use for business rules, policies, guards, validation rules or expressions in config: where the logic lives, and which engine, if any."
---

# Business rules guide

A business rule is a condition or a choice that code applies to a record: a guard on a state transition, a policy,
a validation rule, a price or a route, or an expression that a config file holds. Decide first where the rule
lives. Then load the skill for that place.

Load the matching skill below with the skill tool, by id, in this same turn, and every other row the task spans.
Answer from the loaded skill, not from this table.

| Situation | Load skill |
| --- | --- |
| Coding a named guard, a rule table that code reads, or the adapter around a rule engine: checking before use, errors, explanations, one rule in one place | `business-rules-code` |
| Adopting CEL in a project: the type pipeline from TypeSpec, structural scopes, presence, rule formats, CheckedExpr bundles, cel-policy, tools, or the CEL package for a language | `business-rules-cel` |
| Writing or reviewing rule tests: case tables, the supported-profile suite per engine, presence, wrong-field, bundle and effective-environment cases | `business-rules-testing` |
| Setting up CI for rules: environment drift, the reference checker, bundle digests, per-engine suites, engine pins, what runs locally and what runs in CI | `business-rules-ci` |
| Writing or changing one CEL expression or `.celpolicy` against the generated environment | `business-rules-cel-authoring` |
| A CEL expression fails to compile or to evaluate | `business-rules-cel-debugging` |
| Raising one expression's node and branch coverage with the `cel-expr` CLI | `business-rules-cel-testing` |

## Where business logic lives

A rule can live in four places. They run from the cheapest to change with a code review to the cheapest to
change without a release.

| Place | What it is | Use it when |
| --- | --- | --- |
| Inline host code | A condition at its one call site | The rule has one call site, and a name would add nothing. |
| Named guard | A pure function with a domain name, such as `can_close_order(order)`, that returns the decision and its reason | Your own team writes and changes the rule. It ships with the code and reads in-process types. Several call sites use it, or an audit needs its name. |
| Data-driven rule | The rule's values or conditions are data: a parameter table that code reads, or an expression in a config file that an engine checks and then evaluates | One of the signs below holds. |
| Policy engine | A separate engine, often a service, that answers a request with a decision, such as OPA with Rego, or Cedar | Authorization or admission across many services, where that engine's language already fits the question (see Choose an engine). |

Two kinds of rule belong in none of these places:

- **A rule that only constrains a record's shape**, such as required fields, ranges, patterns or a closed set of
  values. Put it in the contract's JSON Schema, authored in TypeSpec (the `quality-code-design` skill's
  `contracts.md`).
- **A rule that needs I/O, state, side effects, or a loop over data without a size limit.** It is a program, so
  write it as host code.

A rule becomes data in two steps. Take the second only when the first is not enough:

1. **Values as data.** Move the thresholds, rates, lists and mappings into a file that is validated against a JSON
   Schema. The logic stays in a named guard that reads the file. This needs no expression language.
2. **Conditions as data.** When the conditions themselves change outside the code, they become expressions. Each
   one is checked against the published types before it runs. Use CEL, under the `business-rules-cel` standard.

## Signs that logic should become data

- People other than the code's authors write or change the rule: users, operators, analysts or policy providers.
- The rule changes on another schedule than the code, and each change now waits for a release.
- Each tenant, customer, region or project has its own variant, written as branches on a configuration value.
- An `if`/`elif` chain or a `switch` grows by one branch per case, and every branch has the same shape.
- Someone must list, review, version or explain the rule apart from the code: for an audit, or for a user who
  asks why.
- One rule must give the same answer in two languages or processes. Prefer one evaluator whose result the other
  side shows, such as a UI that shows the server's result. Give the rule to two engines only when the second side
  must decide by itself.

Signs that it should stay code:

- The rule has one author team and one runtime. A change to it is a code change with a review, so a typo fails the
  build.
- The rule reads in-process types that are not published.
- The rule needs I/O, state or an unbounded loop.
- The rule changes rarely, and only together with the code around it.

Rules as data have a cost: a schema, a generator, a checker, a test suite on each engine, and a CI job. The
`business-rules-cel`, `business-rules-testing` and `business-rules-ci` skills describe each part. Pay that cost
only when a sign above holds.

## Choose an engine

The rows other than CEL and plain code come from each project's upstream docs, read in 2026-11. No spike measured
them. The CEL row rests on an engine spike and a review of how Kubernetes uses CEL, both from 2026-11. The
`business-rules-cel` standard has that evidence.

| Option | Use it when | Not the default for business rules, because | Source |
| --- | --- | --- | --- |
| Plain code: a named guard | Your own team writes the rules (first table) | It is the default when no sign above holds. | |
| CEL | Conditions are data, checked against the published types before they run, possibly in several languages | It is the default for conditions as data. | <https://cel.dev/>, <https://github.com/google/cel-spec> |
| Rego (Open Policy Agent) | The organization already runs OPA for policy across services, over JSON input | Its schema type checking supports only part of JSON Schema. The docs list these as not supported: additional properties, pattern properties, additional items, `contains`, `oneOf`, `not`, `enum` and `if`/`then`/`else`. A schema given by reference is ignored unless the command passes `--schema`. | <https://www.openpolicyagent.org/docs/policy-language> (Schema annotations, Limitations) |
| Cedar | Authorization: may this principal take this action on this resource, in this context | Each policy permits or forbids a request, and the answer is Allow or Deny. A business rule that returns a value, such as a route or a list of checks, does not fit. | <https://docs.cedarpolicy.com/>, <https://docs.cedarpolicy.com/policies/syntax-policy.html> |
| JSONata | Querying or transforming JSON documents | It has no static type check against a schema. A path to a field that does not exist returns nothing, and the docs say no error occurs. | <https://docs.jsonata.org/overview>, <https://docs.jsonata.org/simple> |
| JSON Logic | Small rules serialized as JSON and shared between a front end and a back end, where no type check is needed | Rules are JSON trees that read data at run time, with no type declarations and no checker. `var` takes a default for a missing field, and `==` coerces types (`1 == "1"`). | <https://jsonlogic.com/>, <https://jsonlogic.com/operations.html> |
| expr-lang (Expr) | Dynamic configuration in a Go service, typed by Go types | It is an expression language for Go. Its types come from the Go types of the environment, and the project has no engine in another language. | <https://expr-lang.org/docs/getting-started>, <https://github.com/expr-lang/expr> |
| Starlark | Configuration that needs a small program, as in Bazel | It is a full language, a dialect of Python for configuration, with statements, functions and loops. Its spec declares no types for inputs, so it has no typed expression checking. Execution is finite, but the spec gives no cost estimate, which makes it hard to bound. | <https://github.com/bazelbuild/starlark/blob/master/spec.md> |

CEL's type checker checks a rule against declared types before the rule runs. CEL has engines for Go, C++ (and
Python through it), Rust and TypeScript. A checked rule, a `CheckedExpr`, moves between them as a protobuf message.
CEL is not Turing complete, and cel-go gives a static cost estimate. Kubernetes uses CEL for CRD validation rules
and admission policies.

## The worked example

The examples in these skills, such as `decision.status` and `part.mass_target`, come from benchhand's ADR-0020,
"The CEL rule pipeline". It applies the full standard as follows:

- the host is Python, so cel-expr-python checks the standalone expressions at load and evaluates every rule;
- a pinned cel-go tool compiles the rule lists in CI and in a `rules compile` command for users;
- the UI shows the results that the server computed, so there is no browser evaluator and no TypeScript engine.

A project takes the layers it needs. It drops the parts for engines it does not run.
