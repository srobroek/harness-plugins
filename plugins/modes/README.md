# @srobroek/opencode-modes

This OpenCode plugin provides agents for work beyond building a feature: finding a root cause, restructuring code without behavior changes, and deciding what to build. OMP packages the same three agents as task agents; native `/plan`, plan review, `/goal`, and `/vibe` replace OpenCode mode switching and reminders. OMP cannot enforce agent-specific file-path limits, so those boundaries are prompt instructions rather than technical guards.

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

The following mode-switching and guard sections describe OpenCode-only behavior, not the OMP package.

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
