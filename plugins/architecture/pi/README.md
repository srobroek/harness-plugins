# architecture

Architecture guidance as skills, plus a read-only `architect` subagent.

Only `architecture-guide` is listed to the model in OpenCode: it is a router whose body maps each
situation to the skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code ignores that metadata, so there every skill is listed and triggers directly.

| Skill | When |
| --- | --- |
| `architecture-top-level` | Choosing or changing top-level directories: `apps/`, `services/`, `functions/`, `workers/`, `libs/`, `packages/`, `schemas/`, `data/`, `infrastructure/`, `tools/`, ... |
| `architecture-ownership` | Placing libs by architectural role, owner-local assets and data, schemas, generated clients, UI primitives and product agents |
| `architecture-repositories` | Single-language repository, polyglot monorepo or several repositories; layout by deployable with native workspaces per language, shared contracts with generated clients, task runners and build tools, CI selection, ownership and per-component releases |
| `architecture-docs-files` | Inferring architecture or stack, or creating durable project knowledge under `docs/` |

On omp these were rules the host attached by description. Here they are skills the
model loads when the description matches; the text is unchanged apart from
references, which now name the skill (`architecture-docs-files` points at the
`quality-code-design` skill from the quality plugin).

## Agent

`architect` (mode `subagent`, steps 80) designs systems, modules and APIs and turns a hard
change into an ordered implementation plan. It starts its reply with
`VERDICT: DESIGNED|PARTIAL|BLOCKED`. Its permissions are an allowlist: every tool
is denied except read, grep, glob, the `lsp_*` tools, webfetch, websearch, `subagent`
for `explore`, and the `architecture-*`, `lang-*` and `quality-*` skill families, so
`edit`, `shell`, Code Mode and other skills are not in its requests. Rules are added after any you configure for an agent
with the same id, so the read-only boundary holds.

The agent was converted from omp with `scripts/convert-agent.ts`. The omp
`ast_grep`, `lsp` and `find` tools became `grep`, `glob`, an LSP tool when one is
available, and `explore` in place of `scout`. Spawning `explore` from `architect`
running as a subagent needs `experimental.subagent_depth` of 2 or more.

The agent pins no model. It declares the `strong` model tier through the
`x-opencode-model-role` request header, so with the model-roles plugin the
`strong` tier picks its model. Without it the agent inherits the caller's model;
set `agent.architect.model` in your config to pin one.

## Pi subagent tools

`architect` adds `symbol_search`, `module_report`, `project_report`, `read_symbol`, `read_enclosing`, `ast_grep_search`, `ast_grep_outline`, `lens_diagnostics`, `pi_lens_activate_tools`, `web_search`, `fetch_content`, `get_search_content`, `source_check`, `repomix_pack`, `dep_scan`, `version_gap_scan`, and `mcp:context7` to its existing tools. Pi-lens keeps `ast_grep_search` and `ast_grep_outline` inactive until `pi_lens_activate_tools` runs; activation takes effect on the next turn. `lsp_navigation` and `ast_grep_replace` are not granted.

`architect` also has `bash` for read-only inspection such as `git log`. It has no `write` or `edit`. To get its research as a file, pass the `output` option of the `subagent` call: pi-subagents saves the architect's final reply to that path. Give an absolute path for a file in the project; pi-subagents puts a relative `output` path under the run's artifact directory. A task that asks for a document or names an output file lifts the reply's word cap.

Required Pi packages: `pi-lens`, `pi-web-access`, `@srobroek/pi-repomix`, `@srobroek/pi-dep-update`, and `@srobroek/pi-whats-new`. Configure the `context7` Pi MCP server in `~/.pi/agent/mcp.json` for `mcp:context7`.

## Install
Install the Pi package from npm:

```sh
pi install npm:@srobroek/pi-architecture
```

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/architecture/opencode'
```
OMP installs the agent and skills from the generated OMP directory:

```sh
omp plugin install /path/to/harness-plugins/plugins/architecture/omp
```

Claude Code install the skills, not the agent, from this repository's
marketplace:

```sh
claude plugin marketplace add srobroek/harness-plugins
claude plugin install architecture@harness-plugins

```

## Works with

This package works with these pi packages. Install them next to it.

| Package | Required | For | Install |
| --- | --- | --- | --- |
| `pi-lens` | yes | code-intelligence and AST search tools for the architect | `pi install npm:pi-lens` |
| `pi-web-access` | yes | web research tools for the architect | `pi install npm:pi-web-access` |
| `@srobroek/pi-repomix` | yes | repository packing for the architect | `pi install npm:@srobroek/pi-repomix` |
| `@srobroek/pi-dep-update` | yes | read-only dependency scan tools for the architect | `pi install npm:@srobroek/pi-dep-update` |
| `@srobroek/pi-whats-new` | yes | version gap scan tools for the architect | `pi install npm:@srobroek/pi-whats-new` |
