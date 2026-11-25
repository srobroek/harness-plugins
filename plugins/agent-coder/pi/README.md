# agent-coder

A lean `coder` subagent for any code development task: implementing, fixing,
refactoring, debugging and investigating failures, writing and running tests,
running builds and linters, profiling, dependency upgrades, and answering questions
about the code. A parent session picks it for development work and keeps `general`
for non-code tasks; `general`'s requests carry every tool and skill.

## Agent

`coder` (mode `subagent`, steps 150):

- reads the brief, the relevant code and the repository's AGENTS.md, and finds the
  repo's check commands;
- reproduces or measures a failure, slowdown or question before tracing it to a cause
  backed by command output or file lines;
- makes the scoped change in the surrounding code's style, with no unrelated cleanup;
- before it writes its own code for a concern, researches current best practice and
  compares the plan with the `lang-<language>-libraries`, `toolchain-api` and
  `aws-guidance` standards, reports each departure, and puts cross-cutting concerns
  in middleware (the `standards` part of `plugins/lib/src/coding-core.md`);
- runs the repo's format, lint, typecheck, test and build commands for the touched
  code, then reviews its own diff;
- follows AGENTS.md (commit, push and scratch rules), and commits or pushes only when
  the brief or AGENTS.md says to;
- returns `BLOCKED` with a question for the caller instead of asking the user;
- replies with `VERDICT: DONE|PARTIAL|BLOCKED`, the answer or root cause when asked,
  the changed paths and each check's result.

## Tools

Its permissions are an allowlist; every other tool, questions included, is denied.

| Tool | Why |
| --- | --- |
| `read`, `grep`, `glob`, `edit` (covers `write` and `patch`), `shell` | Code work, builds, tests, profilers |
| `webfetch`, `websearch` | Library, API and changelog docs without spawning a researcher |
| `execute` (Code Mode) | Plugin and MCP tools are reached through it by default |
| `lsp_*` | Diagnostics and navigation from the lsp MCP server |
| `dep_scan`, `dep_apply` | Dependency upgrades (dep-update plugin); `dep_apply` still prompts per bump |
| `version_gap_scan` | Offline dependency inventory for upgrade research (whats-new plugin) |

It may spawn four helpers and names no `tier` in those calls; each helper uses its
own tier:

- `explore`: broad read-only lookups across unfamiliar files.
- `mechanic`: decided mechanical edits, such as renames, bulk moves and formatting.
  The coder does feature work, fixes and tests itself.
- `operator`: one bounded command with long output, returning only the requested
  lines.
- `code-reviewer`: diff reviews when requested or when changes touch security, data
  integrity, concurrency or a public contract.

`operator` requires the delivery plugin; `code-reviewer` requires agent-reviewer.
Without those plugins, their permission allows are inert.

`.env` reads and `external_directory` ask. `find_tools_scan` is denied: adopting new
tools is not development work.

## MCP tools

`coder` cannot call MCP tools unless a rule allows them. The `tools` option adds allow rules for MCP tool patterns after the agent's own rules. OpenCode names an MCP tool's permission action `<server>_<tool>`, so `context7_*` allows every tool of the `context7` server and `context7_query-docs` allows one. Characters outside letters, digits, `_` and `-` become `_`.

| Option | Default | Effect |
| --- | --- | --- |
| `tools` | `["context7_*"]` | Context7 is allowed by default. Add MCP patterns such as `aws-mcp_*` for AWS projects; an array replaces the default. `false` or `[]` adds no rules; the agent keeps its fixed allowlist. |

```jsonc
"options": { "tools": ["context7_*", "<server>_<tool>"] }
```

Patterns must name MCP server tools only (`<server>_<tool>`). The option refuses a pattern that could match a tool from a plugin in this repository or from OpenCode itself, such as `dep_*`, `delivery_*`, `quality_*`, `lsp_*` or `opencode_*`, and a pattern that starts with a wildcard, and logs a warning. Only add read-only tools: an allowed MCP tool runs without a prompt. The option refuses a pattern that matches a built-in action (`shell`, `edit`, `write`, `patch`, `external_directory`, `subagent`, `*` and the like) and logs a warning, so it cannot widen file or shell access.

