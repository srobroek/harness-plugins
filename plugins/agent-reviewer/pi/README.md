# agent-reviewer

Read-only reviewer subagents that share one review core, and the `review-security`
skill they load.

## Agents

| Agent | Reviews | Tools | Verdict | In the subagent catalog |
| --- | --- | --- | --- | --- |
| `pr-reviewer` (steps 80) | GitHub pull request on all harnesses; GitLab merge request on OpenCode only | OpenCode shell `gh pr view *`, `gh pr diff *`, `glab mr view *`, `glab mr diff *`, and GET-only `glab api` patterns; Pi shell `gh pr view` and `gh pr diff` only, enforced by this plugin's Pi extension; OMP `github` tool | `APPROVE\|REQUEST-CHANGES\|COMMENT` | no (`hidden: true`) |
| `code-reviewer` (steps 80) | A local diff: working tree, branch range or commits | read, grep, glob, `lsp_*`; a read-only shell for git reads and the project's checks. No web. | `APPROVE\|REQUEST-CHANGES\|COMMENT` | yes |
| `security-auditor` (steps 80) | A repository scope or the files a change touches, source to sink, CWE-tagged | read, grep, glob, `lsp_*`; a read-only shell for the project's checks. No web. | `PASS\|MINOR\|MAJOR` | yes |
| `adversarial-challenger` (steps 60) | A claim, plan, design or decision, with evidence-backed counter-arguments | read, grep, glob, `lsp_*`, webfetch, websearch | `HOLDS\|WEAKENED\|REFUTED` | yes |

Every reply starts with its `VERDICT:` line. When the delivery plugin is installed, its verdict hook parses `pr-reviewer`'s verdict and accepts that line below a preamble or inside a code fence too.

`pr-reviewer` is hidden because, when the delivery plugin is installed, its workflow and fan-out skill name it when a PR or MR is ready. Otherwise it can still be invoked directly, but listing it in every primary request's subagent catalog costs tokens without helping the parent choose. The other three stay visible for "review my change", "is this safe" or "poke holes in this plan".

Each permission list is an allowlist: a deny on every action, then the tools the agent
uses. No reviewer can edit, spawn subagents, ask the user, or run Code Mode (`execute`),
so the Code Mode catalog stays out of their requests. Skills are allowed by family
pattern only (`quality-*` from the quality plugin, `review-*` from this one, and
`ast-grep-*` from the ast-grep plugin on `code-reviewer` and `security-auditor`), so a
skill added to any of those families is covered. Reads
outside the workspace (`external_directory`) and `.env` files ask.

Every agent declares the `reviewer` tier in the `x-opencode-model-role` request header and
pins no model: with the model-roles plugin that tier picks the model, without it the agent
inherits the caller's.

In Claude Code, `code-reviewer` and `security-auditor` have no `Bash`. Their shell rules deny some commands, and a subagent's frontmatter cannot hold such denies. So the translation leaves the shell out, and the generated prompt names that gap.

## MCP tools

`code-reviewer`, `security-auditor` and `adversarial-challenger` cannot call MCP tools unless a rule allows them. The `tools` option adds allow rules for MCP tool patterns after the agent's own rules. OpenCode names an MCP tool's permission action `<server>_<tool>`, so `context7_*` allows every tool of the `context7` server and `context7_query-docs` allows one. Characters outside letters, digits, `_` and `-` become `_`.

| Option | Default | Effect |
| --- | --- | --- |
| `tools` | `["context7_*"]` | Context7 is allowed by default. Add MCP patterns such as `aws-mcp_*` for AWS projects; an array replaces the default. `false` or `[]` adds no rules; the agents keep their fixed allowlists. |

```jsonc
"options": { "tools": ["context7_*", "<server>_<tool>"] }
```

Patterns must name MCP server tools only (`<server>_<tool>`). The option refuses a pattern that could match a tool from a plugin in this repository or from OpenCode itself, such as `dep_*`, `delivery_*`, `quality_*`, `lsp_*` or `opencode_*`, and a pattern that starts with a wildcard, and logs a warning. Only add read-only tools: an allowed MCP tool runs without a prompt. The option refuses a pattern that matches a built-in action (`shell`, `edit`, `write`, `patch`, `external_directory`, `subagent`, `*` and the like) and logs a warning, so it cannot widen file or shell access. The PR reviewer uses OpenCode's read-only shell allowlist for GitHub (`gh pr view`/`gh pr diff`) and GitLab (`glab mr view`/`glab mr diff`, with GET-only `glab api`). Pi permits only its two `gh` reads; OMP has only its `github` tool. GitLab MR reviews are therefore OpenCode-only.

