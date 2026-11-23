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

## Recommended stack

Status as of 2026-11-23. Adopt: installed on every pi host and seeded by the dotfiles. Pending: decided by a spike. One package owns each surface. Evidence: [package reviews](#package-reviews) and [spikes](pi/spikes.md).

| Capability | Pick | Install | Replaces or affects ours | Status |
|---|---|---|---|---|
| Subagents and scripted workflows | pi-subagents | `pi install npm:pi-subagents` | dispatch mechanism for agent-* plugins, build, subagent-worktree, design/code-challenge/speckit/cad/delivery fan-out; our policies, Beads flows and landing proof stay | adopt |
| MCP | pi built-in MCP, `exposure: "deferred"` | `~/.pi/agent/mcp.json` | docs, aws (server registration only) | adopt |
| Web search and fetch | pi-web-access | `pi install npm:pi-web-access`; provider order in `~/.pi/agent/web-search.json`, keys `EXA_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `TINYFISH_API_KEY` from the shell environment | none | adopt |
| LSP and post-edit diagnostics | pi-lens | `pi install npm:pi-lens` | lsp post-edit append (partial; navigation contract stays) | adopt |
| Beads context and recovery | pi-beads-companion | `pi install npm:pi-beads-companion` | beads context (partial); our gates stay as an extension | adopt |
| Browser | pi-agent-browser-native | `pi install npm:pi-agent-browser-native` | none | adopt |
| Plan mode | @narumitw/pi-plan-mode | `pi install npm:@narumitw/pi-plan-mode` | modes plan reminders (partial) | adopt |
| Plan and code review UI | @plannotator/pi-extension (its own `/plannotator-plan-mode` and Ctrl+Alt+P cannot be disabled; use `/plan`) | `pi install npm:@plannotator/pi-extension` | none | adopt |
| Todo list | @juicesharp/rpiv-todo | `pi install npm:@juicesharp/rpiv-todo` | none | adopt |
| Footer | @narumitw/pi-statusline | `pi install npm:@narumitw/pi-statusline` | statusline | adopt |
| Session search and handoff | pi-sessions (its `subagents` feature off) | `pi install npm:pi-sessions` | session, agent-seance | adopt |
| Destructive-command gate | cc-safety-net | `npx -y cc-safety-net@latest install --pi` | safety baseline; our extension keeps the workflow gates and owns ask-type operations (see [spikes](pi/spikes.md#building-on-cc-safety-net)) | pending |
| Cross-session messaging | pi-intercom | `pi install npm:pi-intercom` | none; subagent questions use pi-subagents `contact_supervisor` | adopt |
| Large-output context | context-mode (Elastic-2.0, Node 24.15+) | `pi install npm:context-mode` | agent-efficiency large-read guard (partial) | adopt |
| Repo wiki | openwiki (telemetry off in `~/.openwiki/.env`) | `pi install npm:openwiki` | none | adopt |
| Second-opinion advisor | pi-advisor-flow | `pi install npm:pi-advisor-flow` | none | adopt |
| Simplification review | pi-simplify | `pi install npm:pi-simplify` | code-challenge (partial) | adopt |
| Side conversations | pi-btw | `pi install npm:pi-btw` | none | adopt |
| Memory | gentle-engram (the same Engram store omp reaches through `engram mcp`) | `pi install npm:gentle-engram` | none | adopt |

Keep ours:

- Parley. `rpiv-ask-user-question` is a one-shot questionnaire. Parley supports a round lifecycle.
- Autopilot. No goal package keeps Beads claims, lanes, stop policy and merge proof.
- Delivery landing and cleanup, beads gates, trunk-dev, worktrunk and chezmoi.

Skipped:

- `@tintinweb/pi-subagents`, `pi-fabric`, `@quintinshaw/pi-dynamic-workflows`: second runtimes.
- `@narumitw/pi-goal`, `pi-goal-x`, `pi-loop`: goal controllers.
- `pi-background-tasks`: its published peer range stops at Pi 0.84.
- `pi-herdsman`: a second delegation runtime over herdr.
- `pi-mcp-extension`: replaces built-in MCP; 11 stars and 47 open issues.
- `pi-openwiki-adapter`: the official `openwiki` package ships its own pi integration.
- `pi-memory`: a second memory store next to Engram.
- `@gotgenes/pi-permission-system`: dropped by the owner.
- `@onkernel/browser-loop`: needs a Kernel cloud browser key and has no Bedrock adapter.
- `@agimon-ai/po-hashline`, `@agimon-ai/po-grep`: BUSL-1.1, and their protocol does not match Pi 1.6 built-in tools.

- `pi-mcp-adapter`: replaces built-in MCP. Built-in with `exposure: "deferred"` measured the same prompt size; revisit only for MCP prompts, elicitation, UI or Tasks (see [spikes](pi/spikes.md#pi-mcp-adapter-vs-built-in-mcp)).

Trial: `glimpseui`, Mac only (see [spikes](pi/spikes.md#glimpseui)).

## Conflicts to avoid

- One subagent or workflow runtime.
- One plan-mode controller.
- One footer owner.
- One MCP layer.
- No second goal controller.
- One memory store.
- cc-safety-net and any port of our safety gates both hook `tool_call`. cc-safety-net only blocks, so an approval from our extension must not be denied by it afterwards; split ownership per operation.

## Herdr

Herdr 0.9.5 supports pi natively. `herdr integration install pi` writes `~/.pi/agent/extensions/herdr-agent-state.ts`, which reports pane state and the session identity over the herdr socket. It matches the OpenCode integration (`pane.report_agent` with `working`, `blocked` and `idle`). The omp label extensions (`agents.subs`, `agents.tasks`, `agents.todo` through `hc label`) have no pi counterpart. Port them only after choosing a subagent and todo package, because their data comes from those packages.

## Plugin portability

The per-plugin decisions after the package adoption and the spikes are in [plugin adoption](pi/plugin-adoption.md). It supersedes this table where they differ. This table keeps the first-pass classification by mechanism.

Pi skills can bundle scripts and run CLIs with `bash` ([skills](https://pi.dev/docs/latest/skills)). Pi also documents [MCP](https://pi.dev/docs/latest/mcp), [prompt templates](https://pi.dev/docs/latest/prompt-templates), [sessions](https://pi.dev/docs/latest/sessions) and the default footer ([usage](https://pi.dev/docs/latest/usage)).

| Verdict | Meaning |
|---|---|
| **skill-only** | Ship skills and bundled scripts. Use Pi tools or `bash` for commands. |
| **config-only** | Configure Pi, MCP or context, or install the named Pi package. No local extension. |
| **extension** | Use Pi hooks or tools to preserve a real tool, UI or hard invariant. |
| **subagent-package** | Install the named subagent package and ship agent definitions. Other behavior is skill-only or config-only. |
| **skip** | Retain the two existing out-of-scope decisions. |

The existing-equivalent column names packages with related features. It does not certify safety or parity. [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) supports allow, ask and deny rules for bash patterns and paths. Its path rules also cover MCP tools. `external_directory` controls access outside the working directory. These patterns cannot express repository state or semantic checks.

| Plugin | Pi verdict | Pi mechanism and OpenCode reason | Existing pi equivalent | Recommendation |
|---|---|---|---|---|
| agent-coder | subagent-package | Install `pi-subagents` and ship the coder prompt as an agent definition. The wrapper registers content only (`plugins/agent-coder/opencode/src/index.ts:1-3`). The prompt defines the coding role (`plugins/agent-coder/opencode/agents/coder.md:141-155`). | pi-subagents `worker` | adopt+extend: port the prompt as an agent file |
| agent-efficiency | extension | `pi.on("tool_call")` blocks oversized whole-file reads and foreground `sleep` (`plugins/agent-efficiency/opencode/src/index.ts:66-76,87-123`; `plugins/agent-efficiency/opencode/src/large-read.ts:214-249`; `plugins/agent-efficiency/opencode/src/wait.ts:26-29`). Other reminders can be skills. Delegate with pi-subagents. | none | port ours |
| agent-mechanic | subagent-package | Install `pi-subagents` and ship the mechanic prompt as an agent definition. The wrapper only registers content (`plugins/agent-mechanic/opencode/src/index.ts:1-3`). The prompt defines the bounded worker (`plugins/agent-mechanic/opencode/agents/mechanic.md:54-68`). | pi-subagents | adopt+extend |
| agent-researcher | subagent-package | Install `pi-subagents` and ship the researcher definition. Its code registers that agent and tool grants (`plugins/agent-researcher/opencode/src/index.ts:20-29`). The prompt defines scoped research (`plugins/agent-researcher/opencode/agents/researcher.md:78-90`). Use pi-web-access for external research. | pi-subagents with pi-web-access | adopt+extend |
| agent-reviewer | subagent-package | Install `pi-subagents` and ship the read-only reviewer agent definitions. The hidden `review-security` material remains a skill (`plugins/agent-reviewer/opencode/src/index.ts:23-37`). | Piolium (usable) | port ours: skill now, agents after subagents |
| agent-seance | config-only | Use `pi-sessions` to search and read Pi-session transcripts. OpenCode registers a read-only session tool (`plugins/agent-seance/opencode/src/index.ts:18-54`). The Pi package covers Pi sessions. | pi-session-search (Pi sessions only) | adopt pi-sessions |
| architecture | subagent-package | Install `pi-subagents` and ship the architect definition. The plugin only registers content (`plugins/architecture/opencode/src/index.ts:1-3`). Ship guidance as skills. | none mature | port ours: skills first |
| ast-grep | skill-only | The plugin only registers a skill and warns when the CLI is missing (`plugins/ast-grep/opencode/src/index.ts:47-60`). The Pi skill can run the CLI with `bash`. `pi-ast-grep` is optional. | pi-ast-grep (usable) | port ours (skill-only) |
| autopilot | extension | Register status/log/merge/review tools and `/autopilot`. Use `pi.on("tool_call")` and session hooks for run enforcement and unattended ticks. The source owns run state, permissions and recovery (`plugins/autopilot/opencode/src/index.ts:1399-1478`). | @narumitw/pi-goal (usable) | port ours |
| aws | config-only | Configure the AWS MCP server in `mcp.json`. Ship AWS guidance as skills (`plugins/aws/opencode/src/index.ts:10-30`). Pi includes MCP support (`pi docs/mcp.md:3-32`). | built-in MCP plus the AWS MCP server | port ours (skill) and configure MCP |
| beads | extension | `pi.on("tool_call")` enforces actor, store and claim gates. `pi.on("tool_result")` reconciles claims and subagent lifecycle. The source pins shell state and gates mutations (`plugins/beads/opencode/src/index.ts:244-299,304-320,428-480`). | pi-beads-companion (adopt) | adopt pi-beads-companion for context; port our gates as an extension |
| build | subagent-package | Install `pi-subagents` and ship the external-repository worker definition. The wrapper only registers content (`plugins/build/opencode/src/index.ts:1-3`). The prompt defines the specialized repository workflow (`plugins/build/opencode/agents/external-repo-worker.md:111-159`). | pi-subagents worker | adopt+extend |
| cad | extension | Register validated CAD setup/run/stop tools. Use `pi.on("session_shutdown")` to stop owned jobs and viewers. The plugin tracks background processes and cleans them up on session deletion (`plugins/cad/opencode/src/index.ts:113-135,137-247`). Ship CAD agents with pi-subagents. | none | port ours later |
| chezmoi | extension | `pi.on("tool_call")` refuses writes to managed live targets and allows seed-once targets (`plugins/chezmoi/opencode/src/index.ts:12-26`; `plugins/chezmoi/opencode/src/guard.ts:1-11,91-164`). Static path rules cannot resolve chezmoi state. | none | port ours (high value) |
| claude-compat | skip | Evaluate the separate `pi-claude-marketplace` package instead of porting this OpenCode compatibility loader. | pi-claude-marketplace | skip ours; evaluate theirs |
| code-challenge | extension | Register scan, validation and facts tools. The tool asks before configured or downloaded analyzers run (`plugins/code-challenge/opencode/src/index.ts:58-104`; `plugins/code-challenge/opencode/src/scan/index.ts:114-169`). Validation confines run files to repository Git metadata (`plugins/code-challenge/opencode/src/validate.ts:83-123`). Ship challenge agents with pi-subagents. | pi-simplify (partial) | port ours later |
| debate | skill-only | Ship the debate skills. The prompt workflow needs no separate tool or agent runtime. | pi-subagents `/council` (partial) | port ours |
| delivery | extension | Register `delivery_land` and `delivery_cleanup` with exact-head, approval/check and receipt proofs (`plugins/delivery/opencode/src/index.ts:356-417`). `pi.on("tool_result")` captures reviewer verdicts (`plugins/delivery/opencode/src/index.ts:497-514`). Ship agent definitions with pi-subagents. | none equivalent | port ours after subagents |
| dep-update | extension | Register parsed `dep_scan` and `dep_apply` tools. Use `pi.on("tool_call")` to ask before applying a bump. The source validates operands and bounds updates (`plugins/dep-update/opencode/src/index.ts:80-155`). | pi-dep-audit (partial) | port ours |
| design | subagent-package | Install `pi-subagents` for design agents. Ship other material as skills, including an `npx impeccable detect --json` script and formula installer (`plugins/design/opencode/src/index.ts:86-137`; `plugins/design/opencode/src/impeccable.ts:11-15,185-203`; `plugins/design/opencode/src/formulas.ts:28-32`). Configure Storybook MCP in `mcp.json`. | Impeccable skills (partial) | port ours: skills first |
| docs | config-only | Configure Context7 and OpenAI Developer Docs in `mcp.json`. OpenCode registers those MCP servers (`plugins/docs/opencode/src/index.ts:27-30`). | Context7 via MCP | configure MCP; no plugin needed |
| eli5 | skill-only | Ship the ELI5 skill. It provides prompt guidance, not executable behavior. | none mature | port ours |
| find-tools | extension | Register `find_tools_scan` for bounded catalog search and local inventory (`plugins/find-tools/opencode/src/index.ts:52-100`). Configure permission-system bash rules for installer prompts. OpenCode asks before selected installers (`plugins/find-tools/opencode/src/install-gate.ts:160-220`). | pi-vetter (2★) | port ours |
| journeys | subagent-package | Install `pi-subagents` and ship journey agents. Bundle the Python index/lint/prune helper and formula installer as skill scripts (`plugins/journeys/opencode/src/index.ts:63-72,74-166,169-181`). Configure permission-system rules for destructive prune commands. | none | port ours later |
| lang-go | skill-only | Ship the Go guidance skills. The plugin has no runtime behavior. | none mature | port ours |
| lang-python | skill-only | Ship the Python guidance skills. The plugin has no runtime behavior. | none mature | port ours |
| lang-rust | skill-only | Ship the Rust guidance skills. The plugin has no runtime behavior. | none mature | port ours |
| lang-typescript | skill-only | Ship the TypeScript guidance skills. The plugin has no runtime behavior. | none mature | port ours |
| lsp | config-only | Install `pi-lens` for LSP diagnostics and post-edit checks (`plugins/lsp/opencode/src/index.ts:22-106`). Its maintained Pi package supplies the integration. | pi-lens (adopt) | adopt pi-lens for post-edit diagnostics; keep LSP navigation via MCP until parity |
| model-roles | extension | `pi.on("tool_call")` routes role models for subagent spawns. `pi.on("tool_result")` records child models and outcomes. Register the role report tool. The source mutates subagent schema and handles routing/failure (`plugins/model-roles/opencode/src/index.ts:1335-1381,2112-2118,2378-2392`). pi-subagents supplies child sessions, not routing. | pi-subagents per-agent models | adopt+extend |
| modes | extension | `pi.on("tool_call")` enforces Git allowlists and resolved-path debug-write rules (`plugins/modes/opencode/src/index.ts:41-64`; `plugins/modes/opencode/src/git-guard.ts:190-347,420-495`; `plugins/modes/opencode/src/path-guard.ts:72-94`). Permission patterns cover common commands, not scratch paths or branch ownership. Ship agents with pi-subagents. | @narumitw/pi-plan-mode (partial) | port ours after subagents |
| parley | extension | Register `parley_ask`, `parley_wait` and `parley_end`, plus a resumable multi-round UI. The OpenCode plugin persists rounds, handles wait/cancel/deliver and takes over the question tool only while a TUI is attached (`plugins/parley/opencode/src/index.ts:33-59,66-145,156-213`; `plugins/parley/opencode/README.md:37-41,291-297`). `@juicesharp/rpiv-ask-user-question` supplies a one-shot questionnaire, not the round lifecycle. | @juicesharp/rpiv-ask-user-question (partial) | keep ours; rpiv-ask-user-question is not a replacement |
| plugin-audit | skip | Skip this audit of the OpenCode plugin monorepo's packages and release files (`plugins/plugin-audit/opencode/src/index.ts:82-130`). | none | skip |
| project | config-only | Ship the scaffold skill and expose it as `/new-project`. OpenCode's command only submits a prompt that loads the skill (`plugins/project/opencode/src/index.ts:10-18,21-39`). Pi prompt templates provide slash commands (`pi docs/prompt-templates.md:3-19`). | none | port ours |
| quality | skill-only | Ship standards as skills or `AGENTS.md` context. Bundle report parsers as quality-skill scripts. OpenCode injects standards and registers bounded, read-only parsers (`plugins/quality/opencode/src/standards.ts:4-18,55-73`; `plugins/quality/opencode/src/test-audit.ts:115-183`; `plugins/quality/opencode/src/audit-util.ts:70-90`). | none | port ours: skills first |
| repomix | skill-only | Ship the CLI workflow as a skill and run `repomix` with `bash`. The skill uses an empty config, temp output and secret scan (`plugins/repomix/opencode/skills/repomix/SKILL.md:54-66`; `plugins/repomix/opencode/src/pack.ts:24-30,151-174,324-360`). Configure permission rules to ask before `npx`. | pi-repomix (0★) | port ours |
| safety | extension | Preserve semantic gates, redaction and secret storage with an extension. Use `tool_call`, `tool_result` and `registerTool("safety_secret_store")` (`plugins/safety/opencode/src/index.ts:347-401,494-565,651-673`). Use `@gotgenes/pi-permission-system` for basic command/path rules. | cc-safety-net (trial), @gotgenes/pi-permission-system (trial) | trial cc-safety-net for force-push, remote-exec and destructive git/fs; port ours for attribution, migrations, close-keyword, package vetting, redaction and secret store |
| session | config-only | Use `pi-sessions` for Pi-session search and handoff. OpenCode also reads API and OMP sessions (`plugins/session/opencode/src/source.ts:16-17,81-128,143-189`). Those formats are outside the Pi package's scope. | pi-sessions (adopt) | adopt pi-sessions; disable its subagents feature |
| speckit | extension | `pi.on("tool_call")` blocks writes to `specs/*/tasks.md` when Beads is active (`plugins/speckit/opencode/src/index.ts:202-218`; `plugins/speckit/opencode/src/tasks-guard.ts:12-13,73-105`). Register setup/start/commit tools (`plugins/speckit/opencode/src/index.ts:154-200`). Ship skills and agents separately. | pi-spec (partial) | port ours later |
| statusline | config-only | Pi's default footer shows folder, session, model, context, usage and cost (`pi docs/usage.md:9,25`). Install `@narumitw/pi-statusline` for a richer Git/activity layout. OpenCode adds a composer slot (`plugins/statusline/opencode/src/tui.tsx:139-147`). | @narumitw/pi-statusline (adopt) | adopt theirs |
| subagent-worktree | subagent-package | Install `pi-subagents` with worktree isolation (`worktreeProvider auto`). Ship merge and lifecycle guidance as skills. The OpenCode plugin extends subagent calls and adds merge/sweep tools (`plugins/subagent-worktree/opencode/src/index.ts:67-84,1114-1167`). | pi-subagents worktree mode (`worktreeProvider auto`) | adopt pi-subagents; keep wt merge as the lead-owned merge step |
| toolchain | skill-only | Ship the toolchain guidance skills. The plugin has no runtime behavior. | none | port ours |
| trunk-dev | extension | `pi.on("tool_call")` blocks non-conventional commits and protected-branch pushes (`plugins/trunk-dev/opencode/src/index.ts:91-103`; `plugins/trunk-dev/opencode/src/commit-gate.ts:235-255`). `pi.on("tool_result")` appends merge and skip-CI advisories (`plugins/trunk-dev/opencode/src/index.ts:105-139`; `plugins/trunk-dev/opencode/src/skip-ci.ts:1-4`). | none | port ours |
| whats-new | subagent-package | Install `pi-subagents` and ship the report-only researcher definition. Bundle dependency inventory as a skill script. The plugin registers a scan, agent prompt and report-only permissions (`plugins/whats-new/opencode/src/index.ts:12-18,52-99`). | none | port ours |
| worktrunk | extension | `pi-worktrunk` supplies Worktrunk commands. Add `pi.on("tool_call")` for the merge-history invariant. Non-default `wt merge` targets need `--no-squash --no-ff` and validated worktree context (`plugins/worktrunk/opencode/src/index.ts:54-97`; `plugins/worktrunk/opencode/src/merge-gate.ts:170-206`). | pi-worktrunk (86/wk) | port ours; OMP worktrunk extension is prior art |

### Safety gate mapping

| Safety behavior | Minimum Pi implementation | OpenCode basis |
|---|---|---|
| Destructive shell | **Mixed.** Use permission-system `deny` for literal `rm -rf *` and `ask` for `sudo *`. Use `pi.on("tool_call")` for stash/reset/worktree risk that depends on Git probes (`plugins/safety/opencode/src/guards.ts:338-384`; `plugins/safety/opencode/src/permission.ts:175-219`). |
| Remote-exec | **Extension.** `pi.on("tool_call")` detects fetch-to-shell, substitution, `eval`, stdin scripts and wrappers. Bash patterns can deny common literal forms such as `curl * | sh`, but cannot replace parsing (`plugins/safety/opencode/src/guards.ts:122-163,338-354`). |
| Attributed commands | **Extension.** `pi.on("tool_call")` inspects parsed commit messages, including files and here-documents, and blocks assistant attribution (`plugins/safety/opencode/src/guards.ts:167-202,235-261,347-352`). |
| Shipped-migration edits | **Extension.** `pi.on("tool_call")` finds migration writes and compares each file with the merge base. Path patterns cannot establish that a migration shipped (`plugins/safety/opencode/src/index.ts:393-402`; `plugins/safety/opencode/src/migrations.ts:125-150`). |
| External directories | **Config, plus an extension for dynamic exceptions.** `external_directory: ask` covers outside-CWD file and Bash path tokens, including command-specific directory flags. `pi.on("tool_call")` is only needed to selectively grant the session/repository roots or worktrees (`plugins/safety/opencode/src/index.ts:372-387,469-481`; `plugins/safety/opencode/src/flag-directories.ts:1-6,23-36,123-139`; permission-system configuration docs, Bash and `external_directory` surfaces). |
| Secret redaction | **Extension.** `pi.on("tool_result")` redacts nested result and error content using environment secrets. Permission rules control access, not output redaction (`plugins/safety/opencode/src/index.ts:651-673`; `plugins/safety/opencode/src/redact.ts:49-79,102-128`). |
| Secret-store tool | **Extension.** `registerTool("safety_secret_store")` keeps values out of arguments, environment, logs and transcript. It validates destinations and asks separately for store and command permission (`plugins/safety/opencode/src/index.ts:494-565`; `plugins/safety/opencode/src/secret-store.ts:19-29,320-321,545-618`). |
| Package vetting | **Skill-only** for this plugin. The hook appends an advisory after a persistent scanner install (`plugins/safety/opencode/src/index.ts:484-492`; `plugins/safety/opencode/src/package-investigate.ts:1-6,27-28`). Use `pi-vetter` for Pi package installs. |

### Summary

| Pi verdict | Plugins |
|---|---:|
| skill-only | 10 |
| config-only | 7 |
| extension | 16 |
| subagent-package | 10 |
| **Port candidates** | **43** |
| skip (existing X rows) | 2 |
| **Total table rows** | **45** |

The 36 former E/D rows resolve to 3 skill-only, 7 config-only, 16 extension and 10 subagent-package. Seven former S rows join skill-only.

## How to port

1. **Add a `pi` harness target.** harness-kit owns cross-harness generation. Add `pi` to `KNOWN_HARNESSES` (`harness-kit/src/config.ts`). Generate `plugins/<name>/pi/` with skills, prompts and listed extensions. Add the `pi-package` keyword and resource key in `package.json` (`harness-kit/src/generate.ts`). Follow `scripts/build-claude.ts`. Pi loads TypeScript extensions directly.
2. **Ship skill-only and config-only plugins without local extensions.** Skill-only (10): debate, eli5, lang-go, lang-python, lang-rust, lang-typescript, ast-grep, quality, repomix, toolchain. Config-only (7): agent-seance (`pi-sessions`), aws (AWS MCP), docs (Context7/OpenAI Developer Docs MCP), lsp (`pi-lens`), project (prompt template), session (`pi-sessions`) and statusline (`@narumitw/pi-statusline`).
   These packages target Pi sessions. Port other formats only if required. Run CLI skills with `bash`; use permission-system for ordinary command/path rules.
3. **Write the 16 local extensions.** `agent-efficiency` blocks oversized reads and foreground sleep. `autopilot` registers tools and a command, then hooks tool and session events. `beads` hooks tool calls/results for actor, store and claim lifecycle. `cad` registers tools and cleans up jobs at shutdown. `chezmoi` blocks writes to managed targets.
   `code-challenge` registers scan, validate and facts tools with pre-run consent. `delivery` registers land/cleanup tools and checks heads and receipts. It also reads child verdicts. `dep-update` registers scan/apply tools and asks before bumps. `find-tools` registers its catalog scan. `model-roles` routes subagent models and records outcomes. `modes` enforces Git and debug-write boundaries.
   `parley` registers ask/wait/end tools and a resumable round UI. `speckit` blocks active-Beads `tasks.md` writes. `trunk-dev` gates commits/pushes, then adds advisories. `worktrunk` enforces merge-history rules. The table cites each source contract.
4. **Install subagent packages for the ten subagent-package rows.** Use `pi-subagents` for agent-coder, agent-mechanic, agent-researcher, agent-reviewer, architecture, build, design, journeys and whats-new. Use `pi-subagents` with worktree isolation for subagent-worktree. Ship agent definitions as package resources. Ship remaining guidance as skills or MCP config.
5. **Keep the two skips.** Do not port claude-compat or plugin-audit. Retain the existing separate-package evaluation and skip recommendations.

## harness-kit pi target

#### Ordered change list

1. **`src/config.ts`: M.** Add `pi` to `KNOWN_HARNESSES` and `Harness`, so config and plugin metadata validation accept the target and retain canonical ordering (`src/config.ts:9-15,45-49,79`; `src/generate.ts:94-123,146-156`). Add inventory kinds for Pi `prompts` and `themes` if they are to be reported distinctly. Keep the existing default-kind set stable; Pi-enabled repositories can opt into the new kinds explicitly.
2. **`src/generate.ts`: L.** Add Pi to common-content copying, target variants, generated manifests, inventories, and drift/stale-file handling (`src/generate.ts:291-318,362-390,451-504,510-563,634-686`). Generate `plugins/<name>/pi/package.json` with a `pi` resource manifest only for resources actually present. Do not generate a Pi marketplace: Pi installs packages from a local path, npm, or git, rather than using the Claude/OMP marketplace output (`src/generate.ts:608-658`; [Pi package docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)).
3. **`src/validate-pi.ts`: M, new.** Add static validation for the generated Pi package manifest and its declared paths: valid JSON, resource paths that exist, and skill paths containing `SKILL.md`. Validate extension paths without loading or executing the extension.
4. **`src/cli.ts`: M.** Add `validate-pi` and run it from `check` alongside generation-drift checking and Claude validation (`src/cli.ts:14-22,108-127`). Keep the Pi validation static so CI does not need to install Pi or execute plugin code.
5. **`tests/config.test.ts`: S.** Cover the new harness and inventory-kind configuration, while confirming the legacy defaults remain unchanged (`tests/config.test.ts:12-64`).
6. **`tests/generate.test.ts`: M.** Cover generated Pi manifests, common-content copies, Pi inventory entries, and stale-file detection/removal (`tests/generate.test.ts:29-85,321-360,527-619`).
7. **Fixture files: S each.** Add Pi to `tests/fixtures/repo/harness-kit.json` and `plugins/demo/package.json`; add a small native extension fixture under `plugins/demo/pi/extensions/`. The existing fixture defines harnesses on both the repo config and plugin metadata (`tests/fixtures/repo/harness-kit.json:1-10`; `tests/fixtures/repo/plugins/demo/package.json:5-21`).
8. **`src/cli.ts`, `tests/cli.test.ts`, and `tests/validate-pi.test.ts`: M each.** Test the new check/command path, valid packages, and missing or malformed declared resources. The current CLI tests establish exit-code and fake-validator patterns (`tests/cli.test.ts:89-152`).
9. **`release.config.js` and `tests/release-config.test.ts`: S each.** Add `pi/**` to default release assets so native sources and generated Pi manifests ship with a release (`release.config.js:15-44`; `tests/release-config.test.ts:18-42`). A consumer release config that overrides `assets` must include `pi/**` itself.
10. **`README.md`: M.** Document Pi as a target, the generated package layout, which common resources map to Pi resources, static validation, and the limits of package-carried rules (`README.md:21-67,115-145`).

#### Generated package shape and plugin sources

A generated tree can look like:

```text
plugins/<name>/pi/
  package.json
  skills/
  prompts/
  themes/
  extensions/
  scripts/       # only when needed as skill support files
  formulas/      # only when needed as skill support files
```

Its manifest should list only resources that exist, for example:

```json
{
  "name": "<name>-pi",
  "version": "0.0.0",
  "private": true,
  "pi": {
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"],
    "extensions": ["./extensions"]
  }
}
```

Pi’s manifest uses `extensions`, `skills`, `prompts`, and `themes`; the `pi-package` keyword is only needed for gallery discovery. Skill-only plugins can ship their `SKILL.md` files and supporting static files without JavaScript or a JS build. Plugins that need tools, hooks, or UI need **Pi-native extension sources** under `pi/extensions/`; OpenCode entry points are not Pi extensions and should not be compiled as if they were. Pi loads JavaScript/TypeScript extensions from package resources and supplies its host API; extension dependencies still need to follow Pi’s package dependency rules ([Pi package format and dependencies](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)).

Rules are a packaging gap: Pi supports persistent `AGENTS.md` and `APPEND_SYSTEM.md` context files, but its package manifest has no `rules` resource. A rule-only plugin therefore needs its text installed into Pi’s persistent context, or a separately authored Pi extension to inject it. Merely copying a `rules/` folder into a Pi package does not make those rules load.

Pi’s 1.6.0 package documentation shows `pi install ./local-package`, but documents neither an install dry run nor a package-manifest schema; installing also changes package settings. That is unsuitable for a repeatable `harness-kit check`. Use the static validator above; do not run `pi install` as a check (`Pi package docs`; [Pi CLI package commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)).

#### Adoption by plugin repository

- **`harness-plugins`:** Add Pi to its root `harness-kit.json` and to each selected plugin’s harness metadata. Its own build script currently emits OpenCode and Claude outputs, so Pi extensions should be authored as Pi-native files rather than expected from that build (`harness-plugins/harness-kit.json:14-17`; `harness-plugins/scripts/build.ts:11-18,119-139`). Its typecheck includes `plugins/**/*.ts`, covering native extension sources (`harness-plugins/tsconfig.json:14-22`).
- **The internal plugin repo:** Enable Pi in the root config and selected plugin manifests; add each Pi package’s skill and native extension sources. Its release config overrides assets, so add `pi/**` there (`harness-kit.json:1-10`; `release.config.mjs:4-7`).
- **The private plugin repo:** Enable Pi in the root config and selected plugin manifests; use Pi skills for skill-only plugins and persistent Pi context for config-only rules. Its release config uses the shared preset, so the harness-kit default asset update should cover Pi trees unless a later override is added (`harness-kit.json:1-10`; `release.config.mjs:1-6`).

## Package reviews

Detailed reviews behind the recommended stack, as of 2026-11-23. Metrics are npm and GitHub snapshots. `unverified` marks claims not checked against a primary source.

- [Base package stack](pi/base-stack.md)
- [Safety: cc-safety-net vs our safety plugin](pi/safety.md)
- [Orchestration and subagents](pi/orchestration.md)
- [Orchestration stack decision](pi/orchestration-stack.md)
- [MCP, web, context and memory](pi/mcp-web-context.md)
- [UI, planning and interaction](pi/ui-planning.md)
- [Code tools, browser and beads](pi/code-tools-beads.md)
- [Ecosystem survey](pi/ecosystem-survey.md)
- [Plugin adoption](pi/plugin-adoption.md)
- [Spikes](pi/spikes.md)