This agent allows `execute`, so it reaches MCP tools through Code Mode; each nested call is checked against the same rules (`packages/core/src/tool.ts:337-339`, OpenCode v2.2.6).

## Skills

Skills are allowlisted by family prefix, so a skill a plugin adds to its family is
covered without a change here. Each family pattern also covers that family's router
skill, which the hidden members load through. The few coding skills outside their
plugin's family are allowed by id:

| Source plugin | Rules |
| --- | --- |
| `lang-go`, `lang-python`, `lang-typescript`, `lang-rust` | `lang-*` |
| `quality` | `quality-*` |
| `toolchain` | `toolchain-*`, `ops-*`; `shell-language`, `terraform-language`, `backend-background-jobs`, `ci-github-actions`, `coexistence-worktree`, `infrastructure-tfstate-guard` |
| `architecture` | `architecture-*` |
| `trunk-dev`, `worktrunk` | `trunk-dev-*`, `worktrunk-*` |
| `ast-grep` | `ast-grep-*` |
| `dep-update`, `whats-new` | `dep-update`, `whats-new` |
| `delivery` | `delivery-git-workflow` |
| `aws` | `aws-guidance` |

`delivery-git-workflow` requires the delivery plugin; without it, the permission
allow is inert. Other delivery skills, design, journeys, speckit, debate, beads and
project-management skills are left out. A skill whose plugin is not installed is
simply absent. To allow another skill, add a rule under `agents.coder.permissions`.

## Model

The agent pins no model. It declares the `standard` tier through the
`x-opencode-model-role` request header, so with the model-roles plugin that tier
picks its model; without it the agent inherits the caller's model. Set
`agent.coder.model` to pin one.

## Pi tools

Pi `coder` is allowlisted for the following tools:

- Code intelligence (`pi-lens`): `symbol_search`, `module_report`, `project_report`, `read_symbol`, `read_enclosing`, `ast_grep_search`, `ast_grep_outline`, `lens_diagnostics`, `pi_lens_activate_tools`, `ast_grep_replace`, and `lsp_navigation`.
- Test reports (`@srobroek/pi-code-quality`): `quality_test_summarize` and `quality_test_compare`.
- Dependency work (`@srobroek/pi-dep-update` and `@srobroek/pi-whats-new`): `dep_scan`, `dep_apply` and `version_gap_scan`.
- Web research (`pi-web-access`): `web_search`, `fetch_content`, `get_search_content` and `source_check`.
- MCP (`context7`): tools selected by `mcp:context7` in the user's Pi MCP configuration.

Required companion packages: `pi-subagents`, `pi-lens`, `pi-web-access`, `@srobroek/pi-code-quality`, `@srobroek/pi-dep-update`, and `@srobroek/pi-whats-new`. `context7` must be configured as a Pi MCP server in `~/.pi/agent/mcp.json`.

pi-lens keeps `ast_grep_*` tools inactive until `pi_lens_activate_tools` runs; they are available starting the next turn. Call `lsp_navigation` rename, rename_file and codeAction with `apply: false` to get the planned edits, check every target path is inside your working directory, then apply them with the edit/write tools.

## Install
Install the Pi package from npm:

```sh
pi install npm:@srobroek/pi-agent-coder
```

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/agent-coder/opencode'
```

This plugin ships no skills, so it is not in the Claude Code marketplace.

## Works with

This package works with these pi packages. Install them next to it.

| Package | Required | For | Install |
| --- | --- | --- | --- |
| `pi-subagents` | yes | the subagent tool | `pi install npm:pi-subagents` |
| `pi-lens` | yes | code-intelligence tools for the subagent | `pi install npm:pi-lens` |
| `pi-web-access` | yes | web search and fetch tools for the subagent | `pi install npm:pi-web-access` |
| `@srobroek/pi-code-quality` | yes | read-only test report analysis tools | `pi install npm:@srobroek/pi-code-quality` |
| `@srobroek/pi-dep-update` | yes | dependency scan and apply tools | `pi install npm:@srobroek/pi-dep-update` |
| `@srobroek/pi-whats-new` | yes | version gap scan tool | `pi install npm:@srobroek/pi-whats-new` |
