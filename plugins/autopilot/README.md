# autopilot

Runs an OpenCode session unattended. `/autopilot` asks its setup questions in
one round and then arms the session. After that, the session asks no more
questions. The session records decisions and blockers in a journal. A 4-minute
tick keeps the session moving. The run stops on an explicit or an implicit
condition and leaves a debrief and a handoff bead.

## Commands

| Command | Does |
| --- | --- |
| `/autopilot [scope] [flags]` | Starts a run. The scope is an epic or bead id, a goal in plain words, or nothing for the `bd ready` queue. |
| `/autopilot resume [run-id]` | Arms an unfinished run again in this session, from its `state.json`. |
| `/autopilot review [run-id]` | Loads a stopped run's summary and asks one question per needs-input item. |
| `/autopilot stop` | Stops the run in this session and writes the debrief. |

Flags:

- `--full` or `--no-full`
- `--allow merge,deploy` or `--allow none`
- `--lanes N`
- `--for 3h` or `--until-time 18:00`
- `--until "<condition>"`, or `--until ""` for no condition

The setup round asks for each value that the command-line flags leave out. The
number of parallel write lanes has no upper limit. The setup round recommends 3
lanes, and `--lanes N` skips that question. Read-only subagents, such as
`explore` and the reviewers, take no lane.

Only the user starts a run. OpenCode does not load the `autopilot` skill on its
own, and only the command arms the hooks.

## Rules while a run is armed

The plugin enforces these rules for the lead session and every subagent under
it:

- The plugin denies these tools:
  - `question`
  - `parley_ask`
  - `parley_wait`
  - `parley_end`
- When a turn ends with a question to the user, the plugin re-prompts the
  session to decide, log the decision and continue. After two re-prompts in a
  row, the plugin logs an issue and waits for the next tick.
- The plugin answers each permission `ask` from the run's grants. It fails
  closed. It allows a shell command only when the shared shell parser reads the
  whole command and every part of it is a known safe form:
  - Branch work, pull requests, beads, dependency changes and read-only AWS
    calls are safe forms.
  - The repository's own scripts and test runners are safe forms: `npm test`,
    `npm run <script>`, `bun test`, `make <target>`, `python3 -m pytest` and
    similar. A script or target named like a release is denied.
  - A push must name a remote and a feature branch, for example
    `git push origin feat/x`.
  - A merge or a deployment needs `--allow`. `wt merge` counts as a merge.
  - A command that discards work needs `--full`. Examples are
    `git reset --hard`, `git switch --discard-changes` and `rm -r`.
  - The plugin always denies a force push and a mirror push. It also denies a
    push to `main`, to `master` or to the remote's own default branch. The
    plugin resolves that branch from `refs/remotes/<remote>/HEAD` or from the
    remote. When it cannot resolve the branch, it denies the push.
  - The plugin denies a command it cannot read. Examples are an unknown
    command or flag, a quoted flag, an expansion and a command substitution.
    `$'…'` and `$"…"` quoting are denied too.
  - The plugin denies code it cannot read. Examples are an interpreter with
    `-c`, `-e` or a script file, and a package executor such as `npx`,
    `npm exec`, `pnpm dlx`, `bunx` or `uvx`.
  - The plugin denies AWS calls that change resources, except the
    CloudFormation operations that `--allow deploy` grants.
  - The plugin allows other permission kinds only from a list of kinds that
    act inside the run's location: read, edit, glob, grep, web fetch and
    search, skills, subagents and MCP resource reads. It denies every other
    kind, such as `external_directory`, `execute`, MCP tools and plugin tools.
  - The plugin logs each denial as a blocker.
- After compaction, the plugin queues a notice with the rules and a fresh
  status.

The plugin keeps armed runs in its storage, so a run survives a server restart.
Every state change holds a lock file in the run directory. Every write of
`state.json` holds a short write lock from its generation check to its rename,
and the plugin checks the run lease again just before the rename. So a second
plugin instance, or a writer that stalled and lost its lease, never overwrites
a newer state. When a run file is missing, the plugin treats it as absent. When
a run file is unreadable or corrupt, the plugin reports the error and logs a
blocker. The plugin never reads such a file as an empty run.

Each tick carries a token and the session that the run is bound to. After
`/autopilot resume`, the old automation's ticks are stale. They do nothing and
end that automation, and the resume prompt names the old automation for
deletion.

A stop first moves the run to `stopping`, and the plugin then writes
`summary.md` and the handoff bead. If either write fails, the run stays
`stopping`. The next tick or status call retries the missing one. The plugin
looks up the handoff bead by title before it creates one, so it never creates
two.

## Tools

`autopilot_status` rebuilds the run state with no model. It reads these
sources:

- `bd`
- git
- child sessions
- the journal

The tool then evaluates the stop conditions. It returns JSON, the ping line and
the actions due. Its actions are:

- `status`
- `arm`
- `tick`
- `fallback`
- `stop`

Code Mode can call `autopilot_status`, and the tick automation calls it.

`autopilot_log` appends one validated journal entry. Each entry has one of
these types:

- decision
- blocker
- issue
- ambiguity
- stop
- progress
- action

Without `--full`, `autopilot_log` also labels a blocked bead `human`.

## Tick

When the agent arms a run, it creates an OpenCode automation with
`tools.opencode.automation_create`. The automation runs every 4 minutes until
the deadline. It is a code action, so a tick runs no model. A tick calls
`autopilot_status`. The tick sends nothing while the host's session record
shows the lead session as busy. Otherwise, the tick sends a ping:

```text
♥ 14:32 · 2/4 lanes · ready 4 · blocked 2 (+1 unblocked) · parked 1 · 1h12m left
```

If `automation_create` fails, an in-process timer prompts the session instead.
The plugin unrefs the timer and shares it across the process. The timer also
skips a tick while the session is busy.

## Stop conditions

Explicit conditions:

- The scope has no open beads left.
- The run reaches its wall budget or clock deadline.
- The free-text condition holds.
- The user runs `/autopilot stop`.

Implicit conditions:

- Six ticks in a row pass without progress. Progress means one of these:
  - a closed bead
  - a commit
  - a logged progress entry
  - a finished subagent
- For a bead or queue scope, every remaining bead is blocked or parked.

Some failures park an item and the run goes on:

- A bead that the agents attempt 3 times without closing.
- An item that hits the same error signature twice in a row.
- A lane that stays silent for 12 minutes. The plugin first asks the lead to
  nudge it, then to restart it once, and then parks it.

## Run directory

`$(git rev-parse --git-common-dir)/opencode-scratch/autopilot/<run-id>/` holds:

- `journal.jsonl`: the append-only journal
- `state.json`: the state after the last tick
- `summary.md`: the debrief, written at stop

`autopilot/latest` links to the newest run. At stop, the plugin also creates a
bead with the label `autopilot-handoff`. That bead links the run directory and
lists the items that need input. The plugin's own `bd` writes take the embedded
store's write lock, as the beads plugin's writes do.
