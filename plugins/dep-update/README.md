# dep-update

Classifies a project's dependency declarations by semver safety and applies patch
or minor bumps one at a time, each under your permission rules. It applies bumps for
PyPI and npm; for Rust and Go it only advises.

Ported from the omp-plugins `dep-update` plugin.

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/dep-update/opencode'
```

## Tools

| Tool | What it does |
| --- | --- |
| `dep_scan` | Reads root manifests and lockfiles, queries PyPI and npm, and classifies each exact-version bump as `PATCH-SAFE`, `MINOR-CHECK` or `MAJOR-ADVISORY`. Read-only. |
| `dep_apply` | Applies one bump through the project's package manager, then checks that the pin reached the manifest. |

`dep_scan` honours cancellation and stops after 5 minutes in total. A stopped scan
returns `complete: false` and marks every dependency it did not query `UNCHECKED`.
## pi

Load `plugins/dep-update/pi/extensions/index.js` as a pi extension. It registers `dep_scan` and `dep_apply` with the existing names and input schemas.

`dep_apply` asks `ctx.ui.confirm` to approve the exact bump. In print or JSON mode, where no UI is available, it refuses without changing files.

To load this extension in foreground pi-subagents, add its path to `subagents.defaultSubagentOnlyExtensions` or an agent's `subagentOnlyExtensions` setting.


## Permissions for a bump

`dep_apply` asks permission for action `dep_apply` with the resource
`<name>@<version>`, so a rule or prompt names the exact bump. By default your
permission rules decide: an allowed `dep_apply` runs without a prompt, so
unattended runs are not blocked. A deny or ask rule always wins.

- To block bumps, add a deny rule:
  `{ "action": "dep_apply", "resource": "*", "effect": "deny" }`.
- To prompt for every bump, add an ask rule, or set the plugin option `confirm`
  to `true` (default `false`). The plugin then turns an allowed `dep_apply` into
  `ask`, including one covered by an earlier "allow always".

A rejection with feedback, or a deny rule, comes back to the model as a tool error.
A plain rejection ends the step. The package manager stops after 10 minutes, after
64 KiB of output, or on cancellation. A stopped or failed run can leave partial
changes.

Python projects use `poetry add` when there is a `poetry.lock` or `[tool.poetry]`,
and `uv add` otherwise (`--frozen` when there is no `uv.lock`). A project with only
`requirements.txt` gets a manual instruction, and no install runs. Node projects pick
the package manager from `DEP_UPDATE_PKG_MANAGER`, or from the lockfile.

## Scanner-install advisory

After a `shell` call that installs a CVE scanner persistently (`pip-audit`,
`osv-scanner`, `cargo-audit`, `govulncheck` via `pip install`, `pipx install`,
`uv tool install`, `brew install`, a global npm/pnpm/bun/yarn install, `cargo install`
or `go install`), the plugin adds a note to the tool result. The note says the audit
changed the toolchain and lists the ephemeral runners to use instead. It does not
stop the command.

## Skill

The plugin registers the `dep-update` skill from `skills/dep-update/SKILL.md`, unless
a skill with that id already exists. The skill covers the scan, CVE scanners,
changelog citations and the one-bump-at-a-time apply loop.

## Coverage

The detector reads the root `package.json` (and `package-lock.json` for resolved
versions), `pyproject.toml` or `requirements.txt` (and `uv.lock` or `poetry.lock`),
`Cargo.toml`, `go.mod`, `Gemfile` and `composer.json`. It does not read
`Cargo.lock`, `go.sum`, `Pipfile.lock`, Ruby or PHP lockfiles, other Node lockfiles,
or workspace child manifests.

Classification needs exact versions. Ranges and wildcards are `UNRESOLVABLE` and are
never offered as upgrades. A prerelease is offered only when the installed version
is itself a prerelease.
