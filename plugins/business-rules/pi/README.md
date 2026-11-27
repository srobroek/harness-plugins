# business-rules

Skills for business rules: where a rule should live (a named guard in host code, CEL, or neither), and the
standard for a project that adopts CEL.

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

- `business-rules-guide`: when to use CEL, when a named guard in host code is enough, and when neither fits.
  It also says why Rego, Cedar, JSONata, JSON Logic, expr-lang and Starlark were ruled out.
- `business-rules-cel`: the CEL adoption standard in four layers. The general rules apply to every project. The
  protobuf portability profile covers rules that cross processes or languages. The engine and tooling choices
  are dated 2026-11, and the cel-policy profile covers rule lists. It also covers the pipeline from TypeSpec to
  a checked bundle, structural scopes and presence. `references/` has one file per language (Python, Go, Rust,
  TypeScript) with the packages to use and their gotchas, plus the gotchas for every engine.
- `business-rules-testing`: the rule test suite. It covers table-driven cases in one JSON file per scope and the
  supported-profile gate by engine role. It lists the cases every project needs: wrong fields per scope, presence,
  bundle tampering, the effective environment and policies. It shows how to run them under pytest, go test,
  cargo test and vitest.
