---
name: business-rules-ci
description: "Use to set up CI for CEL rules: environment drift, the reference checker, bundle digests, per-engine suites and engine pins."
metadata:
  opencode/autoinvoke: false
---

# CI for business rules

This skill lays out the CI jobs that enforce the `business-rules-cel` standard. The cases they run are in the
`business-rules-testing` skill. Workflow structure, action pinning and the single required gate follow the
`ci-github-actions` skill.

## The jobs

| Job | What it runs | Fails when | Rule |
| --- | --- | --- | --- |
| `environment` | Regenerate the descriptor set, the profile manifests and the environment files from the published JSON Schemas | `git status --porcelain -- <generated dirs>` is not empty, or the generator refuses a scope | G6, G7 |
| `check` | The reference checker over every rule file, then build the bundle and verify its digests | A descriptor set that does not match its manifest, any issue (printed as `file:line:col: message`), a wrong output type for a slot, a refused policy feature, or a digest that does not match | G1, P2, C1 |
| `engines` | The supported-profile suite on each selected engine, one matrix cell per engine, against the bundle from `check`, including the JCS vector | A case of the engine's role fails, the adapter does not reproduce the JCS vector, or the two checkers of record disagree on a standalone expression | G3 |
| `conformance` | cel-spec's simple tests on every engine, compared with the committed failure baseline | An engine has no results, or its failure set changed | G3, G4 |
| `authoring-tests` | `cel-expr eval -tests` over the typed test cases, with a verified `cel-expr` release | A case fails. Coverage is report-only: the recipe fails only on the CLI's exit status, which a failing case sets, and no step compares coverage with a threshold | G8 (the CLI reads the generated environment) |
| `ci-gate` | The one required check, over every job above | Any job failed | |

Notes on each job:

- **environment.** The generator writes everything from the schemas: the `.proto` files, the FileDescriptorSet
  (`buf build --exclude-source-info`), one `<scope>.profile.json` per scope, and the JSON environment for
  `cel-expr`. The drift check covers new untracked files too, which `git diff --exit-code` misses.
- **check.** The reference checker prints every issue in every file, then exits non-zero if there was any. Each
  issue carries the file, line and column, and the host adds the rule's path in its file (for example
  `flow.yaml#/gates/review/requires/0`).
- **bundle digests.** The checker's bytes are not reproducible: a re-check writes new bytes for the same rule.
  So never compare a bundle's bytes with a rebuilt one. Verify instead:
  - the bundle's profile digest equals the JCS digest of the current manifest;
  - the checker is one of the manifest's checkers of record;
  - each payload's SHA-256 matches its bytes;
  - each source's SHA-256 matches the current rule file;
  - every rule file has an entry.

  When the project commits the bundle, this check fails on a stale or missing entry, and the error names the
  command that rebuilds it. When CI builds the bundle, upload it as an artifact for the `engines` job.
- **engines.** Each engine reads the same case files and the same bundle. The suite runs on every engine the
  project selected, each in its own cell, so a missing engine shows as a failed job. Only the standalone
  expressions go through both checkers of record. A policy file is compiled once, by the reference checker in
  `check`, and the engines evaluate its `CheckedExpr` from the bundle.
- **conformance.** The scores are diagnostic. The job fails only on a missing engine or a changed failure set.
  Update the baseline on purpose, in its own commit, with the reason.
- **cost.** When the project reports cel-go's static cost estimate, print it in the `check` job and label it an
  estimate unless G5's two conditions hold.

## Locally and in CI

The same `just` recipes run on a laptop and in CI. A laptop runs the fast steps for the work at hand, and CI runs
all of them on every pull request.

