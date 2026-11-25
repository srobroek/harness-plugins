# design

UI and UX design for OpenCode: eight workflow skills, five design rules as skills,
four design subagents, nine beads formulas with a `design_setup` tool that installs
them, a `design_impeccable_scan` tool that runs impeccable's detector, and optional
accessibility, wireframing and Storybook MCP integrations.

## Skills

Only `design-guide` is listed to the model in OpenCode: it is a router whose body maps each
situation to every skill below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code ignores that metadata, so there every skill is listed and triggers directly.

| Skill | Phase | When |
| --- | --- | --- |
| `design-system-audit` | GROUND | Inventory existing tokens, scales and primitives before UI work |
| `design-md` | SPECIFY | Write or update `DESIGN.md` from the audit, then lint it |
| `design-prototype` | SPECIFY | Route a wireframe, mockup, prototype or deck request to the right producer |
| `wireloom` | SPECIFY | A wireframe as a fenced `wireloom` block rendered to SVG (vendored) |
| `motion-design` | BUILD | Durations, easings and reduced-motion branches from the project scale |
| `ui-microcopy` | BUILD | Errors, empty states, CTAs, confirmations and onboarding copy (vendored guidance) |
| `ui-review` | VERIFY | Drive the rendered surface: ARIA snapshot, computed styles, keyboard walk, three widths |
| `accessibility-audit` | CRITIQUE | WCAG 2.2 AA with measured values |

On omp these five were rules; here they are skills the workflow skills and agents
load by name:

| Skill | When |
| --- | --- |
| `design-token-discipline` | Styling a component or editing tokens: named tokens only, approval for new scales |
| `design-no-slop` | Critiquing or building a rendered UI: generated-UI tells and missing states |
| `design-component-truth` | Passing component props or writing stories: verify every prop against its docs |
| `design-evidence` | Any claim about a rendered surface: ARIA, computed style or screenshot, plus the width |
| `design-upstream-preflight` | Before routing to an upstream skill or CLI: install and probe only what the route needs |

## Agents

| Agent | Role | Permissions |
| --- | --- | --- |
| `ui-ux-specialist` (steps 150) | Leads multi-component UI work through GROUND, GATE INTENT, SPECIFY, BUILD, VERIFY, CRITIQUE, RECONCILE, GATE ACCEPT | may spawn only `design-critic`, `a11y-auditor`, `explore` and `general` |
| `ui-implementer` (steps 150) | Builds one UI unit on existing tokens and components, verified at 1440, 768 and 375 px; escalates anything bigger | no web search or fetch, no subagents |
| `design-critic` (steps 60) | Read-only critique for hierarchy, rhythm and generated-UI tells | no edit, shell or subagents |
| `a11y-auditor` (steps 60) | Read-only WCAG 2.2 AA audit with measured values | no edit or subagents; shell only for preflight probes and the axe CLI fallback, by prompt |

All four are `subagent` agents converted with `scripts/convert-agent.ts`.
`design-critic` and `a11y-auditor` are composed by `bun run build` from
`agents.src/<id>.md` and the shared review core (`plugins/lib/src/review-core.md`,
see [agent-reviewer](../agent-reviewer/README.md)); `ui-implementer` is composed the
same way and includes the `standards` part of the shared coding core
(`plugins/lib/src/coding-core.md`): research first and compare with the
`lang-<language>-libraries` standards before writing your own code. Edit the source, not `agents/`. Their
first line is `VERDICT: PASS|MINOR|MAJOR`. Their
permissions are tool allowlists (a deny on every action, then allows), so a tool an
agent does not need is left out of its requests: each gets read, grep, glob, Code
Mode, the `lsp_*` tools, the `browser` tools and the `design_*` tools, plus the edit,
shell and web access its row allows. Skills are allowed by family: `design-*` and
`ui-*` for all four, plus `accessibility-audit` and the upstream `accessibility` skill
for `a11y-auditor`, the rest of the design skills (`accessibility-audit`,
`motion-design`, `wireloom`) and the coding families (`lang-*`, `quality-*`,
`toolchain-*`) for `ui-implementer`, and every design skill and the
upstream skills `design-upstream-preflight` routes to for `ui-ux-specialist`. Rules are added after any you
configure for an agent with the same id. `ui-ux-specialist`
spawning children while it runs as a subagent needs `experimental.subagent_depth`
of 2 or more. `ui-ux-specialist` runs at most 150 steps. The agents pin no model;
each declares a model tier through the `x-opencode-model-role` request header, so
with the model-roles plugin that tier picks its model, and without it the agent
inherits the caller's model:

