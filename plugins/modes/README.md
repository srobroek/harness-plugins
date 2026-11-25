# @srobroek/opencode-modes

This OpenCode plugin provides agents for work beyond building a feature: finding a root cause, restructuring code without behavior changes, and deciding what to build. OMP packages the same three agents as task agents; native `/plan`, plan review, `/goal`, and `/vibe` replace OpenCode mode switching and reminders. OMP cannot enforce agent-specific file-path limits, so those boundaries are prompt instructions rather than technical guards. The pi package ships the three agents for pi-subagents, a guard extension that enforces their limits, and a `/mode` command that switches the main session into one of them.

## Agents

| Agent | OpenCode mode | Model | Does |
| --- | --- | --- | --- |
| `debug` | `all` | strong | Diagnoses a failure to a confirmed root cause. Experiments in a scratch git worktree; never edits your checkout. Returns the root cause, a proposed fix and a failing regression test. |
| `refactor` | `primary` | standard | Behaviour-preserving refactoring in small verified steps. Cannot edit tests, fixtures or snapshots. |
| `concept` | `primary` | `@architect`, then `@slow` | Frames a problem, explores options, prototypes the riskiest, records a decision. Edits only design docs and scratch. |

`debug` has `mode: all`, so it is both a primary agent and a subagent other agents can spawn.

## OMP agents

OMP packages these as task agents. Native `/plan`, plan review, `/goal` and `/vibe` replace OpenCode's mode reminders and switching. Its package includes only the agents; skills remain those installed in the host. OMP does not enforce agent-specific file paths, so the prompt must be treated as the limit rather than a technical guard.

- `debug` must experiment only in a scratch worktree and must never write to the user's checkout. It retains `bash` and `eval` to run experiments; OMP cannot sandbox those tools to the scratch worktree.
- `refactor` must leave tests, fixtures and snapshots unchanged. OMP cannot enforce this restriction.
- `concept` may edit only `docs/design/`, `docs/adr/`, `docs/decisions/` and scratch paths. OMP cannot enforce this restriction.

The OMP package also receives the pi extension, because OMP loads pi extensions. On OMP the extension registers only `modes_status`: it adds no `/mode` command and no guard, since OMP's edit tool and task agents differ from pi's.

## pi

`@srobroek/pi-agent-modes` ships `debug`, `refactor` and `concept` as pi-subagents agents and the `modes` extension. It needs pi-subagents, pi-lens and pi-web-access. Plan mode stays with Plannotator (`/plannotator-plan-mode`): this package adds no plan state and no plan review.

### Agents

Each agent names its tools explicitly and loads the `modes` extension, pi-lens and pi-web-access through `subagentOnlyExtensions`. It uses `systemPromptMode: append` and inherits the project's context files and skills. Each agent also lists `modes_status`, a tool only the `modes` extension registers. pi-subagents checks every listed tool before a child's first turn, so a launch without the guard fails instead of running unguarded. The same check fails a launch whose `agentOverrides` drop the extension from `subagentOnlyExtensions`.

### `/mode`

`/mode debug`, `/mode refactor` and `/mode concept` put the main session in that role:

- The active tools become the mode's tool list.
- The mode's reminder and the agent's instructions arrive as one hidden message before the next turn. After compaction they arrive again.
- The guard checks every tool call.

`/mode off` restores the tools that were active before the first mode and tells the model the mode ended. The mode is stored on the session branch, so a resumed session and `/tree` keep it. `/mode` with no argument shows the current mode.

### Guard

The guard runs in a main session after `/mode`, and in a child launched as one of the three agents. pi-subagents tags each child's prompt with `<active_agent name="…"/>`, and the guard reads the mode from that tag. Children of other agents are not guarded. The guard fails closed: a tool outside the list, a target it cannot read, or an error refuses the call.

- **Tools.** Only the mode's list runs. pi-lens's `ast_grep_replace` and `lsp_navigation` are left out because they write files past the path checks. pi-subagents' child tools (`structured_output`, `contact_supervisor`, `intercom`, `bg_wait`) pass.
- **Rules.** The guard applies the OpenCode agent's `read`, `edit`, `external_directory`, `shell` and `subagent` permission rules with pi's paths. The last matching rule wins, and no match means ask. A test keeps the two rule sets in step.
- **Paths.** A path resolves the way pi's file tools resolve it (a leading `@`, `~` and `file://` URLs), and must pass both with symlinks followed and with `..` applied by name.
- **`debug`.** Writes go only to a `debug-<slug>` worktree and the ledger directory. Git runs from the OpenCode allowlist, git that writes runs only inside the scratch worktree, and before a commit the guard checks that the scratch HEAD is detached or on a `debug/<slug>` branch.
- **`refactor`.** Test, spec, fixture, testdata and snapshot paths are frozen. Git runs from refactor's allowlist.
- **`concept`.** Writes go only to `docs/design/`, `docs/adr/`, `docs/decisions/` and `~/.pi/concept/`. Read-only git and `python3 -m http.server` run freely; any other command needs approval.
- **Helpers.** `subagent` launches one named helper from the mode's list per call. Read-only actions such as `status` pass. Workflows are refused, because their scripts can start agents the guard cannot see.
- **Approval.** When a rule says ask, the main session shows a confirmation; a child cannot ask the user, so the call is refused.