| Step | On a laptop | In CI |
| --- | --- | --- |
| Regenerate the environment | `just rules-gen` after a schema change, and commit the output with it | `rules-drift` fails on any difference |
| Check the rules | `just rules-check` before each commit that touches a rule | The `check` job |
| Build and verify the bundle | `just rules-bundle` when the project commits the bundle | The `check` job, which uploads it |
| The supported-profile suite | The host engine's runner, such as `just rules-suite python` | Every selected engine, one matrix cell each |
| Conformance | On an engine bump, to see the new failure set before the pull request | Every pull request |
| Authoring tests | `cel-expr eval` and the MCP server while writing a rule (`business-rules-cel-authoring`) | The `authoring-tests` job |
| Install `cel-expr` | The `install-cel-expr` recipe, one time | The same recipe, on every run |

A user who writes rules for a project that ships a rules compile command runs that command. It is the same
reference checker, at the same pinned version.

## Pinning and engine bumps

- Pin every engine exactly: `go.mod` (cel-go and its policy module), `uv.lock` (`cel-expr-python`), `Cargo.lock`
  with `=` requirements (cel-core), and the JS lockfile (`@bufbuild/cel`). Pin the tools in `mise.toml`.
- The manifest's `checkers_of_record` names the checker versions. A bump of a checker of record changes the
  manifest, so the profile digest changes and every bundle entry becomes stale. The bump's pull request
  regenerates the environment and rebuilds the bundle.
- A bump of any engine reruns `engines` and `conformance` in its own pull request, because they run on every
  pull request. A changed failure set fails `conformance` until a reviewed baseline update lands with the bump.
- Let one updater own the pins (Renovate or Dependabot), with a cooldown, as `ci-github-actions` says.
- Install `cel-expr` only from a release whose checksum, signature and provenance you verify. Never run
  `go install …@latest` in CI.

## mise and just

`mise.toml` pins the toolchain, and the `justfile` holds one recipe per CI step, so CI and a laptop run the same
commands. The versions are the ones current in 2026-11. Replace them with the project's own pins.

```toml
[tools]
go = "1.27.4"
uv = "0.13.10"
rust = "1.100.0"
node = "26.13.1"
buf = "1.75.0"
cosign = "3.1.6"
slsa-verifier = "2.7.1"
just = "1.59.0"
```

```just
set shell := ["bash", "-euo", "pipefail", "-c"]

cel_expr_version := "0.4.0"
generated := "rules/generated"

# Regenerate the descriptor set, the profile manifests and the cel-expr environments from the schemas.
rules-gen:
    uv run python tools/rules_gen.py schemas/ rules/scopes.yaml --out {{generated}}
    buf build {{generated}}/proto --exclude-source-info -o {{generated}}/types.binpb

# Fail when the generated environment differs from the committed one.
rules-drift: rules-gen
    test -z "$(git status --porcelain -- {{generated}})" || { git status --porcelain -- {{generated}}; exit 1; }

# Check every rule file with the pinned reference checker; prints file:line:col for each issue.
rules-check:
    go run ./tools/celcheck check --generated {{generated}} rules/

# Write the bundle, then verify its profile digest, checker, payloads and sources.
rules-bundle:
    go run ./tools/celcheck bundle --generated {{generated}} --out {{generated}}/bundle rules/
    go run ./tools/celcheck verify --generated {{generated}} --sources rules/ {{generated}}/bundle

# Run the supported-profile suite on one engine: go, python, rust or typescript.
rules-suite engine:
    case "{{engine}}" in \
      go) go test ./rules/... ;; \
      python) uv run pytest tests/rules ;; \
      rust) cargo test -p rules-cel ;; \
      typescript) pnpm vitest run rules ;; \
      *) echo "unknown engine {{engine}}"; exit 2 ;; \
    esac

# cel-spec simple tests on every engine, against the committed failure baseline.
rules-conformance:
    rules/conformance/run.sh

# Download cel-expr and verify its checksum, cosign signature and SLSA provenance before installing it.
install-cel-expr:
    #!/usr/bin/env bash
    set -euo pipefail
    v="{{cel_expr_version}}"; asset="cel-expr_${v}_linux_amd64.tar.gz"
    dir="$(mktemp -d)"; cd "$dir"
    base="https://github.com/cel-expr/skills/releases/download/v${v}"
    for f in "$asset" checksums.txt checksums.txt.sig checksums.txt.pem multiple.intoto.jsonl; do
      curl -fsSLO "$base/$f"
    done
    cosign verify-blob checksums.txt --signature checksums.txt.sig --certificate checksums.txt.pem \
      --certificate-identity "https://github.com/cel-expr/skills/.github/workflows/release.yml@refs/tags/v${v}" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com
    grep " ${asset}\$" checksums.txt | sha256sum -c -
    slsa-verifier verify-artifact "$asset" --provenance-path multiple.intoto.jsonl \
      --source-uri github.com/cel-expr/skills --source-tag "v${v}"
    tar -xzf "$asset" && install -m 0755 cel-expr "$HOME/.local/bin/cel-expr"

# Typed test cases against the generated environment. The CLI prints coverage; nothing here enforces a threshold.
# Layout: rules/<scope>/<rule>.cel, with its cases in rules/tests/cli/<scope>/<rule>.tests.json.
rules-cli-tests:
    #!/usr/bin/env bash
    set -euo pipefail
    for t in rules/tests/cli/*/*.tests.json; do
      scope="$(basename "$(dirname "$t")")"; rule="$(basename "$t" .tests.json)"
      cel-expr eval -env "{{generated}}/env/${scope}.env.json" -fds {{generated}}/types.binpb \
        -expr "rules/${scope}/${rule}.cel" -tests "$t"
    done
```

