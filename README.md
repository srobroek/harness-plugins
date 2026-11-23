# harness-plugins

Agent plugins by Sjors Robroek for OpenCode and Claude Code. The repository is set up with
[`@srobroek/harness-kit`](https://github.com/srobroek/harness-kit), which generates the
per-harness manifests, the Claude Code marketplace and the inventories from `plugins/<name>/`.
The plugins began in `srobroek/opencode-plugins`, whose history this repository carries.

| Field | Value |
| --- | --- |
| Plugins | See [INVENTORY.md](INVENTORY.md) |
| OpenCode | 2.3.2 or later (`@opencode/plugin` 2.x). V1 plugins (`@opencode-ai/plugin`) do not run on V2. |
| License | Apache-2.0 |

## Layout

```text
plugins/<name>/
  package.json     name (equal to the directory), version, and the "agent-plugins" key
  README.md        what the plugin does and how to install it
  common/          skills/, agents/ and formulas/ for every harness; x.opencode.md and x.claude.md replace x.md in one harness
  agents.src/      agent sources with {{include}} lines, composed into common/agents/
  opencode/        the OpenCode install tree: src/, the committed dist/ bundle and the root shims
  claude/          the Claude Code install tree: hooks, .mcp.json, the committed dist/ hook bundle
lib/               @srobroek/opencode-lib, the shared helpers; bundled into each plugin, never released
.claude-plugin/marketplace.json   generated
INVENTORY.md, inventory.json      generated
harness-kit.json                  generator config
```


`opencode/src/index.ts` default-exports `Plugin.define({ id, setup })`. Plugin ids use the
`srobroek.<name>` prefix. The `agent-plugins` key holds the description, category, `harnesses`,
`scope`, `signals` and `requires` (read by `scripts/build-plugin-table.ts`), `entries` (OpenCode
bundles, as `{ shim: source file }`), `claudeEntries` (Claude Code bundles) and `claudeAgents`
(the agents translated for Claude Code; default: every subagent).

### Why plugins ship a bundle

OpenCode installs a `::path:` git spec through npm's Arborist, which packs only that
subdirectory and installs only its registry dependencies. The shared library is not there at
runtime, so `scripts/build.ts` bundles each plugin with `bun build`. `@opencode/plugin` and
`effect` stay external: OpenCode provides them to plugins and refuses copies from a plugin's
`node_modules`. OpenCode loads a local plugin directory by file name and ignores `exports`. The root `index.js`
shim next to `dist/` serves that.

## Installing a plugin

OpenCode installs a plugin straight from the `opencode/` subdirectory of its plugin:

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/<name>/opencode'
```

Pin a tag (`#<tag>`) to stop automatic updates.

Claude Code installs from the marketplace `harness-plugins`:

```sh
claude plugin marketplace add srobroek/harness-plugins
claude plugin install worktrunk@harness-plugins
```

The CAD plugin now lives in [srobroek/cad-agent](https://github.com/srobroek/cad-agent). To install
it for OpenCode from a checkout, set `CAD_AGENT` to that checkout and run:

```sh
CAD_AGENT=/path/to/cad-agent
python3 "$CAD_AGENT/harness/install.py" --harness opencode
```

See the [cad-agent install instructions](https://github.com/srobroek/cad-agent#install) for other harnesses.

Plugins with `claude` in their `harnesses` are in the marketplace. They carry the skills, the
`.mcp.json` where there is one, the subagents translated by `scripts/claude-agents.ts`, and hooks.
Tools, gates and TUI code are OpenCode-only.

## MCP servers from plugins

`docs`, `aws`, `design` and `ast-grep` add MCP servers through `ctx.mcp.transform`, using
`lib/src/mcp.ts`. Servers are written in the Claude Code `.mcp.json` format (`common/.mcp.json`, copied
to both trees), so the same file serves both harnesses; OpenCode-only servers live in code.
In OpenCode:

- A server you configure under the same name in `opencode.json` wins; the plugin leaves it alone.
- `${VAR}` and `${VAR:-default}` are expanded from the environment OpenCode starts in.
  A server naming an unset variable is skipped.
- The plugin option `mcp` is `"auto"` (default: only in projects the plugin's marker check
  matches; for `ast-grep`, only when its binary is on `PATH`), `"always"` or `"off"`, and
  `mcpServers` turns single servers on or off by name.
- Every server runs in Code Mode. Remote servers that need no sign-in set `oauth: false`; any
  other remote server signs in through `/mcps`.

## Develop

```sh
mise install    # bun and just
bun install --frozen-lockfile
bun run build    # scripts/build.ts, then harness-kit build
bun run check    # harness-kit check: generated files are current, Claude plugins validate
bun test
bun run typecheck
bun run lint
just verify      # everything CI runs
```

Edit `common/`, `opencode/src/`, `agents.src/` or `lib/`. Run `bun run build` and commit the
generated files. `bun run build:check` and `bun run check` fail on any stale file. The content
checks (`plugin-table:check`, `steering`, `pitfalls`, `agent-roles`, `descriptions`, `concerns`)
run in CI next to the reusable `harness-kit` check.

Load a local checkout by adding `plugins/<name>/opencode` to `plugins` in `opencode.json`. Run
`bun run build` after each change; OpenCode loads the built `dist/`, not `src/`.

## Converting Oh My Pi agents

`scripts/convert-agent.ts` turns omp agent markdown into V2 agent markdown:

```sh
bun scripts/convert-agent.ts --out .opencode/agents \
  --fragment model-roles.json ../omp-plugins/delivery/agents/*.md
```

- The omp `@role` becomes the `x-opencode-model-role` request header with the model-roles tier
  it stands for (`cheap`, `standard`, `strong`, `reviewer`, `orchestrate`). Old role names map to their tier:
  `smol`, `commit` and `tiny` to `cheap`, `task` to `standard`, `slow`, `plan`, `architect` and
  `designer` to `strong`, `challenger` and `judge` to `reviewer`. `default` writes no header.
  `--role-map map.json` renames roles first. Anything else gets no header and a warning.
- No model is written by default, so without model-roles the agent inherits the session's model.
  `--roles` adds a fallback model per role.
- The fragment (default `<out>/roles.json`) is `{ "agents": { "<id>": "<role>" } }`.
- `tools` becomes `deny` rules for the V2 actions the agent does not list. Pass `--allow-listed`
  for explicit `allow` rules, or `--exclusive` for a tool allowlist. `spawns` becomes `subagent`
  deny `*` plus one allow per agent, with `scout` mapped to `explore`.
- A JTD `output` schema becomes a "Report format" section: a `VERDICT:` first line and a fenced
  JSON block.
- Only V2-native frontmatter keys are written. Everything dropped or rewritten is printed as a
  warning.

## Content plugins

Plugins that only ship skills and agents export `contentPlugin(id, import.meta.url)` from
`@srobroek/opencode-lib/content-plugin`. It registers every `skills/<name>/SKILL.md` and
`agents/<id>.md` beside the bundle. Agents pin no model and name a model-roles tier in the
`x-opencode-model-role` request header. A skill or agent you already have with the same id keeps
its fields.

`bun run agent-roles` fails when a shipped agent has no tier header, names a value that is
neither a tier nor an accepted old role name, or pins a model outside `delivery`. A plugin's
`common/agents/roles.json` fragment must match the headers.

`bun run steering` fails on omp steering left in shipped markdown: `skill://`, `rule://`,
`agent://`, `proc://` and other omp URIs, omp tool names such as `` `bash` ``, `` `task` ``,
`` `eval` `` or `ast_grep`, TTSR wording, omp CLI paths, and SKILL.md frontmatter that is not
strict YAML.

## Workflows

- `.github/workflows/ci.yml` calls the reusable `check.yml` of harness-kit (`harness-kit check`,
  `bun test`, `tsc`), runs the `repo-checks` job (lint, `build:check`, the content checks and the
  Python tests of the shipped scripts). The job installs bun and just from `.mise.toml` and calls
  `just` recipes.
- `.github/workflows/release.yml` calls the reusable `release.yml` (multi-semantic-release). It
  tags each plugin as `<name>--v<version>`.

Both pin harness-kit at the version of the package in `package.json`: `srobroek/harness-kit/.github/workflows/check.yml@v1.8.0` and `srobroek/harness-kit/.github/workflows/release.yml@v1.8.0`.
Renovate moves the package and the workflow tags in one pull request, using the preset in
`renovate.json`. That pull request needs `just build` on its branch before it passes
`harness-kit check`.

## Migration notes

- The Codex marketplace of `srobroek/opencode-plugins` was dropped; only OpenCode and Claude Code are generated.
- The stale-branches cron of `srobroek/opencode-plugins` was not carried over.

## License

Apache-2.0. See [LICENSE](LICENSE).
