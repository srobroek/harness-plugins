# find-tools

Finds reusable OpenCode plugins, agent skills and MCP servers for a capability,
vets them, and recommends one decision: `Use existing`, `Adopt`, `Trial`,
`Reject` or `Build`. It never installs anything.

Ported from the omp-plugins `find-tools` plugin, without its omp sources and
without `setup-tools`.

## Install
Install with Pi:

```sh
pi install npm:@srobroek/pi-find-tools
```

The plugin directory is a Pi package. Add its repository path to `packages` in `~/.pi/agent/settings.json`:

```json
{ "packages": ["/absolute/path/to/harness-plugins/plugins/find-tools"] }
```

Pi loads the extension from `pi/extensions/find-tools.js`. For foreground pi-subagents children, add `find-tools` to `subagents.defaultSubagentOnlyExtensions`; agents can set `subagentOnlyExtensions` instead.

The OpenCode plugin is available separately:

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/find-tools/opencode'
```

The skill drives the `find_tools_scan` tool. The plugin is not exported to Claude Code.

## Tool

`find_tools_scan` takes a `query` (a few specific words) and an optional
`sources` subset. It is read-only. All sources run in parallel, each with a
10-second deadline, and each reports `ok`, `empty`, `partial`, `skipped` or
`failed`. The result lists the gaps (every source that was not fully searched)
and a coverage count.

| Source | Searches |
| --- | --- |
| `local` | Pi packages from `~/.pi/agent/settings.json`; user skills from `~/.pi/agent/skills`; MCP status counts from `~/.pi/agent/mcp.json`, without names, commands, URLs or environment |
| `catalog` | This repository's `.claude-plugin/marketplace.json` from GitHub, plus `skillCatalogs` |
| `mcp_registry` | The official MCP Registry (`/v0.1/servers?search=…&version=latest`) |
| `npm` | Keywords `opencode-plugin`, `mcp-server`, `agent-skill`, `claude-skill`; ranked and capped at 20 |
| `github` | `gh api` code search for `.claude-plugin/marketplace.json` and `SKILL.md`, and repositories with topic `opencode-plugin`. Skipped without `gh` |
| `awesome_opencode` | The awesome-opencode README. Every hit is labelled unvetted |
| `smithery` | The Smithery registry. Skipped unless `SMITHERY_API_KEY` is set |
| `skills_cli` | Always a gap: the skills CLI runs package code, so discovery never calls it |

Hits carry install hints (project scope first, user-wide for plugins). Hints
that start a package runner are marked *runs package code*. The tool shows them
and never runs them.

[`pi-vetter`](https://pi.dev/packages/pi-vetter) is an optional Pi package for package vetting. It complements this discovery workflow; it does not replace it.

## Skill

`find-tools` is the workflow: clarify the need, scan, check what is installed,
vet candidates with the rubric in `references/adoption-policy.md`, and present
a decision table. It asks before any install, defaults to project scope, and
asks again separately for a user-wide install or for anything that runs
package code through `npx`, `bunx`, `uvx` or `docker run`.

## Install guard

With `guardInstalls` on (the default), a `permission.hook("evaluate")` turns
an allowed shell command into a prompt when it:

- runs the skills CLI to install (`npx skills add`, `bunx skills install`,
  `pnpm dlx skills add`, `npx add-skill`);
- runs the Smithery CLI to add a server (`smithery mcp add`,
  `npx @smithery/cli install`);
- pipes a download into a shell (`curl … | sh`, `bash <(curl …)`,
  `sh -c "$(curl …)"`).

It reads commands statically, through wrappers (`sudo`, `env`, `timeout`) and
`bash -c`. It does not see installs behind variables, aliases or scripts, and
it leaves a configured `deny` alone. It is a prompt, not a sandbox.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "github:srobroek/harness-plugins::path:plugins/find-tools/opencode",
      "options": {
        "guardInstalls": true,
        "skillCatalogs": ["https://example.com/.well-known/skills/"]
      }
    }
  ]
}
```

- `guardInstalls` (default `true`): register the install guard.
- `skillCatalogs` (default `[]`): extra catalogs for the `catalog` source. Each
  is a JSON document: a Claude Code `marketplace.json` (`plugins`), an object
  with a `skills` array, or an array of `{ name, description }`. A URL ending
  in `/` is read through its `index.json`.
