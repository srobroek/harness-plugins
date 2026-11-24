# agent-reviewer

Read-only reviewer subagents that share one review core, and the `review-security`
skill they load.

## Agents

| Agent | Reviews | Tools | Verdict | In the subagent catalog |
| --- | --- | --- | --- | --- |
| `pr-reviewer` (steps 80) | GitHub pull request on all harnesses; GitLab merge request on OpenCode only | OpenCode shell `gh pr view *`, `gh pr diff *`, `glab mr view *`, `glab mr diff *`, and GET-only `glab api` patterns; Pi shell `gh pr view *`, `gh pr diff *`; OMP `github` tool | `APPROVE\|REQUEST-CHANGES\|COMMENT` | no (`hidden: true`) |
| `code-reviewer` (steps 80) | A local diff: working tree, branch range or commits | read, grep, glob, `lsp_*`; shell `git diff`, `git log`, `git show` only, never `--output` | `APPROVE\|REQUEST-CHANGES\|COMMENT` | yes |
| `security-auditor` (steps 80) | A repository scope or the files a change touches, source to sink, CWE-tagged | read, grep, glob, `lsp_*`; no shell, no web | `PASS\|MINOR\|MAJOR` | yes |
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

## MCP tools

`code-reviewer`, `security-auditor` and `adversarial-challenger` cannot call MCP tools unless a rule allows them. The `tools` option adds allow rules for MCP tool patterns after the agent's own rules. OpenCode names an MCP tool's permission action `<server>_<tool>`, so `context7_*` allows every tool of the `context7` server and `context7_query-docs` allows one. Characters outside letters, digits, `_` and `-` become `_`.

| Option | Default | Effect |
| --- | --- | --- |
| `tools` | `["context7_*", "aws-mcp_*"]` | An array of patterns replaces the defaults. `false` or `[]` adds no rules; the agent keeps its fixed allowlist. |

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
they are stale. The design plugin's `design-critic` and `a11y-auditor` and speckit's
`speckit-verify` compose the same core.

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

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/agent-reviewer/opencode'
```

Claude Code install the `review-security` skill, not the agents, from this
repository's marketplace:

```sh
claude plugin marketplace add srobroek/harness-plugins
claude plugin install agent-reviewer@harness-plugins

```
