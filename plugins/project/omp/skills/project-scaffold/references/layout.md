---
name: layout
---
# Standard layout

Baseline every project gets, then a sketch per project type. Top-level placement rules are
`architecture-top-level`; docs files are `architecture-docs-files`. Adapt names; keep the
intent.

## Baseline tree

```text
README.md              name, one-line purpose, install, usage, license pointer
LICENSE                unless the project is unpublished (license-picker; "none" is allowed)
CODEOWNERS             `* @owner` (ask for the owner or team)
SECURITY.md            private vulnerability reporting: forge mechanism or a contact
CONTRIBUTING.md        PR expectations, verification command, no credentials in commits
CODE_OF_CONDUCT.md     only when there is a working reporting contact; otherwise omit
AGENTS.md              commands, layout pointers into docs/, project rules; short
.editorconfig  .gitattributes  .gitignore
mise.toml              pinned runtimes and every tool a gate invokes (or .mise/conf.d/<layer>.toml)
justfile               task surface (references/justfile.md)
.pre-commit-config.yaml   prek/pre-commit hooks (references/ci-hooks.md)
scripts/               small project scripts the hooks and tasks call
docs/
  architecture.md      system shape, boundaries, flows
  stack.md             languages, package manager, frameworks, quality tools, with versions
  engineering.md       agent-readable stack/toolchain versions, layout and dependency direction,
                       standards, build/test/lint, release and environment variable names
  operations.md        optional: hosting, secrets handling, monitoring, runbooks
  product.md            optional: user and domain behaviour not owned by a spec
  adr/                 optional: durable decisions
.github/               pull request and issue templates, workflows
```

- ADRs: use `quality-code-design`'s `references/lifecycle.md` when a durable decision is made.
- `docs/engineering.md` names environment variables, never values (secrets: `project-secrets`).
- Place agent instructions where each agent reads them: `AGENTS.md` for OMP and other agents
  that follow that convention; add files for other hosts only when needed.
- Issue and PR templates ask for a summary, reproduction (member path, command, inputs), expected
  versus actual, environment (commit, runtime, tool versions), verification (ran the command,
  recorded result, no credentials), and compatibility notes.

## `.editorconfig`

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.{py,rs}]
indent_size = 4

[Makefile]
indent_style = tab
```

## TypeScript project reference layout

For a references project, TypeScript compiler options can live in an unreferenced
`tsconfig.options.json`; the build project references member configs:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/api" }
  ]
}
```

Each build package uses `composite: true`, `declaration: true`, `declarationMap: true`, and
`incremental: true`; keep generated output out of version control unless the project publishes
it. Use a `tsconfig.json` that is a check or a build project consistently across scripts and CI.

## Polyglot layouts

Each language-owned toolchain lives in its package or workspace member. Keep top-level assets
that coordinate all packages at the repository root: the task runner, lockfiles, CI, docs,
formatting, dependency-update policy, and tests crossing package boundaries. A language or
framework chooses its own configuration where the corresponding skill documents it.
