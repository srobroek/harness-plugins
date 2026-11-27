# Go

Versions are the ones the spike pinned and tested, as of 2026-11. Keep them in one `go.mod` that builds both the
reference checker and the conformance oracle (G4), and rerun the supported-profile suite on every bump.

| Module or tool | Version (2026-11) | Role |
| --- | --- | --- |
| `cel.dev/cel-go` | `v0.33.4` | Reference checker and conformance oracle |
| `cel.dev/cel-go/policy` | `v0.33.3` | cel-policy parser and compiler; resolves against cel-go `v0.33.4` |
| `cel.dev/cel-go/tools` | `v0.33.3` | Not the checker (see `tools/compiler` below) |
| `google.golang.org/protobuf` | `v1.36.10` | `protojson` for activations, `anypb` for the bundle |
| `cel-expr` CLI (`github.com/cel-expr/skills`) | `v0.4.0` release | Authoring and `cel-expr eval -tests`; not the CI checker |

cel-go moved to the module path `cel.dev/cel-go`. From 2026-09-08, `github.com/google/cel-go/tools/compiler` holds
only aliases. Import the `cel.dev` paths.

## The reference checker

Write a small program, for example `celcheck`, that builds cel-go's environment from the profile manifest with
explicit options and appends nothing. First hash the descriptor-set bytes it read, and exit non-zero when the
SHA-256 differs from the manifest's `descriptor_set.sha256`. Then build the environment:

```go
conf := &env.Config{Name: m.Name, Container: m.Container}
for _, v := range m.Variables {
    conf.Variables = append(conf.Variables, env.NewVariable(v.Name, env.NewTypeDesc(v.Type)))
}
for _, e := range m.Extensions {
    conf.Extensions = append(conf.Extensions, &env.Extension{Name: e.Name, Version: strconv.Itoa(e.Version)})
}
opts := []cel.EnvOption{
    cel.TypeDescs(fds), // the FileDescriptorSet, after its SHA-256 matched the manifest
    cel.FromConfig(conf, ext.ExtensionOptionFactory),
    cel.CrossTypeNumericComparisons(m.Options.CrossTypeNumericComparisons),
}
if m.Options.HomogeneousAggregateLiterals {
    opts = append(opts, cel.HomogeneousAggregateLiterals())
}
e, err := cel.NewEnv(opts...)
```

- **Keep your own extension inventory.** cel-go's extension factory passes any numeric version through without
  checking that it exists (`ext/extension_option_factory.go`). The adapter refuses a version outside its list.
  The versions that the spike tested are strings 4, optional 2, bindings 0 and 1, math 1 and encoders 0. Add a
  test that loads strings version 99 and expects a refusal (G4).
- **Check.** `ast, iss := e.Compile(src)`. Print every issue with its file, line and column, and exit non-zero.
  Compare `ast.OutputType()` with the slot's type (G1).
- **Evaluate.** `out, _, err := prg.Eval(activation)` returns a non-nil `err` when the rule fails to evaluate.
  The adapter turns it into an `EvalError` value (`business-rules-code`).
- **Write the CheckedExpr.** Marshal `anypb.New(cel.AstToCheckedExpr(ast))` with `proto.Marshal`, write the bytes,
  and hash those exact bytes into the bundle entry (P2). Two runs write different bytes for the same rule, so
  never compare encodings.
- **Cost.** cel-go has a static cost estimate, and a runtime cost limit (`cel.CostLimit` as a program option)
  that stops an evaluation. Label the static figure an estimate (G5). Strings version 4 has no cost model: cost
  support starts at version 5.

The spike's reference checker rejected 7 of 7 bad rules and refused 6 of 6 features that the profile excludes,
while the 3 enabled ones checked.

## Do not use `tools/compiler` as an exact-profile checker

`cel.dev/cel-go/tools/compiler` reads an environment file and a descriptor set, but:

- `NewCompiler` always appends the latest `optional` and `bindings` extensions (`compiler.go`, `extensionOpt`),
  whatever the environment file says. In the spike, `part.?mass_target.hasValue()` and `cel.bind(x, 1, x == 1)`
  checked against a profile that listed strings only. A rule that passes it can then fail in @bufbuild/cel.
- `TypeDescriptorSetFile(path)` infers the format from the extension and takes `.binarypb`, `.fds` or `.pb`. A
  `buf build` output named `.binpb` has to be copied under another name.

## cel-policy

- Parse and compile: `parsed, iss := parser.Parse(policy.ByteSource(src, path))` with a parser from
  `policy.NewParser()`, then `ast, iss := policy.Compile(e, parsed)`. The result is one checked AST for the whole
  list, written to the bundle like any other rule.
- Refuse the excluded features before `policy.Compile` runs (C1): `variables`, `aggregate`, a nested `rule`,
  `explanation`, `imports`, a non-final choice with no `condition`, and a final choice with one. The compiler
  alone accepts `aggregate`, `variables` and a `match` with no unconditional final choice.
- After `policy.Compile`, compare `ast.OutputType()` with the slot type that the rule-list contract declares for
  the list's kind, and refuse a list whose type differs. The compiler checks only that the choices agree with
  each other, and a `dyn` output agrees with anything.
- Errors carry the `.celpolicy` file, line and column.

## The cel-expr CLI

`cel-expr` comes from `github.com/cel-expr/skills` (Apache-2.0). It is a cel-go CLI with the subcommands
`cel-expr env`, `cel-expr compile`, `cel-expr eval`, `cel-expr prompt` and `cel-expr mcp`.

| | `v0.4.0` release (2026-08-27) | main (unreleased) |
| --- | --- | --- |
| Signed checksums (cosign) and SLSA provenance | Yes | Not applicable |
| `-format policy`, `-proto_db`, `conformance` | No | Yes |
| Typed checks with `-fds` | 6 of 6 good rules compiled, 7 of 7 bad rules rejected | The same |

- **Install only a verified release.** Download the archive, `checksums.txt` with its cosign signature
  (`checksums.txt.sig` and `checksums.txt.pem`, or `checksums.txt.bundle`), and `multiple.intoto.jsonl` from the
  release. The release workflow writes both signature forms. Verify the checksum, the cosign signature and the
  SLSA provenance before you run the binary. `business-rules-ci` has the commands. Never install it with
  `go install …@latest`.
- **No policy support in the release.** `v0.4.0` has no `-format policy`. Until a signed release has it, check
  and test policies with the reference checker and the policy test cases, not with the CLI.
- **Environment.** It reads JSON only; YAML fails with a JSON parse error. The layout is cel-go's `env.Config`,
  but each variable has a `type` string (`list<string>`, a message name) where cel-go has `type_name` and
  `params`. Have the generator write this form too, or convert it with a small pinned script.
- **Types.** `-fds` takes a binary FileDescriptorSet. `-proto_db` is a boolean, not a path: it reads the
  descriptors compiled into the binary. A project with generated types does not need it.
- **Output.** `cel-expr compile` prints a JSON Schema of the fields a rule reads and of its output type. It writes
  **no CheckedExpr**, so it cannot be the CI checker. Its `inputSchema` has a bug: after `has(part.mass_target)` it
  reports the field as `boolean` where the field is a `double`.
- **Tests.** `cel-expr eval -tests <file>` runs JSON test cases, prints pass or fail per case with node and branch
  coverage, and exits 1 when a case fails.
- **Errors.** cel-go's text, for example
  `ERROR: <input>:1:17: found no matching overload for '_==_' applied to '(string, int)'`, then the source line and
  a caret.

Use the CLI beside the reference checker, for authors and for typed test cases with coverage.
