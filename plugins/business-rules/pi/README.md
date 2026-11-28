# business-rules

Skills for business rules in any project: where a rule should live (inline code, a named guard, a rule as data,
or a policy engine), how to code it, and the standard for a project that adopts CEL.

## Install

Install the Pi package from npm:

```sh
pi install npm:@srobroek/pi-business-rules
```

OpenCode:

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/business-rules/opencode'
```

Claude Code installs the same skills from this repository's marketplace:

```sh
claude plugin install business-rules@harness-plugins
```

## Skills

OpenCode lists only `business-rules-guide` to the model. The other skills set `opencode/autoinvoke: false`, and
the guide loads them by id. Claude Code ignores that metadata, so there every skill is listed.

The plugin registers these skills from `skills/`, unless a skill with the same id already exists:

- `business-rules-guide`: where business logic lives (inline code, named guards, data-driven rules or a policy
  engine), the signs that logic should become data, and a decision table over CEL, Rego, Cedar, JSONata, JSON
  Logic, expr-lang, Starlark and plain code, with upstream sources from 2026-11.
- `business-rules-code`: named guards, rule tables that code reads, and the adapter around a rule engine: one per
  runtime, checking before use, no silent pass, error values versus exceptions, explanations, and one rule in one
  place.
- `business-rules-cel`: the CEL adoption standard in four layers. The general rules apply to every project. The
  protobuf portability profile covers rules that cross processes or languages. The engine and tooling choices
  are dated 2026-11, and the cel-policy profile covers rule lists. It also covers the pipeline from TypeSpec to
  a checked bundle, structural scopes and presence. `references/` has one file per language (Python, Go, Rust,
  TypeScript) with the packages to use and their gotchas, the gotchas for every engine, the rule formats
  (cel-policy files, expressions in config, the bundle, versioning, YAML hygiene), and the tools.
- `business-rules-testing`: the rule test suite. It covers table-driven cases in one JSON file per scope and the
  supported-profile gate by engine role. It lists the cases every project needs: wrong fields per scope, presence,
  bundle tampering, the effective environment, descriptor-set bytes, the JCS vector, standalone expressions and
  policies. It shows how to run them under pytest, go test, cargo test and vitest.
- `business-rules-ci`: the CI jobs: environment drift, the reference checker over every rule file, bundle digest
  verification, the per-engine suites, conformance against a failure baseline, and engine pins with a rerun on
  each bump. It has a `mise.toml` and `justfile` layout, a table of what runs on a laptop and what runs in CI,
  and a GitHub Actions workflow with pinned actions.
- `business-rules-cel-authoring`, `business-rules-cel-debugging` and `business-rules-cel-testing`: write, fix and
  test one expression with the `cel-expr` CLI, against the project's generated environment. Each one stops when
  no generated environment covers the scope.

## Vendored skills

The three `business-rules-cel-*` skills are adapted from the `cel-authoring`, `cel-debugging` and `cel-testing`
skills of [cel-expr/skills](https://github.com/cel-expr/skills), at commit
`a41927f7d836d3e2eeec6c809b66fa444093427a`, under the Apache License 2.0. Each skill directory has a `NOTICE`
file with the upstream source and the list of changes. The main change replaces upstream's step that creates an
environment: these skills read the generated one. Of upstream's six skills, the plugin vendors these three.
`cel-optimize` would add Java to the toolchain, and `cel-conformance-testing` and `cel-doc-generator` serve the
authors of CEL engines.
