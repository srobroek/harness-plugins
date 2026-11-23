---
name: lang-go-quality
description: Use to run Go build, format, lint, vet, go mod tidy, govulncheck and go test -race checks with the project toolchain.
---
# Go Quality

Sources: `go help build`, `go help testflag`, `go help mod tidy`, `go help packages` (Go 1.27), [golangci-lint v2](https://golangci-lint.run/docs/), [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck), [race detector](https://go.dev/doc/articles/race_detector).

Run checks from the module root (the directory with `go.mod`) in this order. Stop at the first
failure, fix it, rerun that step, then continue; later steps on code that does not build add noise.

| Step | Command |
|---|---|
| Build | `go build ./...` |
| Format check | `golangci-lint fmt --diff` when `.golangci.yml` enables formatters; otherwise `gofmt -l .` (any output fails) |
| Lint | `golangci-lint run` when configured; otherwise `go vet ./...` |
| Test | `go test -race ./...` |
| Module tidy | `go mod tidy -diff` |
| Vulnerabilities | `go tool govulncheck ./...` when configured in `go.mod` |
| Format fix | `golangci-lint fmt`, or `gofmt -w .` when requested |
| API break (libraries) | `go tool go-apidiff <base-ref>` on PRs and at release |
| Docs | `go doc ./...`; lint doc comments through golangci-lint (`revive` `exported`, `godoclint`) |
| Dead code (executables) | `go tool deadcode -test ./...` |

The scaffold's golangci-lint v2 config includes `errcheck`, `govet`, `ineffassign`, `staticcheck`,
`unused`, and explicitly enabled `gosec`; `go vet` alone is not that gate. Enable `gocognit` at
15 and `gocyclo` at 10-12, ratcheting reviewed exceptions. `go tool deadcode -test ./...` reports
reachability from executable and test roots, unlike declaration-level checks. Do not treat it as
proof that a library's public API is safe to remove.

- After an edit that spans files or packages or changes a signature, run `go vet ./...` and
  `go build ./...` once, or the project's own target.
- Respect the project's formatter. When `.golangci.yml` enables `gofumpt`, `goimports`, or `gci`,
  a `gofmt`-only check passes code CI rejects. With plain `gofmt`, do not reformat with `gofumpt`.
- `-race` is the default for tests. It finds data races only on tested paths, and costs roughly
  2-20× time and 5-10× memory. It needs cgo on Linux (`CGO_ENABLED=1` and a C compiler). If it
  cannot run, use `go test ./...` and report `-race` as not run.
- Narrow to touched packages when the module is slow, and state that in the report.
- In a `go.work` workspace, `./...` from a root without `go.mod` matches nothing. Use the `work`
  pattern (Go 1.25+) or run per module with `go -C ./svc test ./...`. `go mod tidy` is per module.
- Never `go install …@latest` a tool inside a check. Use a `tool` directive in `go.mod` (Go 1.24+)
  or a `golangci-lint` binary on `PATH`. When a tool is missing, recommend the install command and
  ask first; report the step as not run if declined.
- Tool choices per concern, with minimum versions, are in `lang-go-libraries`'s
  `references/quality.md` and `references/testing.md`. For `cgo` code, `go test -asan` or `-msan`
  add memory checking beside `-race`.

## CI

Run the same steps in the same order, one job or step per row. Use `actions/setup-go` with
`go-version-file: go.mod` and the module cache enabled. Install golangci-lint with
`golangci/golangci-lint-action`, not `go install`. Workflow structure, the required `ci-gate` job,
and action pinning are in the `toolchain` plugin's `ci-github-actions` skill.

A missing `go.mod` or toolchain binary means that step did not run. Report it as not run, never
as a pass. Read failures as the project's actual toolchain output; do not invent extra linters.
