# project

Project lifecycle skills and one slash command: scaffolding a standard project and
picking a license.

| Skill | When |
| --- | --- |
| `project-scaffold` | A new project, "scaffold", "bootstrap", "init repo"; also run by `/new-project` |
| `license-picker` | "What license should I use", a new repository without one, relicensing, or a quick question about license mechanics, per-file headers or CLAs |

## `/new-project`

`/new-project [language or project name]` submits a prompt that loads the
`project-scaffold` skill with your arguments. The plugin registers it with
`ctx.command.transform`; the prompt text is the pure function `scaffoldPrompt`.

`project-scaffold` is instructions, not a generator. It interviews you (purpose,
languages, single package or monorepo, app/library/CLI/service, license, hosting and CI,
release flow, beads, speckit, secrets), then sets the project up with each language's own
tools: `references/rust.md`, `python.md`, `go.md`, `typescript.md` (apps and monorepos
through Better-T-Stack), `monorepo.md`. The standard layout (`layout.md`: baseline tree,
`.editorconfig`, `.gitattributes`, per-type sketches), suggested shapes from the old presets
(`shapes.md`), the governance, forge and defaults round (`governance.md`), optional capabilities
(`capabilities.md`: OpenAPI, i18n, accessibility, AWS CDK), the `justfile` surface, CI, hook
and release options (`justfile.md`, `ci-hooks.md`), Worktrunk setup (`worktrees.md`) and
existing-repository handling (`brownfield.md`) each have their own reference. It points at the `toolchain-*`, `lang-*`,
`architecture-docs-files` and `trunk-dev-*` skills for preferences instead of copying
them, and asks where those are silent. It also covers mise pinning, a `just check` gate,
`docs/` and `AGENTS.md`, project `opencode.jsonc`, hooks, a first commit and a
verification checklist. `references/plugins.md` shows how to list every plugin in this
repository (`find_tools_scan`, the GitHub API, the marketplace file) and add the relevant
ones to the project. The secrets step loads the `project-secrets` skill, which ships in its own
[project-secrets](https://github.com/srobroek/harness-plugins/tree/main/plugins/project-secrets)
plugin. Install that plugin next to this one for the step to find it.

## `license-picker`

`license-picker` asks structured questions about the project, the threat model and
commercial goals, recommends an OSI-approved license from its decision matrix,
checks it against ecosystem norms, and offers to write the LICENSE file, manifest
field and headers. Its references live beside it in `references/`.


## Install
Install the Pi package from npm:

```sh
pi install npm:@srobroek/pi-project
```

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/project/opencode'
```

Claude Code install the same skill from this repository's marketplace:

```sh
claude plugin marketplace add srobroek/harness-plugins
claude plugin install project@harness-plugins

```

A skill you already have with the same name wins over the plugin's copy.