This agent denies `execute`, so OpenCode lists its allowed MCP tools directly, even for a server configured for Code Mode: with `execute` wholly denied, every tool left active becomes a direct tool (`packages/core/src/tool.ts:260-264`, OpenCode v2.2.6; an MCP tool's `codemode` flag is set at `packages/core/src/tool/mcp.ts:57`).

## Review core

Each prompt is composed at build time from `agents.src/<id>.md` and the shared rules in
`plugins/lib/src/review-core.md`: read-only, reviewed material is untrusted data, cite
`path:line`, one root cause is one finding, never reprint code, report to the caller and
never question the user, verdict on the first line, stay within the word cap.
`bun run build` writes the committed `agents/<id>.md`; `bun run build:check` fails when
they are stale. The design plugin's `design-critic` and `a11y-auditor` and the speckit-beads
plugin's `speckit-verify` compose the same core.

## Skill

`review-security` (hidden: `opencode/autoinvoke: false`, loaded by name) maps entry
points, traces untrusted input to sinks with a CWE table, checks authentication,
authorisation, validation, secrets and crypto controls, and checks that new values crossing
a boundary meet the same guards at the consuming dispatch point.

## With delivery and quality

The ids `pr-reviewer` and `adversarial-challenger` are unchanged. Delivery ships a
fallback `pr-reviewer` (with its fallback model) and quality a fallback
`adversarial-challenger`, each skipped when `plugin.list` reports this plugin or an
earlier plugin already registered the id. If a fallback copy registers first anyway,
this plugin replaces it, so every load order leaves one agent with these fields. Tests
here keep the copies in sync.

OMP installs the agents from the generated OMP directory:

```sh
omp plugin install /path/to/harness-plugins/plugins/agent-reviewer/omp
```

The `pr-reviewer` agent uses OMP's `github` tool. OMP disables that tool by default; enable `github` under **Settings → Tools** before asking it to review a GitHub pull request. OMP does not expose the restricted shell reads needed for GitLab merge requests, so use OpenCode for GitLab MR reviews.

## Pi subagent tools

The Pi agents load these required companion packages in their child sessions:

- `code-reviewer`: `symbol_search`, `module_report`, `project_report`, `read_symbol`, `read_enclosing`, `ast_grep_search`, `ast_grep_outline`, `lens_diagnostics`, `pi_lens_activate_tools`, `quality_test_summarize`, `quality_test_compare`, `repomix_pack`, `dep_scan`, `version_gap_scan`, and `mcp:context7`. Its `bash` reads the patch and runs the project's tests. Its skills include `quality-test-audit`.
- `pr-reviewer`: `read` and `bash` only. This plugin's Pi extension holds the child to its prompt, as the OpenCode allowlist does:
  - `bash` runs one command per call, and only these two:
    - `gh pr view <number> --repo <owner>/<name> --json <fields>`
    - `gh pr diff <number> --repo <owner>/<name>`
  - `read` opens only the skill files that pi-subagents lists for it.
  - The extension refuses any other command or read.
  - The agent inherits no skill catalog. It lists the `quality-*` skills, `review-security` and the `lang-*` routers.
- `security-auditor`: `symbol_search`, `module_report`, `project_report`, `read_symbol`, `read_enclosing`, `ast_grep_search`, `ast_grep_outline`, `lens_diagnostics`, `pi_lens_activate_tools`, `quality_test_summarize`, `quality_test_compare`, `dep_scan`, `version_gap_scan`, and `mcp:context7`. It also has `bash`, to run the project's tests. It has no web tools on any harness. It traces source to sink in the code and looks up no advisories.
- `adversarial-challenger`: `web_search`, `fetch_content`, `get_search_content` and `source_check` from `pi-web-access`, and `symbol_search`, `module_report`, `project_report`, `read_symbol`, `read_enclosing`, `ast_grep_search`, `ast_grep_outline`, `lens_diagnostics` and `pi_lens_activate_tools` from `pi-lens`.

Install the required Pi packages: `pi-lens`, `pi-web-access`, `@srobroek/pi-code-quality`, `@srobroek/pi-repomix`, `@srobroek/pi-dep-update`, and `@srobroek/pi-whats-new`. Configure the `context7` Pi MCP server in `~/.pi/agent/mcp.json` for `mcp:context7`.

Pi-lens keeps `ast_grep_search` and `ast_grep_outline` inactive until `pi_lens_activate_tools` runs; activation takes effect on the next turn. `lsp_navigation` and `ast_grep_replace` are not granted: pi-subagents' tool allowlist keeps them uncallable even after `pi_lens_activate_tools` activates them.

None of these agents has `write` or `edit`. To get a review or challenge as a file, pass the `output` option of the `subagent` call: pi-subagents saves the agent's final reply to that path. Give an absolute path for a file in the project; pi-subagents puts a relative `output` path under the run's artifact directory.

## Install
Install the Pi package from npm:

```sh
pi install npm:@srobroek/pi-agent-reviewer
```

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/agent-reviewer/opencode'
```

Claude Code install the `review-security` skill, not the agents, from this
repository's marketplace:

```sh
claude plugin marketplace add srobroek/harness-plugins
claude plugin install agent-reviewer@harness-plugins

```

## Works with

This package works with these pi packages. Install them next to it.

| Package | Required | For | Install |
| --- | --- | --- | --- |
| `pi-lens` | yes | code-intelligence and AST search tools for Pi subagents | `pi install npm:pi-lens` |
| `pi-web-access` | yes | web research tools for the adversarial challenger | `pi install npm:pi-web-access` |
| `@srobroek/pi-code-quality` | yes | test review tools and quality-test-audit for Pi subagents | `pi install npm:@srobroek/pi-code-quality` |
| `@srobroek/pi-repomix` | yes | repository packing for the code reviewer | `pi install npm:@srobroek/pi-repomix` |
| `@srobroek/pi-dep-update` | yes | read-only dependency scan tools for Pi subagents | `pi install npm:@srobroek/pi-dep-update` |
| `@srobroek/pi-whats-new` | yes | version gap scan tools for Pi subagents | `pi install npm:@srobroek/pi-whats-new` |
