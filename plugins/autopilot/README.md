# autopilot

Runs an OpenCode session unattended. `/autopilot` asks its setup questions in
one round and then arms the session. From then on the session asks no
questions. It records decisions and blockers in a journal, and a 4-minute tick
keeps it moving. The run stops on an explicit or an implicit condition and
leaves a debrief and a handoff bead.

## Commands

| Command | Does |
| --- | --- |
| `/autopilot [scope] [flags]` | Starts a run. The scope is an epic or bead id, a goal in plain words, or nothing for the `bd ready` queue. |
| `/autopilot resume [run-id]` | Arms an unfinished run again in this session, from its `state.json`. |
| `/autopilot review [run-id]` | Loads a stopped run's summary and asks one question per needs-input item. |
| `/autopilot stop` | Stops the run in this session and writes the debrief. |

Flags: `--full`, `--allow merge,deploy`, `--lanes N`, `--for 3h` or
`--until-time 18:00`, and `--until "<condition>"`. The setup round asks for
each value that the command line leaves out. The number of parallel write lanes
has no upper limit; the setup round recommends 3, and `--lanes N` skips the
question. Read-only subagents such as `explore` and the reviewers do not take a
lane.

Only the user starts a run. The `autopilot` skill is not auto-invoked, and the
hooks arm only through the command.

## What the plugin enforces while a run is armed

- It denies `question`, `parley_ask`, `parley_wait` and `parley_end` for the
  lead session and every subagent under it.
- When a turn ends with a question to the user, the plugin re-prompts the
  session to decide, log the decision and continue. After two re-prompts in a
  row it logs an issue and waits for the next tick.
- It answers permission `ask` prompts from the run's grants. Branch work,
  feature-branch pushes, PRs, beads, dependency bumps and read-only AWS calls are
  allowed. A merge or a deploy needs `--allow`. A command that discards work,
  such as `git reset --hard` or `rm -r`, needs `--full`. A force push or a push
  to the default branch is always denied. The plugin logs each denial as a
  blocker.
- After compaction, it queues a notice with the rules and a fresh status.

Armed runs are kept in plugin storage, so they survive a server restart.

## Tools

- `autopilot_status`: rebuilds the run state from `bd`, git, child sessions
  and the journal, with no model. It evaluates the stop conditions and returns
  JSON, the ping line and the actions due. Its actions are `status`, `arm`,
  `tick`, `fallback` and `stop`. Code Mode can call it, and the tick automation
  does.
- `autopilot_log`: appends one validated journal entry. Each entry has a type:
  decision, blocker, issue, ambiguity, stop, progress or action. Without
  `--full`, the tool also labels a blocked bead `human`.

## Tick

When a run is armed, the agent creates an OpenCode automation with
`tools.opencode.automation_create`, every 4 minutes until the deadline. It is a
code action, so a tick runs no model. A tick calls `autopilot_status` and sends
nothing while the lead session is busy, which it reads from the host's session
record. Otherwise it sends a ping:

```text
♥ 14:32 · 2/4 lanes · ready 4 · blocked 2 (+1 unblocked) · parked 1 · 1h12m left
```

If the automation cannot be created, an in-process timer prompts the session
instead. It is unref'd and shared across the process, and it also skips a tick
while the session is busy.

## Stop conditions

Explicit conditions:

- the scope is finished
- the wall budget or the clock deadline is reached
- the free-text condition holds
- the user runs `/autopilot stop`

Implicit conditions:

- 6 ticks in a row pass without progress (a closed bead, a commit, a logged
  progress entry or a finished subagent)
- every remaining bead is blocked or parked

Some failures park an item without stopping the run. A bead that is
attempted 3 times without closing is parked, and so is an item that hits the
same error signature twice in a row. A lane that is silent for 12 minutes is
nudged first, then restarted once, then parked.

## Run directory

`$(git rev-parse --git-common-dir)/opencode-scratch/autopilot/<run-id>/` holds:

- `journal.jsonl`: the append-only journal
- `state.json`: the state after the last tick
- `summary.md`: the debrief, written at stop

`autopilot/latest` links to the newest run. At stop, the plugin also creates a
bead labelled `autopilot-handoff`. That bead links the run directory and lists
the items that need input. The plugin's own `bd` writes take the embedded
store's write lock, like the beads plugin's.
