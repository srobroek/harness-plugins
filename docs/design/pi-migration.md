# Pi migration

Status: analysis, 2026-11-23. Pi version: `@earendil-works/pi-coding-agent` 1.6.0.

This document records what pi offers, how its packages are distributed, and how each plugin in this repository maps to pi. No plugin is ported yet. Each port becomes its own bead.

## Pi in brief

- Config lives in `~/.pi/agent/` (`settings.json`, `auth.json`, `models.json`, `mcp.json`, `keybindings.json`). Project overrides live in `.pi/` and load only after project trust.
- Context files: `AGENTS.md` and `CLAUDE.md`, read from the agent directory and from the working directory and its ancestors. `.pi/SYSTEM.md` replaces the system prompt and `APPEND_SYSTEM.md` appends to it.
- Skills follow the Agent Skills standard. Pi discovers them in `~/.pi/agent/skills`, `.pi/skills`, `~/.agents/skills` and `.agents/skills`.
- Prompt templates are Markdown files in `~/.pi/agent/prompts` or `.pi/prompts`. Each one becomes a `/command`.
- MCP is built in (`pi mcp add`, `~/.pi/agent/mcp.json`), with stdio and streamable HTTP transports.
- Extensions are in-process TypeScript modules. They can use `pi.on(event)` with `tool_call` (block or mutate input), `tool_result`, `before_agent_start`, `context` and the session events. They can also call `registerTool`, `registerCommand`, `registerShortcut`, `registerProvider` and `registerMcpServer`. The UI API covers `notify`, `select`, `confirm`, `input`, `setStatus`, `setWidget`, `setFooter`, `custom()` components and overlays.
- Pi has no built-in subagents, plan mode or permission gate. Tools run with the user's OS permissions. Project trust covers only project config and extensions. Subagents and plan mode ship as examples or as third-party packages.

## Marketplace

Pi has no registry of its own. Packages are npm packages, git repositories or local paths:

```bash
pi install npm:pi-subagents
pi install git:github.com/owner/repo@v1
pi install ./local-package
pi list; pi update --all; pi remove npm:pi-subagents
```

`--local` writes to `.pi/settings.json` instead of the user settings. A package declares its resources in a `pi` key in `package.json` (`extensions`, `skills`, `prompts`, `themes`). It can also use the conventional directories.

Discovery:

