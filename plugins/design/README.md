# design

UI and UX design for OpenCode: eight workflow skills, five design rules as skills,
four design subagents, nine beads formulas with a `design_setup` tool that installs
them, a `design_impeccable_scan` tool that runs impeccable's detector, and optional
accessibility, wireframing and Storybook MCP integrations.

The pi package `@srobroek/pi-design` ships the same skills and agents. It adds a
Playwright browser, a `/design-review` prompt and a `/council-product` prompt.
See [pi](#pi).

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

## pi

Install the package in each frontend project:

```sh
pi install -l npm:@srobroek/pi-design
```

`-l` writes the project's `.pi/settings.json`. Every session that loads the package
starts its MCP servers, so install it per project.

### Prerequisites

At session start, the package looks for these tools on `PATH` and names each missing tool:

| Tool | Used for | Install |
| --- | --- | --- |
| `impeccable` 4.10.0 or later | `design_impeccable_scan` and the upstream impeccable skill pack | `mise use -g npm:impeccable` |
| `npx` | the Playwright, `accessibility-scanner` and `wire-dsl` MCP servers | `mise use -g node` |

The impeccable skill pack is a separate install. This command writes it to
`.pi/skills/impeccable/`:

```sh
impeccable install -y --providers=pi --scope=project --no-hooks
```

The Playwright server drives Google Chrome where it is installed. On a host without it, such
as a Linux ARM server, it drives Playwright's Chromium. Install that Chromium once for the
pinned Playwright:

```sh
npx -y playwright-core@1.66.0-alpha-2026-11-18 install chromium chromium-headless-shell
```

### Scan tool

`design_impeccable_scan` runs the `impeccable` on `PATH` without a prompt. When
impeccable is not on `PATH`, the tool asks you to approve the npx download. A session
that cannot ask, such as a subagent or `pi -p`, gets a refusal and the command that
installs impeccable. The timeout and the output limit are the same as in OpenCode.

### Browser

The extension registers a `playwright` MCP server. It runs Playwright MCP with an in-memory
profile. At session start the extension picks the browser:

- `PLAYWRIGHT_MCP_BROWSER` names it, for example `chromium` or `msedge`.
- With no such setting, it is `chrome` when Google Chrome is installed, else `chromium`.

Then the extension picks the mode:

1. `PLAYWRIGHT_MCP_HEADLESS=1` (or `true`) makes it headless, and `0` (or `false`) makes it
   headed. The extension ignores other values.
2. With no such setting, a Mac gets a headed browser. Linux gets one when `DISPLAY` or
   `WAYLAND_DISPLAY` has a value.
3. Otherwise it is headless, because a headed Chrome cannot start on a host with no display.

A headed `/design-review` opens two windows, one for each reviewer. The extension hides
three tools:

- `browser_run_code_unsafe` runs code in the server's Node process.
- `browser_file_upload` hands local files to the page.
- `browser_drop` drops local files onto the page.

The server runs in a new temporary directory for each session, and that directory is its
only workspace root. Snapshots, screenshots and the other files the tools save go there.
The extension deletes the directory when the session ends, so copy a file you want to keep.
A write outside that root fails with "File access denied", and the server blocks `file:` URLs.

`pi-src/playwright-tools.json` records the 25 tools the pinned release offers. After a
version bump, record it again with `bun scripts/record-playwright-tools.ts`.
The design tests check each recorded tool that takes a file, a path or code.

A `playwright` server in your `mcp.json` replaces this one. Pi gives a server that an
extension registers only to background subagents. So the four design agents set
`async: true`, and `/design-review` and `ui-ux-specialist` start them in the background.
A foreground run of a design agent fails unless your own `mcp.json` has the server.

To add it, put this entry in `~/.pi/agent/mcp.json`, or in a trusted project's
`.pi/mcp.json`, and create the `cwd` directory first. Your own entry follows the
Playwright MCP rule instead: headless on Linux without `DISPLAY`, unless its `env` sets
`PLAYWRIGHT_MCP_HEADLESS`.

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.86", "--isolated", "--browser", "chrome", "--viewport-size", "1440x900", "--ignore-roots", "--file-paths", "absolute"],
      "cwd": "~/.cache/pi-design-playwright",
      "toolExposure": { "browser_run_code_unsafe": "hidden", "browser_file_upload": "hidden", "browser_drop": "hidden" }
    }
  }
}
```

### Using your own browser

The design agents always use the isolated browser above. To let your own pi session work
in the Chrome where you sign in, add a second server yourself. The package does not
register it.

1. In Chrome, install the "Playwright Extension" from the Chrome Web Store. Use a Chrome
   profile that you keep for the agent, and sign in there only to the sites it needs.
2. Add the server to `~/.pi/agent/mcp.json`, disabled, and create its `cwd` directory:

   ```json
   {
     "mcpServers": {
       "playwright-mine": {
         "command": "npx",
         "args": ["-y", "@playwright/mcp@0.0.86", "--extension", "--session-name", "pi", "--session-color", "red", "--ignore-roots", "--file-paths", "absolute", "--redact-url-params", "access_token,code,state,id_token"],
         "cwd": "~/.cache/pi-playwright-mine",
         "env": { "npm_config_registry": "https://registry.npmjs.org/" },
         "enabled": false,
         "exposure": "deferred",
         "description": "My Chrome through the Playwright Extension: only the tabs I share at the connect prompt.",
         "toolExposure": { "browser_run_code_unsafe": "hidden", "browser_file_upload": "hidden", "browser_drop": "hidden", "browser_evaluate": "hidden" }
       }
     }
   }
   ```

3. Turn it on only in a trusted project. Put
   `{"mcpServers":{"playwright-mine":{"enabled":true}}}` in that project's `.pi/mcp.json`,
   or use `/mcp` and choose "Enable in this project".

At each connection, Chrome opens an approval page where you pick the tabs to share. The
session reaches only those tabs and the tabs it opens itself. It works only where your
Chrome runs, so it needs a display and `PLAYWRIGHT_MCP_HEADLESS` does not apply.

Rules for this server:

- Never name it `playwright`. That name replaces the isolated browser for every design agent.
- Never add `mcp:playwright-mine` to a design agent. The design agents run in the background,
  and nobody watches what they do in your browser.
- Do not set `PLAYWRIGHT_MCP_EXTENSION_TOKEN`, so that every connection needs your approval.
- Do not add `--caps`.
- For read-only use, also hide the tools that act on the page:
  - `browser_click`, `browser_type` and `browser_fill_form`
  - `browser_press_key` and `browser_select_option`
  - `browser_drag` and `browser_handle_dialog`

  `browser_navigate` can still send data out in a URL.
- A page where you sign in can carry prompt injection, and what the session reads goes
  into its transcript.

### Agents on pi

The four agents keep their contracts and list their pi tools explicitly:

| Agent | Tools |
| --- | --- |
| `ui-ux-specialist` | read, edit, write, bash, `subagent`, `contact_supervisor`, `design_impeccable_scan`, web tools, Playwright |
| `ui-implementer` | read, edit, write, bash, `design_impeccable_scan`, Playwright |
| `design-critic` | read, `design_impeccable_scan`, web tools, Playwright |
| `a11y-auditor` | read, bash for probes and the axe CLI, `design_impeccable_scan`, web tools, Playwright |

Each agent loads the package extension, and pi-web-access when it has web tools, through
`subagentOnlyExtensions`. `ui-ux-specialist` may start only `design-critic`,
`a11y-auditor`, `scout` and `worker`. It asks its intent questions through
`contact_supervisor` and continues with the answers. The agents pin no model. Set one with
`subagents.agentOverrides.<name>.model` in pi's settings.

### Prompts

- `/design-review <url> [paths]` runs the scan once, then `design-critic` and
  `a11y-auditor` in parallel in the background. It merges their findings and keeps the
  two verdicts apart.
- `/council-product <question>` runs the pi-subagents council protocol for a product or
  UI decision, with three passes at most.

The `/council-product` roster has four advisors:

| Advisor | Lens | From |
| --- | --- | --- |
| `council-ux` | The view of the design lead | this package |
| `council-user` | The view of the people who use the product, task by task | this package |
| `council-advocate` | The strongest case for the proposal | `@srobroek/pi-debate` |
| `council-skeptic` | The strongest case against the proposal | `@srobroek/pi-debate` |

All four advisors only read files.

`council-ux` and `council-user` are new in this package.

### Not on pi

- `design_setup`: copy `formulas/*.formula.toml` into `.beads/formulas/` yourself.
- The `confirmScan`, `mcp` and `mcpServers` options, and the Storybook server.
- Frontend detection: `accessibility-scanner` and `wire-dsl` connect in every session
  that loads the package.

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

For pi, see [pi](#pi).
