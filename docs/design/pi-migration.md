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

Pi has no registry of its own. Publish one Apache-2.0 npm package per plugin under `@srobroek`, named `@srobroek/pi-<feature>`. Install a published version with:

```bash
pi install npm:@srobroek/pi-<feature>@<version>
```
Use these descriptive names where the feature differs from the plugin name: build → `pi-external-repo-worker`, aws → `pi-aws-guidance`, quality → `pi-code-quality`, journeys → `pi-user-journeys`, beads → `pi-beads-enforcer`, trunk-dev → `pi-trunk-dev-policy`, worktrunk → `pi-worktrunk-merge-policy`, chezmoi → `pi-chezmoi-editor`, parley → `pi-parley-rounds`, modes → `pi-agent-modes`. Publish project secrets as `pi-project-secrets` and the safety secret-store tool as `pi-secret-store`. Publish through the npm CLI using OIDC trusted publishing, without lifecycle scripts. Declare CLI prerequisites and companion packages in `agent-plugins.prerequisites` and `agent-plugins.companions`; harness-kit 1.9.0 generates `_kit/prereqs.ts` to check them at session start.

| Catalog | Kind |
|---|---|
| [pi.dev/packages](https://pi.dev/packages) | Official gallery of npm packages with the `pi-package` keyword. A listing is not an endorsement. |
| [awesome-pi](https://github.com/BubblePtr/awesome-pi) | Community list |
| [Pi Package Index](https://github.com/getpipher/pi-package-index) | Unofficial ranking by downloads, stars and upkeep |

## Recommended stack

Status as of 2026-11-23. Adopt: installed on every Pi host and seeded by the dotfiles. Pending entries require a spike. One package owns each surface. Evidence: [package reviews](#package-reviews) and [spikes](pi/spikes.md).

| Capability | Pick | Install | Replaces or affects ours | Status |
|---|---|---|---|---|
| Subagents and scripted workflows | pi-subagents | `pi install npm:pi-subagents` | dispatch mechanism for agent-* plugins, build, subagent-worktree and design/code-challenge/speckit/delivery fan-out; our policies, Beads flows and landing proof stay | adopt |
| MCP | pi built-in MCP, `exposure: "deferred"` | `~/.pi/agent/mcp.json` | docs, aws (server registration only) | adopt |
| Web search and fetch | pi-web-access | `pi install npm:pi-web-access`; provider order in `~/.pi/agent/web-search.json`, keys `EXA_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `TINYFISH_API_KEY` from the shell environment | none | adopt |
| Browser | pi-agent-browser-native | `pi install npm:pi-agent-browser-native` | none | adopt |
| Beads context and recovery | pi-beads-companion | `pi install npm:pi-beads-companion` | beads context (partial); our gates stay as an extension | adopt |
| Plan mode | @narumitw/pi-plan-mode | `pi install npm:@narumitw/pi-plan-mode` | modes plan reminders (partial) | adopt |
| Plan and code review UI | @plannotator/pi-extension (its own `/plannotator-plan-mode` and Ctrl+Alt+P cannot be disabled; use `/plan`) | `pi install npm:@plannotator/pi-extension` | none | adopt |
| Todo list | @juicesharp/rpiv-todo | `pi install npm:@juicesharp/rpiv-todo` | none | adopt |
| Footer | @narumitw/pi-statusline | `pi install npm:@narumitw/pi-statusline` | statusline | adopt |
| Session search and handoff | pi-sessions (its `subagents` feature off) | `pi install npm:pi-sessions` | session, agent-seance | adopt |
| Destructive-command gate | cc-safety-net | Configured by dotfiles; loaded first and unpinned | safety baseline; our extension keeps the workflow gates and overlapping guards | adopt |
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
- Quality, Repomix and Journeys tools.

Skipped:
```text
- `@gotgenes/pi-permission-system`, a general policy engine, was evaluated and dropped by the owner.
- `@onkernel/browser-loop` needs a Kernel cloud-browser key and has no Bedrock adapter.
- `@agimon-ai/po-hashline` and `@agimon-ai/po-grep` are BUSL-1.1; their protocol does not match Pi 1.6 built-in tools.
```
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
`cc-safety-net` is the baseline gate on Pi and OMP, loaded first and unpinned, with rulebooks and policy configured by the dotfiles. Our safety extension keeps its own overlapping guards; it has no on/off switch. Keep cc-safety-net's six Git rules enabled until our safety package is installed on every host.

## Herdr

Herdr 0.9.5 supports pi natively. `herdr integration install pi` writes `~/.pi/agent/extensions/herdr-agent-state.ts`, which reports pane state and the session identity over the herdr socket. It matches the OpenCode integration (`pane.report_agent` with `working`, `blocked` and `idle`). The omp label extensions (`agents.subs`, `agents.tasks`, `agents.todo` through `hc label`) have no pi counterpart. Port them only after choosing a subagent and todo package, because their data comes from those packages.

## Plugin portability

The per-plugin decisions after the package adoption and the spikes are in [plugin adoption](pi/plugin-adoption.md). It supersedes this table where they differ. This table keeps the first-pass classification by mechanism.

Pi skills can bundle scripts and run CLIs with `bash` ([skills](https://pi.dev/docs/latest/skills)). Pi also documents [MCP](https://pi.dev/docs/latest/mcp), [prompt templates](https://pi.dev/docs/latest/prompt-templates), [sessions](https://pi.dev/docs/latest/sessions) and the default footer ([usage](https://pi.dev/docs/latest/usage)).

| Verdict | Meaning |
|---|---|
| **skill-only** | Ship skills. Bundle only the approved scripts listed in the port plan. Use Pi tools or `bash` for commands. |
| **config-only** | Configure Pi, MCP or context, or install the named Pi package. No local extension. |
| **extension** | Use Pi hooks or tools to preserve a real tool, UI or hard invariant. |
| **subagent-package** | Install the named subagent package and ship agent definitions. Other behavior is skill-only or config-only. |
| **skip** | Do not port a plugin marked skip. |

The existing-equivalent column names packages with related features. It does not certify safety or parity. [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) supports allow, ask and deny rules for bash patterns and paths. Its path rules also cover MCP tools. `external_directory` controls access outside the working directory. These patterns cannot express repository state or semantic checks.

| Plugin | Pi verdict | Pi mechanism and OpenCode reason | Existing pi equivalent | Recommendation |
|---|---|---|---|---|
| agent-coder | subagent-package | Install `pi-subagents` and ship the coder prompt as an agent definition. The wrapper registers content only (`plugins/agent-coder/opencode/src/index.ts:1-3`). The prompt defines the coding role (`plugins/agent-coder/opencode/agents/coder.md:141-155`). | pi-subagents `worker` | adopt+extend: port the prompt as an agent file |
| agent-efficiency | extension | `pi.on("tool_call")` blocks oversized whole-file reads and foreground `sleep` (`plugins/agent-efficiency/opencode/src/index.ts:66-76,87-123`; `plugins/agent-efficiency/opencode/src/large-read.ts:214-249`; `plugins/agent-efficiency/opencode/src/wait.ts:26-29`). Other reminders can be skills. Delegate with pi-subagents. | none | port ours |
| agent-mechanic | subagent-package | Install `pi-subagents` and ship the mechanic prompt as an agent definition. The wrapper only registers content (`plugins/agent-mechanic/opencode/src/index.ts:1-3`). The prompt defines the bounded worker (`plugins/agent-mechanic/opencode/agents/mechanic.md:54-68`). | pi-subagents | adopt+extend |
| agent-researcher | subagent-package | Install `pi-subagents` and ship the researcher definition. Its code registers that agent and tool grants (`plugins/agent-researcher/opencode/src/index.ts:20-29`). The prompt defines scoped research (`plugins/agent-researcher/opencode/agents/researcher.md:78-90`). Use pi-web-access for external research. | pi-subagents with pi-web-access | adopt+extend |
| agent-reviewer | subagent-package | Install `pi-subagents` and ship the read-only reviewer agent definitions. Name its security agent `security-auditor`; retain hidden `review-security` material as a skill. | Piolium (usable) | port ours: skill now, agents after subagents |
| agent-seance | config-only | Use `pi-sessions` to search and read Pi-session transcripts. OpenCode registers a read-only session tool (`plugins/agent-seance/opencode/src/index.ts:18-54`). The Pi package covers Pi sessions. | pi-session-search (Pi sessions only) | adopt pi-sessions |
| architecture | subagent-package | Install `pi-subagents` and ship the architect definition. The plugin only registers content (`plugins/architecture/opencode/src/index.ts:1-3`). Ship guidance as skills. | none mature | port ours: skills first |
| autopilot | extension | Port the full extension: register status/log/merge/review tools and `/autopilot`. Use `pi.on("tool_call")` and session hooks for run enforcement and unattended ticks. The source owns run state, permissions and recovery (`plugins/autopilot/opencode/src/index.ts:1399-1478`). | @narumitw/pi-goal (usable) | port full extension |
| aws | config-only | Configure the AWS MCP server in `mcp.json`. Ship AWS guidance as skills (`plugins/aws/opencode/src/index.ts:10-30`). Pi includes MCP support (`pi docs/mcp.md:3-32`). | built-in MCP plus the AWS MCP server | port ours (skill) and configure MCP |
| beads | extension | `pi.on("tool_call")` enforces actor, store and claim gates. `pi.on("tool_result")` reconciles claims and subagent lifecycle. The source pins shell state and gates mutations (`plugins/beads/opencode/src/index.ts:244-299,304-320,428-480`). | pi-beads-companion (adopt) | adopt pi-beads-companion for context; port our gates as an extension |
| chezmoi | extension | `pi.on("tool_call")` refuses writes to managed live targets and allows seed-once targets (`plugins/chezmoi/opencode/src/index.ts:12-26`; `plugins/chezmoi/opencode/src/guard.ts:1-11,91-164`). Static path rules cannot resolve chezmoi state. | none | port ours (high value) |
| claude-compat | skip | Evaluate the separate `pi-claude-marketplace` package instead of porting this OpenCode compatibility loader. | pi-claude-marketplace | skip ours; evaluate theirs |
| code-challenge | extension | Register scan, validation and facts tools. The tool asks before configured or downloaded analyzers run (`plugins/code-challenge/opencode/src/index.ts:58-104`; `plugins/code-challenge/opencode/src/scan/index.ts:114-169`). Validation confines run files to repository Git metadata (`plugins/code-challenge/opencode/src/validate.ts:83-123`). Ship challenge agents with pi-subagents. | pi-simplify (partial) | port ours later |
| debate | skill-only | Ship the debate skills. The prompt workflow needs no separate tool or agent runtime. | pi-subagents `/council` (partial) | port ours |
| delivery | extension | Port the full extension, including `delivery_land` and `delivery_cleanup` (`plugins/delivery/opencode/src/index.ts:356-417`). `delivery_land` proves that the PR merged the reviewed head and writes a receipt. `delivery_cleanup` checks the receipt and verifies read-only that linked Beads are already closed with a matching `merge_sha`; it does not remove worktrees. Use Worktrunk `wt remove` or `wt step prune` for worktree removal. | none equivalent | port full extension |
| dep-update | extension | Register parsed `dep_scan` and `dep_apply` tools. Use `pi.on("tool_call")` to ask before applying a bump. The source validates operands and bounds updates (`plugins/dep-update/opencode/src/index.ts:80-155`). | pi-dep-audit (partial) | port ours |
| design | subagent-package | Install `pi-subagents` for the design agents; ship the other material as skills. Keep only approved scripts in the extension bundle, including the required formula installer and consented Impeccable scan (`plugins/design/opencode/src/index.ts:86-137`; `plugins/design/opencode/src/impeccable.ts:11-15,185-203`; `plugins/design/opencode/src/formulas.ts:28-32`). Configure Storybook MCP in `mcp.json`. | Impeccable skills (partial) | port our skills and required tools |
| eli5 | skill-only | Ship the ELI5 skill. It provides prompt guidance, not runtime behavior. | none mature | port ours |
| lang-rust | skill-only | Ship the Rust guidance skills. The plugin has no runtime behavior. | none mature | port ours |
| journeys | extension | Keep `journeys_index` and `journey_install_formulas` as Pi tools over existing TypeScript modules (`plugins/journeys/opencode/src/journeys-tool.ts:36-64`); wrap the existing `journeys.py` script for index/lint/prune. | none | port tools and scripts |
| lang-go | skill-only | Ship the Go guidance skills. The plugin has no runtime behavior. | none mature | port ours |
| lang-python | skill-only | Ship the Python guidance skills. The plugin has no runtime behavior. | none mature | port ours |
| lang-typescript | skill-only | Ship the TypeScript guidance skills. The plugin has no runtime behavior. | none mature | port ours |
| model-roles | skip | Pi does not need a model-roles extension: `pi-subagents` agent definitions carry per-agent `model` fields. | pi-subagents per-agent models | drop for Pi |
| modes | extension | `pi.on("tool_call")` enforces Git allowlists and resolved-path debug-write rules (`plugins/modes/opencode/src/index.ts:41-64`; `plugins/modes/opencode/src/git-guard.ts:190-347,420-495`; `plugins/modes/opencode/src/path-guard.ts:72-94`). Permission patterns cover common commands, not scratch paths or branch ownership. Ship agents with pi-subagents. | @narumitw/pi-plan-mode (partial) | port ours after subagents |
| parley | extension | Register `parley_ask`, `parley_wait` and `parley_end`, plus a resumable multi-round UI behind one panel module that isolates `pi-tui` and `ctx.ui.custom`, so an OMP variant can replace it. Preserve rounds, wait/cancel/delivery and attached-UI-only takeover (`plugins/parley/opencode/src/index.ts:33-59,66-145,156-213`). | @juicesharp/rpiv-ask-user-question (partial) | port shared panel seam |
| project | config-only | Ship the scaffold skill and expose it as `/new-project`. OpenCode's command only submits a prompt that loads the skill (`plugins/project/opencode/src/index.ts:10-18,21-39`). Pi prompt templates provide slash commands (`pi docs/prompt-templates.md:3-19`). | none | port ours |
| quality | extension | Port `quality_test_summarize` and `quality_test_compare` as Pi tools over existing TypeScript modules (`plugins/quality/opencode/src/test-audit.ts:115-183`; `plugins/quality/opencode/src/audit-util.ts:70-90`). Keep standards as skills or `AGENTS.md` context. | none | port tools and skills |
| repomix | extension | Port `repomix_pack` as a Pi tool over its existing TypeScript module (`plugins/repomix/opencode/src/pack.ts:24-30,151-174,324-360`); keep the CLI as fallback. | pi-repomix (0★) | port tool; CLI fallback |
| safety | extension | Same safety bundle on Pi and OMP. Keep cc-safety-net first and unpinned, plus overlapping guards with no switch. | cc-safety-net is baseline only; host-specific gates are private. | keep our gates and secret-store tool |
| session | config-only | Use `pi-sessions` for Pi-session search and handoff. OpenCode also reads API and OMP sessions (`plugins/session/opencode/src/source.ts:16-17,81-128,143-189`). Those formats are outside the Pi package's scope. | pi-sessions (adopt) | adopt pi-sessions; disable its subagents feature |
| speckit | extension | `pi.on("tool_call")` blocks writes to `specs/*/tasks.md` when Beads is active (`plugins/speckit/opencode/src/index.ts:202-218`; `plugins/speckit/opencode/src/tasks-guard.ts:12-13,73-105`). Register setup/start/commit tools (`plugins/speckit/opencode/src/index.ts:154-200`). Ship skills and agents separately. | pi-spec (partial) | port ours later |
| statusline | config-only | Pi's default footer shows folder, session, model, context, usage and cost (`pi docs/usage.md:9,25`). Install `@narumitw/pi-statusline` for a richer Git/activity layout. OpenCode adds a composer slot (`plugins/statusline/opencode/src/tui.tsx:139-147`). | @narumitw/pi-statusline (adopt) | adopt theirs |
| subagent-worktree | subagent-package | Use pi-subagents worktree isolation for child worktrees within a run. It does not replace PR landing. The OpenCode plugin adds spawn transformation, one-writer/lane tracking, merge and sweep tools (`plugins/subagent-worktree/opencode/src/index.ts:67-84,1114-1167`). | pi-subagents worktree mode (`worktreeProvider: "auto"`) | adopt pi-subagents for child worktrees; landing stays in delivery |
| toolchain | skill-only | Ship the toolchain guidance skills. The plugin has no runtime behavior. | none | port ours |
| trunk-dev | extension | `pi.on("tool_call")` blocks non-conventional commits and protected-branch pushes (`plugins/trunk-dev/opencode/src/index.ts:91-103`; `plugins/trunk-dev/opencode/src/commit-gate.ts:235-255`). `pi.on("tool_result")` appends merge and skip-CI advisories (`plugins/trunk-dev/opencode/src/index.ts:105-139`; `plugins/trunk-dev/opencode/src/skip-ci.ts:1-4`). | none | port ours |
| build | subagent-package | Install `pi-subagents` and ship the external-repository worker definition. Preserve caller-root/target-root checks and the publish boundary; do not use same-repository worktree allocation for external clones. | pi-subagents | port as external-repo-worker agent |
| ast-grep | skill-only | Ship the existing skill; Pi's `bash` tool can run the `ast-grep` CLI. Require the CLI on `PATH` when structural search is needed (`plugins/ast-grep/opencode/src/index.ts:47-60`). | Pi `bash` | port skill; no wrapper |
| docs | config-only | Configure Context7 and OpenAI Developer Docs directly in Pi's `mcp.json`; keep guidance in skills. | built-in MCP | merge server configuration; drop wrapper |
| lsp | config-only | Adopt pi-lens for diagnostics and post-edit feedback. Configure navigation separately only if required. | pi-lens | adopt pi-lens; optional navigation |
| whats-new | subagent-package | Install `pi-subagents` and ship the report-only researcher definition. Register `version_gap_scan` as read-only; bundle inventory guidance as a skill. | pi-subagents | port ours |
| find-tools | extension | Register `find_tools_scan` as a read-only tool and ask before separate installer commands (`plugins/find-tools/opencode/src/index.ts:52-100`). | none | port tool |
| plugin-audit | skip | Move the repository audit to harness-kit or a repository script; do not port a Pi plugin. | none | move to repository tooling |

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

| Pi verdict | Plugins |
|---|---:|
| skill-only | 8 |
| config-only | 7 |
| extension | 16 |
| **Port candidates** | **40** |
| skip (claude-compat, model-roles, plugin-audit) | 3 |
| **Total table rows** | **44** |



### harness-kit pi target

#### Ordered change list

1. **`src/config.ts`: M.** Add `pi` to `KNOWN_HARNESSES` and `Harness`, so config and plugin metadata validation accept the target and retain canonical ordering (`src/config.ts:9-15,45-49,79`; `src/generate.ts:94-123,146-156`). Add inventory kinds for Pi prompts and themes only if they need distinct reporting. Keep existing default kinds stable.
2. **`src/generate.ts`: L.** Add Pi to common-content copying, target variants, package manifests, inventories and drift/stale-file handling (`src/generate.ts:291-318,362-390,451-504,510-563,634-686`). Generate published per-plugin package manifests and resource declarations from `pi-src/`; do not generate a marketplace.
3. **`src/validate-pi.ts`: M, new.** Add static validation for generated package manifests and declared paths: valid JSON, existing resource paths, and skill paths containing `SKILL.md`. Validate extension paths without loading or executing them.
4. **`src/cli.ts`: M.** Add `validate-pi` and run it from `check` alongside generation-drift checking and Claude validation (`src/cli.ts:14-22,108-127`). Keep validation static so CI does not need to install Pi or execute extensions.
5. **`tests/config.test.ts`: S.** Cover the new harness and inventory-kind configuration, while confirming legacy defaults remain unchanged (`tests/config.test.ts:12-64`).
6. **`tests/generate.test.ts`: M.** Cover generated Pi manifests, common-content copies, Pi inventory entries, and stale-file detection/removal (`tests/generate.test.ts:29-85,321-360,527-619`).
7. **Fixture files: S each.** Add Pi to `tests/fixtures/repo/harness-kit.json` and `plugins/demo/package.json`; add a native extension fixture under the generated package tree (`tests/fixtures/repo/harness-kit.json:1-10`; `tests/fixtures/repo/plugins/demo/package.json:5-21`).
8. **CLI and validator tests: M each.** Cover the new check/command path, valid packages, and missing or malformed declared resources (`tests/cli.test.ts:89-152`).
9. **Release configuration: S.** Add Pi package sources and generated package assets to `release.config.js` and its tests (`release.config.js:15-44`; `tests/release-config.test.ts:18-42`). Consumers that override assets must include them.
10. **`README.md`: M.** Document Pi as a target, npm package layout, shared `pi-src/` source, prerequisite metadata/checks, and limits of package-carried rules (`README.md:21-67,115-145`).

#### Package sources and repository adoption

Author each TypeScript extension once in `plugins/<name>/pi-src/`; OMP 19.1.1 loads the same bundle. Put prerequisites and companion package names in plugin metadata. The generated `_kit/prereqs.ts` checks both at session start. Use one Apache-2.0 npm package per plugin under `@srobroek`, with descriptive names and the project-secrets and secret-store splits above. Publish through npm CLI OIDC trusted publishing. No lifecycle scripts, Git package installs, root manifests or settings extension filters.

Keep only `pace_init.py`, the Beads and Worktrunk `preflight.py` scripts, and `journeys.py` as scripts. Keep the quality, Repomix and Journeys TypeScript tools as extension tools.

- **`harness-plugins`:** Add Pi to the root `harness-kit.json` and selected plugin metadata. Build package artifacts from `pi-src/`; Pi and OMP 19.1.1 consume the same extension bundle. Generate prerequisite checks into `_kit/prereqs.ts`.
- **Other plugin repositories:** Use the same `pi-src/` convention and per-plugin Apache-2.0 npm publishing under `@srobroek`. Declare prerequisites and companion packages in plugin metadata. Do not add `omp-src/`, OMP-only extensions or lifecycle scripts.

Discovery:

| Catalog | Kind |
|---|---|
| [pi.dev/packages](https://pi.dev/packages) | Official gallery of npm packages with the `pi-package` keyword. A listing is not an endorsement. |
| [awesome-pi](https://github.com/BubblePtr/awesome-pi) | Community list |
| [Pi Package Index](https://github.com/getpipher/pi-package-index) | Unofficial ranking by downloads, stars and upkeep |

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