| Catalog | Kind |
|---|---|
| [pi.dev/packages](https://pi.dev/packages) | Official gallery of npm packages with the `pi-package` keyword. A listing is not an endorsement. |
| [awesome-pi](https://github.com/BubblePtr/awesome-pi) | Community list |
| [Pi Package Index](https://github.com/getpipher/pi-package-index) | Unofficial ranking by downloads, stars and upkeep |

A plugin from this repository reaches pi as a pi package, published to npm or installed by git path.

## Popular packages

Download and star counts are from the gallery and GitHub on 2026-11-23. A maturity rating is an assessment, not a certification.

| Package | Purpose | Signal | Maturity |
|---|---|---|---|
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | Subagents, parallel and background workers, agent definitions | 1M/mo, 4.2k★ | mature |
| [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | Lazy MCP with tool search (pi also has built-in MCP) | 2.4M/mo, 1.7k★ | mature |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | Web search, URL and PDF fetch, GitHub clone | 1.4M/mo | mature |
| [pi-lens](https://github.com/apmantza/pi-lens) | LSP diagnostics, linters and type checks after edits | 115K/mo | usable |
| [@gotgenes/pi-permission-system](https://pi.dev/packages/@gotgenes/pi-permission-system) | Allow, ask and deny rules for tools, shell and paths | 51K/mo | usable |
| [@narumitw/pi-plan-mode](https://pi.dev/packages/@narumitw/pi-plan-mode) | Read-only plan mode with an approval handoff | 39K/mo | usable |
| [@juicesharp/rpiv-todo](https://pi.dev/packages/@juicesharp/rpiv-todo) | Todo tool and overlay that survive compaction | 83K/mo | usable |
| [@juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question) | Structured questions to the user | 36K/wk | usable |
| [@tintinweb/pi-subagents](https://pi.dev/packages/@tintinweb/pi-subagents) | Alternative subagents with worktree isolation | 87K/mo | usable |
| [pi-simplify](https://pi.dev/packages/pi-simplify) | Simplification review of changed code | 102K/mo | usable |
| [@plannotator/pi-extension](https://pi.dev/packages/@plannotator/pi-extension) | Plan and code review in a browser | 99K/mo | usable |
| [context-mode](https://pi.dev/packages/context-mode) | Sandboxed execution and context reduction (Elastic-2.0) | 226K/mo | usable |
| [@narumitw/pi-statusline](https://pi.dev/packages/@narumitw/pi-statusline) | Footer with model, git, context and cost | 5K/mo | usable |
| [pi-sessions](https://pi.dev/packages/pi-sessions) | Session search, titles and handoff | 5K/mo | usable |
| [pi-notify](https://pi.dev/packages/pi-notify) | Desktop notification when pi waits | 2K/mo | usable |
| [pi-herdr-subagents-lite](https://pi.dev/packages/pi-herdr-subagents-lite) | Runs subagents as pi processes in herdr panes | 3K/mo | experimental |
| [pi-aws-bedrock-mantle](https://pi.dev/packages/pi-aws-bedrock-mantle) | SigV4 provider for the Bedrock Mantle endpoint | n/a | experimental |

Packages run code with full permissions. Before installing one, check its publisher, source, license and release activity. Do not load two packages that own the same surface, such as two MCP adapters, two subagent runtimes or two footers.

## Herdr

Herdr 0.9.5 supports pi natively. `herdr integration install pi` writes `~/.pi/agent/extensions/herdr-agent-state.ts`, which reports pane state and the session identity over the herdr socket. It matches the OpenCode integration (`pane.report_agent` with `working`, `blocked` and `idle`). The omp label extensions (`agents.subs`, `agents.tasks`, `agents.todo` through `hc label`) have no pi counterpart. Port them only after choosing a subagent and todo package, because their data comes from those packages.

## Plugin portability

Classes:

- **S**: content only. Ship the skills and prompts as a pi package unchanged.
- **E**: needs a pi extension written against pi's API, reusing the pure functions in `lib/`.
- **D**: depends on a capability pi lacks natively, usually subagent and agent definitions. It needs a chosen prerequisite package.
- **X**: not applicable to pi.

The "Existing pi equivalent" column records the best maintained package found. The recommendations are adopt, adopt+extend, port ours and skip.

| Plugin | Class | Pi mechanism | Existing pi equivalent | Recommendation |
|---|---|---|---|---|
| agent-coder | D | agent definition | pi-subagents `worker` | adopt+extend: port the prompt as an agent file |
| agent-efficiency | D | `tool_call`, `before_agent_start` | none | port ours after choosing subagents |
| agent-mechanic | D | agent definition | pi-subagents | adopt+extend |
| agent-researcher | D | agent definition | pi-subagents with pi-web-access | adopt+extend |
| agent-reviewer | D | skill and agents | Piolium (usable) | port ours: skill now, agents after subagents |
| agent-seance | D | `registerTool`, session API | pi-session-search (usable, pi sessions only) | port ours |
| architecture | D (skills S) | skills, agent | none mature | port ours: skills first |
| ast-grep | E (small) | skill, `session_start` check | pi-ast-grep (usable) | port ours (skill-only) |
| autopilot | D | `registerCommand`, tools, events | @narumitw/pi-goal (usable) | port ours |
| aws | E | skill, `mcp.json` | built-in MCP plus the AWS MCP server | port ours (skill) and configure MCP |
| beads | D | skills, `tool_call`, `tool_result` | @abix5/pi-beads (4★) | port ours; OMP's beads extension is prior art |
| build | D | agent definition | pi-subagents worker | adopt+extend |
| cad | D | skills, tools, agents, formulas | none | port ours later |
| chezmoi | E | skill, `tool_call` on `write`, `edit` and `bash` | none | port ours (high value) |
| claude-compat | X | n/a | pi-claude-marketplace | skip ours; evaluate theirs |
| code-challenge | D | skill, tools, agents | pi-simplify (partial) | port ours later |
| debate | S | skills | pi-subagents `/council` (partial) | port ours |
| delivery | D | skills, tools, agents | none equivalent | port ours after subagents |
| dep-update | E | `registerTool`, `tool_call` | pi-dep-audit (partial) | port ours |
| design | D | skills, tools, MCP, agents | Impeccable skills (partial) | port ours: skills first |
| docs | E (small) | `mcp.json` or `registerMcpServer` | Context7 via MCP | configure MCP; no plugin needed |
| eli5 | S | skill | none mature | port ours |
| find-tools | E | skill, tool | pi-vetter (2★) | port ours |
| journeys | D | skills, tools, agents | none | port ours later |
| lang-go | S | skills | none mature | port ours |
| lang-python | S | skills | none mature | port ours |
| lang-rust | S | skills | none mature | port ours |
| lang-typescript | S | skills | none mature | port ours |
| lsp | E | `tool_result` | pi-lens (usable) | adopt pi-lens |
| model-roles | D | provider and model APIs, command | pi-subagents per-agent models | adopt+extend |
| modes | D | `tool_call`, active tools | @narumitw/pi-plan-mode (partial) | port ours after subagents |
| parley | E (large) | `registerTool`, `ui.custom()` | rpiv-ask-user-question (partial) | adopt theirs first; port only if it falls short |
| plugin-audit | X | n/a | none | skip |
| project | E (small) | skills, `registerCommand` | none | port ours |
| quality | D (skills S) | skills, tools, agent | none | port ours: skills first |
| repomix | E | skill, tool | pi-repomix (0★) | port ours |
| safety | E (large) | `tool_call`, `tool_result`, `registerTool` | @gotgenes/pi-permission-system, cc-safety-net (partial) | port ours; pi has no gate by default |
| session | E | `registerTool`, session API | pi-sessions (usable) | adopt+extend |
| speckit | D | skills, tools, agents | pi-spec (partial) | port ours later |
| statusline | E | `setWidget` or `setFooter` | @narumitw/pi-statusline (usable) | adopt theirs |
| subagent-worktree | D | subagent lifecycle hooks | @tintinweb/pi-subagents worktrees | adopt+extend |
| toolchain | S | skills | none | port ours |
| trunk-dev | E | `tool_call`, `tool_result` | none | port ours |
| whats-new | E | skill, tool | none | port ours |
| worktrunk | E | skills, `tool_call` | pi-worktrunk (86/wk) | port ours; OMP's worktrunk extension is prior art |

## How to port

1. **Add a `pi` harness target.** harness-kit owns cross-harness generation. Add `pi` to `KNOWN_HARNESSES` (`harness-kit/src/config.ts`) and generate `plugins/<name>/pi/` with `skills/`, `prompts/` and `extensions/`. Add a `package.json` that carries the `pi-package` keyword and a `pi` resource key (`harness-kit/src/generate.ts`). The Claude target (`scripts/build-claude.ts`) is the pattern for harness-specific output. Skill-only packages need no JavaScript build, because pi loads TypeScript extensions directly.
2. **Ship the S plugins first**: debate, eli5, lang-go, lang-python, lang-rust, lang-typescript and toolchain, plus the skills of architecture, quality and design.
3. **Write E plugins as pi-native extension sources** under `plugins/<name>/pi/extensions/`. Do not compile the OpenCode sources, which import `@opencode/plugin`. The pure modules in `lib/src` carry over: `shell-tokenizer.ts`, `shell-command.ts`, `command-words.ts`, `patterns.ts`, `transcript-text.ts` and `review-verdict.ts`. `tool-targets.ts`, `agent-files.ts`, `model-roles.ts` and `shell-result.ts` encode OpenCode contracts and need pi adapters. Pi tool names are `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`, and `tool_call` handlers test `event.toolName`. omp-plugins has counterparts for 26 plugins. omp uses the same `pi.on("tool_call", …)` form, so those ports are close prior art.
4. **Choose one subagent runtime before any D port.** pi-subagents is the most mature. Agent files become its `~/.pi/agent/agents/*.md` definitions, and model tiers become per-agent `model` fields.
5. **Skip** claude-compat and plugin-audit.