| Agent | Model tier |
| --- | --- |
| `ui-ux-specialist` | `strong` |
| `ui-implementer` | `strong` |
| `design-critic` | `reviewer` |
| `a11y-auditor` | `reviewer` |

The browser steps need a browser the agent can drive: the OpenCode desktop browser
tools, a browser MCP server, or Playwright through the shell. The `ui-review` skill's
`references/tools.md` maps each step to both.

## Tools

| Tool | What it does |
| --- | --- |
| `design_setup` | Copies the nine formulas into a beads workspace's `.beads/formulas/`. Identical copies stay; a divergent copy is refused unless `force=true`; a symlinked `.beads` or formulas path is refused. The workspace needs `.beads/` already (`bd init`). |
| `design_impeccable_scan` | Runs `npx --yes impeccable detect --json` over files, directories or a URL (optional `viewport`, `noConfig`, `timeoutSeconds`) and returns the JSON. Exit 0 is clean, 2 is findings, 1 is a target it could not scan. |

Both tools run under your permission rules: an allowed call runs without a prompt, and a
deny or ask rule always wins. `design_impeccable_scan` runs npx, which may download
impeccable and its engine. To prompt before every run even when a rule allows it, set the
plugin option `confirmScan` to `true` (default `false`):

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/harness-plugins::path:plugins/design/opencode",
    "options": { "confirmScan": true }
  }]
}
```

Detector findings are a coarse corroborating signal: HTML-engine findings can carry
`"line": 0`, so the critique confirms each one on the rendered surface.

## Formulas

Install them with the `design_setup` tool, or copy `formulas/*.formula.toml` into
`<repo>/.beads/formulas/` (or `~/.beads/formulas/`) yourself; `bd formula list` then
shows them. They need bd 1.3 and the beads plugin.

Three tiers are poured, one molecule per piece of work:

```sh
bd mol pour design-touch --var surface=<route> --var scope=<paths>    # 8 steps, 1 human gate
bd mol pour design-surface --var surface=<route> --var scope=<paths>  # 15 steps, 3 human gates
bd mol pour design-system --var surface=<route> --var scope=<paths>   # 22 steps, 3 human gates
```

Optional vars: `platform` (default `web`), `want_design_md` (default `false`), and on
`design-system` `themes` and `density`.

Six sub-processes are bonded onto the step whose result called for them:

| Formula | Bond it when | Extra vars |
| --- | --- | --- |
| `mol-design-a11y` | an accessibility audit returned MAJOR | `round` |
| `mol-design-component` | a primitive needs its own isolated build | `component` |
| `mol-design-iterate` | the user wants another round of visual intent | `round` |
| `mol-design-motion` | motion or reduced-motion needs a pass | |
| `mol-design-responsive` | reflow or target size failed | |
| `mol-design-tokens` | the system audit returned ABSENT or PARTIAL | |

```sh
bd mol bond mol-design-iterate <step-id> --var surface=<route> --var node=<step-id> --var round=2
```

Every var of a `mol-` formula is required: `bd mol bond` does not apply var defaults.
The critique and audit steps carry `execution_agent_type` `design-critic` or
`a11y-auditor` with `execution_mode` `subagent`, so the beads plugin's routing gate
admits a spawn of that agent and blocks a spawn of any other.

## MCP servers

The plugin ships the pinned accessibility and wireframe servers in [`.mcp.json`](.mcp.json).
In OpenCode they are off by default; enable only the integrations a frontend project
uses. The optional `storybook` server is OpenCode-only and off by default.

| Server | Default | Command | Used by |
| --- | --- | --- | --- |
| `accessibility-scanner` | off | `npx -y accessibility-scanner-mcp@0.3.1` | Automated measurement route of `accessibility-audit` and `a11y-auditor`; needs a local Google Chrome or `CHROME_PATH` |
| `wire-dsl` | off | `npx -y @wire-dsl/mcp-server@0.1.3` | Vector wireframes for `design-prototype` |
| `storybook` | off | remote `http://localhost:6006/mcp` | Component documentation for `design-component-truth` and `ui-review`, served while `storybook dev` runs with `@storybook/addon-mcp` |

`storybook` is off because it answers only while Storybook runs; turn it on with
`mcpServers` in a project that runs it. OpenCode connects without OAuth. It is
OpenCode-only and not in `.mcp.json`.

`mcp: "auto"` (default) adds enabled servers only in frontend projects; `"always"`
adds them in any project and `"off"` disables all plugin servers. Each server is
independently controlled by `mcpServers`; opt in by name:

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/harness-plugins::path:plugins/design/opencode",
    "options": {
      "mcp": "auto",                           // "auto" (default), "always", or "off" for all plugin servers
      "mcpServers": { "accessibility-scanner": true, "wire-dsl": true, "storybook": true }
    }
  }]
}
```
Claude Code gets the same `.mcp.json` from the marketplace. Those servers start in
every project in that harness unless disabled in its MCP settings; enable them only
for projects that use them. Add `storybook` there yourself.

## Changes from omp

- Rules became skills, and `skill://` and `rule://` references name the skill or use
  a relative path.
- Browser steps no longer use the omp `browser`/`computer` helpers through `eval`
  (`tab.ariaSnapshot()`, `tab.emulate`, `tab.diffScreenshot`, Tern and relay modes).
  They name what each step measures; `ui-review/references/tools.md` maps each step to
  the OpenCode desktop browser tools and to Playwright, and the console and viewport
  probes use Playwright's API. Native surfaces use a desktop accessibility inspector.
- Dev servers run as background shell processes instead of omp's named `bash`
  services and `proc://` listing.
- The accessibility scanner is an MCP tool call instead of an `xd://` device write;
  image generation and `inspect_image` are described as harness tools when present.
- `design-upstream-preflight` installs an upstream skill through Claude Code
  (`claude plugin install`) or, for OpenCode, a clone added to the `skills` config,
  instead of `omp plugin install`. `a11y-auditor` reports a missing upstream instead
  of installing it.
- The agents' `autoloadSkills` became a "load these skills" line; `scout` became
  `explore`; the delivery `researcher` and `operator` children became a web search and
  the built-in `general` agent.
- The beads formulas name skills instead of `skill://` and `rule://` URIs, the browser
  tools or a desktop accessibility inspector instead of `browser` and `computer`, an
  LSP rename instead of the `lsp` tool, and Playwright's `page.emulateMedia` instead of
  `tab.emulate`. Their critique steps run `design_impeccable_scan` instead of npx.
- `mol-design-a11y` and `mol-design-iterate` make `round` required: it had a default,
  and `bd mol bond` fails on a var it was not passed even when the formula declares a
  default.
- The impeccable `PostToolUse` hook became the `design_impeccable_scan` tool. The hook
  ran impeccable's launcher after every UI file write, which fetches the engine from
  the network unasked; impeccable itself tells a harness without its hook to run
  `detect` once the changed UI is finished, which is where the formulas and
  `ui-ux-specialist` run the tool. The launcher-path note for
  `impeccable-asset-producer` is dropped with it: that agent is not registered here.

## Attribution

`design-md`, `ui-microcopy` and `wireloom` carry vendored upstream material; each
skill directory has its LICENSE and NOTICE. The other upstream skills the workflow
routes to are installed from their authors, never bundled; see
`design-upstream-preflight`.

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/design/opencode'
```

Claude Code install the skills and MCP servers, not the agents, from this
repository's marketplace:

```sh
claude plugin marketplace add srobroek/harness-plugins
claude plugin install design@harness-plugins

```
