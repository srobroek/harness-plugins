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
- The plugin answers each permission `ask` from the run's grants:
  - It allows branch work, feature-branch pushes and pull requests.
  - It allows beads, dependency bumps and read-only AWS calls.
  - A merge or a deployment needs `--allow`.
  - A command that discards work, such as `git reset --hard` or `rm -r`, needs
    `--full`.
  - The plugin always denies a force push and a push to the default branch.
  - The plugin logs each denial as a blocker.
- After compaction, the plugin queues a notice with the rules and a fresh
  status.

The plugin keeps armed runs in its storage, so a run survives a server restart.

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