| Path | OpenCode | pi |
| --- | --- | --- |
| `debug` worktrees | `~/.local/share/opencode/worktree/<hash>/debug-<slug>` | `~/.local/share/pi/worktree/<project>/debug-<slug>` |
| `debug` ledger | `~/.opencode/debug/` | `~/.pi/debug/` |
| `concept` scratch | `~/.opencode/concept/` | `~/.pi/concept/` |

`modes_status` reports the active mode, its tools and these paths resolved for the session.

### Limits on pi

- Only git and the file tools are path-checked. A script, a build or a shell redirect can still write anywhere, as on OpenCode.
- pi's `bash` has no working-directory option. A leading `cd <dir> &&` counts as the working directory when the rest of the line is chained with `&&` or pipes. `||`, `;`, `&` and newlines anywhere in the line keep it from counting, and git that writes is then refused.
- OpenCode asks before reads outside the project; pi does not.
- In the main session the active tool list only controls what the model sees; the guard is the boundary.
- The agents declare their own `subagentOnlyExtensions`, so `subagents.defaultSubagentOnlyExtensions` does not reach them. To run context-mode in them, see the agent-efficiency README.

The following mode-switching and guard sections describe OpenCode-only behavior.

### What makes an agent top level

An agent shows in the Tab cycle when its `mode` is `primary` or `all` and it is not `hidden`. Set `default_agent` in your config to start sessions in one. A `subagent` is reachable only through the `subagent` tool.

## Mode reminders

Modeled on OpenCode's plan mode. On a new session or an agent switch, the plugin stores a `<system-reminder>` as a synthetic user message:

- Entering a mode: what the mode does, where it may edit, and that it lasts until the user switches agents.
- Leaving a mode: the restrictions end.
- Mode to mode: leave, then enter.

Compaction and reverts can drop those messages. Every request therefore checks the history and adds a missing reminder before the last user prompt. The text is fixed per mode, so the prompt cache stays valid. Unlike core's Plan mode, it does not rewrite refused-edit errors, because the public plugin API does not export the blocked-edit error.

The helper lives in `@srobroek/opencode-lib/mode-reminders` (`defineMode`, `reminderFor`, `missingReminders`, `registerModeReminders`) for other plugins to reuse.

## Options

```json
{ "plugin": [["@srobroek/opencode-modes", { "agents": { "concept": false }, "reminders": true }]] }
```

- `agents.debug`, `agents.refactor`, `agents.concept`: register that agent. Default `true`.
- `reminders`: inject mode reminders. Default `true`.

## How they chain

```
concept -> spec / plan -> build / orchestrator -> refactor
debug -> build
```

`concept` ends in a decision record and hands off to `spec` (when `.specify/` exists) or `plan`. `debug` ends in a proposed fix and hands off to `build`. `refactor` runs on green code after the feature lands. On a red baseline it calls `debug`.

## Subagent depth

OpenCode limits subagent nesting with `experimental.subagent_depth`. The default is 1, so a subagent cannot start another one. `debug` is `mode: all`, so a caller may spawn it as a subagent. With the default depth it cannot spawn `explore` or `adversarial-challenger`. Set a higher depth (for example 3) if you want it to delegate. Each prompt tells the agent to do a refused helper's work itself and to say so in the report.

## Guards

Permission rules cannot see through git's global options, shell wrappers or `*` spanning `/`, so the plugin adds hooks for `debug` and `refactor`:

- A git allowlist. Only listed subcommands run. `push`, `clean`, `rebase`, `gc`, `stash drop|clear|pop|apply` and unknown spellings are refused. A command that mentions git and cannot be read statically is refused.
- For `debug`, mutating git runs only inside a `debug-*` scratch worktree. Read-only git can target any directory.
- For `debug`, `edit`, `write` and `patch` are allowed only inside a `debug-*` worktree and `~/.opencode/debug/`, after symlinks resolve.

A program that runs git itself (a script file, `make`, an npm script, a hook) is outside what static parsing can see.

## Permission notes

Subagents use their own permissions, so a primary agent's edit limits do not bind the writers it delegates to. Each prompt states the limit in the helper's brief. Each prompt then checks the result.
