# agent-researcher

A `researcher` subagent that answers one scoped research question from the
codebase, its docs and the web, with cited observations kept apart from inferences.

## Agent

`researcher` (mode `subagent`, steps 80) takes a question in its brief, or a bead id that
holds one. It:

- reads the narrowest relevant repository paths first, spawns `explore` for broad
  codebase lookups, and uses `websearch` and `webfetch` for external sources,
  preferring primary sources over summaries;
- cites every material claim with a path and line range or a URL, and marks each as
  an observation or an inference;
- with a bead id, claims the bead, records the finding with `bd comment` and leaves
  the bead open for the dispatcher; without one, returns the answer only;
- edits nothing, changes no bead links, and makes only read-only `gh`/`glab` calls.

Its reply starts with `VERDICT: DONE|BLOCKED` and ends with a fenced `json` block
(`verdict`, `answer`, and optional `bead_id`, `uncertainty`, `notes`), the shape the
delivery plugin's verdict hook parses.

Its permissions are an allowlist: read, grep, glob, the `repomix` skill, Code Mode
(`execute`, for `repomix_pack`), the `lsp_*` tools, shell (for `bd` and forge reads),
`webfetch`, `websearch`, `repomix_pack` (from the repomix plugin, for packing an
external repo to a temp file), and spawning only `explore`. Every other skill is denied,
so the skill listing stays out of its requests. Reads outside the workspace (`external_directory`) ask.

The agent pins no model. It declares the `standard` tier through the
`x-opencode-model-role` request header, so with the model-roles plugin that tier
picks its model; without it the agent inherits the caller's model. Set
`agent.researcher.model` to pin one.

## With delivery

The id stays `researcher`, so beads routing (`execution_agent_type=researcher`)
works with or without delivery. Delivery ships the same agent as a fallback and
skips it when this plugin (`srobroek.agent-researcher`) is installed. If delivery's
copy registers first, this plugin replaces it rather than layering over it, so either load order leaves one
agent.

## MCP tools

`researcher` cannot call MCP tools unless a rule allows them. The `tools` option adds allow rules for MCP tool patterns after the agent's own rules. OpenCode names an MCP tool's permission action `<server>_<tool>`, so `context7_*` allows every tool of the `context7` server and `context7_query-docs` allows one. Characters outside letters, digits, `_` and `-` become `_`.

| Option | Default | Effect |
| --- | --- | --- |
| `tools` | `["context7_*"]` | Context7 is allowed by default. Add MCP patterns such as `aws-mcp_*` for AWS projects; an array replaces the default. `false` or `[]` adds no rules; the agent keeps its fixed allowlist. |

```jsonc
"options": { "tools": ["context7_*", "<server>_<tool>"] }
```

Patterns must name MCP server tools only (`<server>_<tool>`). The option refuses a pattern that could match a tool from a plugin in this repository or from OpenCode itself, such as `dep_*`, `delivery_*`, `quality_*`, `lsp_*` or `opencode_*`, and a pattern that starts with a wildcard, and logs a warning. Only add read-only tools: an allowed MCP tool runs without a prompt. The option refuses a pattern that matches a built-in action (`shell`, `edit`, `write`, `patch`, `external_directory`, `subagent`, `*` and the like) and logs a warning, so it cannot widen file or shell access.

This agent allows `execute`, so it reaches MCP tools through Code Mode; each nested call is checked against the same rules (`packages/core/src/tool.ts:337-339`, OpenCode v2.2.6).

## Pi tools

Pi `researcher` keeps `web_search`, `fetch_content`, `get_search_content`, and `source_check` from `pi-web-access`. It adds `symbol_search`, `module_report`, `project_report`, `read_symbol`, `read_enclosing`, `ast_grep_search`, `ast_grep_outline`, `lens_diagnostics`, and `pi_lens_activate_tools` from `pi-lens`. `repomix_pack` comes from `@srobroek/pi-repomix`.

Required companion packages: `pi-subagents`, `pi-web-access`, `pi-lens`, and `@srobroek/pi-repomix`. `context7` must be configured as a Pi MCP server in `~/.pi/agent/mcp.json`; it is selected by `mcp:context7`.

pi-lens keeps `ast_grep_*` tools inactive until `pi_lens_activate_tools` runs; they are available starting the next turn. The read-only allowlist omits `lsp_navigation` and `ast_grep_replace`.

Pi `researcher` has no `write` or `edit`. Its definition sets `output: research.md`, so pi-subagents saves its final reply as `research.md` under the run's artifact directory. To save the report in the project, pass an absolute path as the `output` option of the `subagent` call.

## Install
Install the Pi package from npm:

```sh
pi install npm:@srobroek/pi-agent-researcher
```

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/agent-researcher/opencode'
```
OMP installs the agent from the generated OMP directory:

```sh
omp plugin install /path/to/harness-plugins/plugins/agent-researcher/omp
```

This plugin ships no skills, so it is not in the Claude Code marketplace.

## Works with

This package works with these pi packages. Install them next to it.

| Package | Required | For | Install |
| --- | --- | --- | --- |
| `pi-subagents` | yes | the subagent tool | `pi install npm:pi-subagents` |
| `pi-lens` | yes | code-intelligence tools for the subagent | `pi install npm:pi-lens` |
| `@srobroek/pi-repomix` | yes | the repomix_pack tool | `pi install npm:@srobroek/pi-repomix` |
| `pi-web-access` | yes | web research tools | `pi install npm:pi-web-access` |
