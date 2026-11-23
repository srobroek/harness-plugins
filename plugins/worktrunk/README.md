# worktrunk

[Worktrunk](https://github.com/max-sixty/worktrunk) (`wt`) support for OpenCode V2. Ported from the
omp-plugins `worktrunk` package. The omp isolation precheck is not ported: OpenCode has no native
checkout-cloning isolation to refuse.

It does three things:

- Registers `wt` as OpenCode's worktree strategy.
- Gates `wt merge` shell calls so worker-to-epic merges keep their history.
- Ships two skills: `worktrunk-preflight` and `worktrunk-worktrees`.

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/worktrunk/opencode'
```

Claude Code install the skills from this repository's marketplace:

```sh
claude plugin marketplace add srobroek/harness-plugins
claude plugin install worktrunk@harness-plugins

```

Claude Code get the two skills only; the worktree strategy and merge gate are OpenCode code.

Needs `wt` and `git` on `PATH`. The preflight skill also needs `python3` (3.11 or later).

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `strategy` | `true` | `false` keeps OpenCode's bundled Git strategy. The merge gate and the skills stay on. |

```jsonc
{ "plugins": [{ "package": "...", "options": { "strategy": false } }] }
```

## Worktree strategy

Strategy id `worktrunk`. Adding it makes it OpenCode's default strategy; disposing the plugin
restores the previous one. Worktrees created before the plugin loaded keep their recorded owner.

| Operation | Command |
| --- | --- |
| create | `wt -C <source> switch -y --create --no-cd --base <ref> --format json <name>` |
| remove | `wt -C <directory> remove -y [--force] --foreground` |
| list | `wt -C <source> list --format json` |

- `<name>` is the last component of the directory OpenCode suggests, and becomes the new branch.
  `wt` picks the directory from its `worktree-path` template, and the strategy returns that path,
  so the worktree may not sit where OpenCode suggested. OpenCode's `worktree.directory` setting has
  no effect on this strategy.
- `<ref>` is the requested starting ref. Without one it is the source checkout's `HEAD` commit.
- Worktrunk hooks run as usual: `pre-start` hooks block creation, `post-start` hooks run in the
  background.
- `remove` deletes the branch only when `wt` considers it merged, and never deletes unmerged
  commits. A dirty worktree is refused with `forceRequired`, so OpenCode asks before forcing.
  Removing a directory that no longer exists does nothing.
- `list` reports the main worktree as `root` and every linked worktree as `worktree`.

## Merge policy gate

`execute.before` on the `shell` tool. It refuses:

- `wt merge <target>` to a target other than the default branch without both `--no-squash` and
  `--no-ff`;
- such a merge run from the target worktree, or from a detached `HEAD`, because `wt merge`
  merges the current branch;
- a merge it cannot check: the default branch cannot be resolved, a probe times out, or the
  command is unterminated or runs a merge stored in a variable (`cmd="wt merge x"; eval "$cmd"`).

`wt merge` with no target and merges to the default branch pass. The gate reads the default branch
from `wt config state default-branch`, then `origin/HEAD`, in the call's directory: the shell
`workdir` (resolved against the session directory), a leading `cd DIR &&`, or `wt -C DIR`. It
finds merges behind wrappers (`env`, `sudo`, `timeout`, ...), in `$(...)`, backticks, process
substitutions, `eval` and `sh -c`. `git merge` and `gh pr merge` are not gated.

## Skills

Registered with `ctx.skill.transform` from `skills/<name>/SKILL.md` in this package, so no copy step
is needed. `skills/` ships with the package (`files`), and both `src/` and the bundled `dist/`
resolve it as `../skills`. A skill with the same id that the host already has wins.

- `worktrunk-preflight`: `preflight.py` checks `wt`, hook approvals, ignored project-config keys,
  the default branch, merge evidence, provisioning hooks and `node_modules`. Read-only unless
  `--apply`. Python tests: `skills/worktrunk-preflight/test_preflight.py`, run by `bun test`. On pi
  the skill calls the `worktrunk_preflight` tool instead (below).
- `worktrunk-worktrees`: the worktree discipline from the omp rule `worktrunk-worktree-required`:
  create with `wt switch`, cut from the recorded base commit, use absolute paths, wait for
  provisioning, merge from the source worktree.

## pi

One extension, `pi/extensions/worktrunk.js` (source `pi-src/worktrunk.ts`). The merge gate and the
`wt switch` timeout share `shared/merge-gate.ts` and `shared/switch-timeout.ts` with OpenCode.

| Feature | pi hook | Behavior |
| --- | --- | --- |
| Merge policy gate | `tool_call` on `bash` | Returns `{ block: true, reason }` for every merge the OpenCode gate refuses, checked in `ctx.cwd`. A handler error blocks the call, as pi treats a throwing `tool_call` handler. |
| `wt switch` timeout | `tool_call` on `bash` | Raises a `timeout` shorter than 600 s to 600 s on a `wt switch` call, so foreground hooks are not killed mid-provisioning. pi's bash tool has no default timeout, so a call without one is left alone. |
| `worktrunk_preflight` tool | `registerTool` | The checks of `preflight.py`, ported to TypeScript in `shared/preflight.ts` with the same ids, statuses and `{ ok, summary, checks }` JSON. Parameters: `path` (default: the session directory), `only` (check ids), `apply`. `apply` writes `.config/wt.toml` under pi's file-mutation queue. |

The worktree strategy has no pi counterpart: pi has no worktree-strategy hook. pi-subagents allocates
its child worktrees itself, running `wt -C <root> switch --create <branch> --base <commit> --no-cd
--no-hooks --format json` with `spawnSync` from its extension process, not through the bash tool.
pi fires `tool_call` only for tool calls, so neither gate sees that allocation.

pi-subagents' foreground children do not load the parent's extensions ([required host extensions](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md#required-host-extensions)). List this extension for every child in `~/.pi/agent/settings.json`, with the path where pi installed this repository:

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": ["<harness-plugins>/plugins/worktrunk/pi/extensions/worktrunk.js"]
  }
}
```

An agent that sets its own `subagentOnlyExtensions` replaces this default, so it must list the path too.
The Python script stays for OpenCode and Claude Code; the two implementations must change together.

## Smoke test

```sh
bun plugins/worktrunk/opencode/scripts/smoke.ts
```

Creates a scratch repository, then creates, lists, refuses to remove while dirty, force-removes and
lists again through the strategy with real `wt`. It runs your Worktrunk config and hooks.
