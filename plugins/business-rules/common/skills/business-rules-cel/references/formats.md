# Rule formats

This reference covers the files that hold rules and the files that carry them: rule lists, standalone expressions
in config, the profile manifest and the rules bundle. It also covers how each one is versioned, and how to write
CEL inside YAML. The rules themselves (G1 to G8, P1 to P4, C1) are in [SKILL.md](../SKILL.md).

## Rule lists: the restricted cel-policy profile

A rule list is a cel-policy file, `<name>.celpolicy`. C1 is the profile. A list in it looks like this:

```yaml
name: dispatch
rule:
  match:
    - condition: part.material == "steel"
      output: '"machining"'
    - condition: |-
        has(part.mass_target)
          && part.mass_target > 10.0
      output: '"heavy"'
    - output: '"unknown"'
```

- One `match` block, evaluated first-match. Each choice has an `output`. Every choice except the last has a
  `condition`, and the last has none.
- The compile step refuses every other field before the policy compiler runs: `variables`, `aggregate`, a nested
  `rule`, `explanation` and `imports` among them.
- The compiled list's result type must equal the slot type that the rule-list contract declares for its kind.
- An output is a CEL expression, so a string output carries CEL quotes inside YAML quotes: `'"unknown"'`.

## Standalone expressions in config

A standalone expression is one CEL string in a config field: a guard, a `when`, a `requires` or a selector.

- The config's contract names each expression field's scope and output type. The config file is validated against
  its JSON Schema first. A field that YAML read as a boolean or a number then fails validation with its path.
- A checker of record checks every expression at load, against its scope's manifest. It returns all issues at
  once. Each issue has:
  - the expression's path in its file as a JSON Pointer, such as `flow.yaml#/gates/review/requires/0`;
  - the line and column in the file;
  - the source line and a caret.
- It also checks the expression's output type against the slot, for example `bool` for a guard.
- An expression that the host checks and evaluates itself does not enter the bundle. An expression that another
  process or language evaluates crosses that boundary as a bundle entry, like a rule list (P2).
- Map the checker's line and column back to the file. Use a YAML parser that keeps node positions:
  - Python: ruamel.yaml's round-trip loader (`.lc.line`, `.lc.col`, `lc.value(key)`);
  - Go: `gopkg.in/yaml.v3` `yaml.Node` (`Line`, `Column`);
  - TypeScript: the `yaml` package's `parseDocument`, with a `LineCounter` for the node ranges.

  For a block scalar, the expression's first line is the line after the key. For a quoted scalar, add one column
  for the opening quote.

## YAML hygiene

CEL syntax collides with YAML syntax. Write each expression as a literal block scalar (`|-`) or as a single-quoted
scalar. A plain scalar breaks in these cases:

| Expression | What YAML does with it as a plain scalar |
| --- | --- |
| `!has(x.f)` | `!` starts a tag. PyYAML's `safe_load` fails, and ruamel.yaml's round-trip loader reads an empty tagged value without an error. |
| `[1, 2].exists(n, n > x)` or `{"a": 1}.size() > 0` | `[` and `{` start a flow collection. |
| `a ? b : c` | `: ` inside a plain scalar in a mapping is a syntax error. |
| `x > 1 # note` | ` #` starts a comment, so YAML drops `# note`. CEL comments are `//`. |
| `output: "unknown"` | YAML removes the quotes, so CEL reads an undeclared identifier `unknown`. Write `'"unknown"'`. |

- Prefer `|-` over `>-` for an expression on several lines. A folded scalar joins the lines, so an issue's line
  number no longer points at the line in the file.
- Refuse duplicate keys. PyYAML's `safe_load` keeps the last value without an error. ruamel.yaml, `yaml.v3` and
  the `yaml` package report duplicates by default. Check the parser you use with a fixture.
- A YAML 1.1 parser, such as PyYAML, reads unquoted `yes`, `no`, `on` and `off` as booleans. Validation against
  the schema catches it in an expression field. Quote enum values in config anyway.
- Do not use anchors, aliases or merge keys (`<<`) in rule files. They make the rule that runs differ from the
  text that a reviewer reads, and `<<` exists only in YAML 1.1.
- Load with a safe loader that builds no objects from tags: `yaml.safe_load` or ruamel.yaml's `typ="safe"` or
  round-trip loader, never `yaml.load` with the full loader.

## The profile manifest

One manifest per scope, `<scope>.profile.json`, written by the generator. Its fields are in step 4 of the
pipeline in [SKILL.md](../SKILL.md). An example, with a shortened hash:

```json
{
  "checkers_of_record": [{"engine": "cel-go", "tool": "celcheck", "tool_version": "1.0.0", "version": "v0.33.4"}],
  "container": "",
  "descriptor_set": {"file": "types.binpb", "sha256": "9f2c…"},
  "extensions": [{"name": "strings", "version": 4}],
  "manifest_version": 1,
  "options": {"cross_type_numeric_comparisons": false, "homogeneous_aggregate_literals": false},
  "variables": [{"name": "decision", "type": "record.GateDecision"}]
}
```

The profile digest is the SHA-256 of its RFC 8785 canonical bytes (pipeline step 5).

## The rules bundle

The bundle is a contract like every other shape: define it in TypeSpec, and publish its JSON Schema. The field
names below are an example. The content is what P2 requires.

```json
{
  "bundle_version": 1,
  "profile_digest": "sha256:4b1e…",
  "checker": {"engine": "cel-go", "version": "v0.33.4", "tool": "celcheck", "tool_version": "1.0.0"},
  "entries": [
    {
      "path": "rules/dispatch.celpolicy",
      "slot": "dispatch",
      "output_type": "string",
      "source_sha256": "c03a…",
      "payload_sha256": "77d0…",
      "payload": "<base64 of a google.protobuf.Any holding a cel.expr.CheckedExpr>"
    }
  ]
}
```

- Hash the payload's exact bytes, as the checker wrote them. When the payload is base64 in JSON, hash the decoded
  bytes.
- Keep the bundle next to the sources it covers, or build it in CI and pass it to the evaluators as an artifact
  (`business-rules-ci`).
- The host checks it in the order of P2. A refusal names the file and the command that rebuilds the bundle.

## Versioning

Identity comes from digests. A version number names a layout.

- **`manifest_version` and `bundle_version`** change only when the file's layout changes. A reader refuses a
  version that it does not know.
- **The profile digest** changes whenever the manifest's content changes: a scope's variables, the types that a
  contract change alters, an extension version, an option or a checker of record. Every bundle entry in that
  profile is then stale. CI rebuilds the project's own bundles. A user rebuilds theirs with the project's rules
  compile command, which the refusal names.
- **Extension versions** are pinned in the manifest, in cel-go's numbering. Raising one is a profile change. Run
  the effective-environment cases on every engine before it lands (`business-rules-testing`).
- **Engine versions** are pinned in the lockfiles. A bump of a checker of record changes `checkers_of_record`, and
  so the digest. A bump of an evaluator reruns the suites and the conformance baseline (`business-rules-ci`).
- **Rule files** carry no version field. Git versions them, and each bundle entry's source SHA-256 ties a payload
  to the exact source.