`tools/rules_gen.py` and `tools/celcheck` stand for the project's own generator and reference checker
(`business-rules-cel`, and its `go.md` reference). The `install-cel-expr` commands follow the signing steps of the
`v0.4.0` release workflow. The checksum line format and the archive layout (`./cel-expr` at the top level) were
checked on the Linux x86-64 archive in 2026-11. The signature and provenance commands were not run, so run the
recipe once by hand before CI depends on it. The recipe fetches the Linux x86-64 archive for CI runners; on macOS,
pick the `darwin` asset and use `shasum -a 256 -c` in place of `sha256sum -c`.

## GitHub Actions

```yaml
name: rules
on:
  pull_request:
  push:
    branches: [main]
  merge_group:
permissions:
  contents: read
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  environment:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: jdx/mise-action@924e7c586e33d7d4bae9c14e26c5d22e2beb6e78 # v5.3.0
      - run: just rules-drift

  check:
    needs: environment
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: jdx/mise-action@924e7c586e33d7d4bae9c14e26c5d22e2beb6e78 # v5.3.0
      - run: just rules-check
      - run: just rules-bundle
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: rules-bundle
          path: rules/generated/bundle/

  engines:
    needs: check
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        engine: [go, python, rust, typescript]
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: jdx/mise-action@924e7c586e33d7d4bae9c14e26c5d22e2beb6e78 # v5.3.0
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with:
          name: rules-bundle
          path: rules/generated/bundle/
      - run: just rules-suite ${{ matrix.engine }}

  conformance:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: jdx/mise-action@924e7c586e33d7d4bae9c14e26c5d22e2beb6e78 # v5.3.0
      - run: just rules-conformance

  authoring-tests:
    needs: environment
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: jdx/mise-action@924e7c586e33d7d4bae9c14e26c5d22e2beb6e78 # v5.3.0
      - run: just install-cel-expr
      - run: just rules-cli-tests

  ci-gate:
    if: always()
    needs: [environment, check, engines, conformance, authoring-tests]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: re-actors/alls-green@b5b5b37504aa4183270bd3d855c52a67f212be35 # v1.3.0
        with:
          jobs: ${{ toJSON(needs) }}
```

- The SHAs are the versions current in 2026-11. Let the project's updater move them, and run `pinact run --check`,
  `actionlint` and `zizmor` on the workflow.
- The trigger has no `paths:` filter, because `ci-gate` is a required check. To skip rule jobs on unrelated
  changes, use a `dorny/paths-filter` job and list the skipped jobs in `allowed-skips`.
- When the rules job lives in a workflow that already has a `ci-gate`, add these jobs to that gate instead of a
  second one.
