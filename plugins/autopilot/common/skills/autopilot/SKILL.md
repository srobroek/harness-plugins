---
name: autopilot
description: User-only unattended-run rules for /autopilot; never load it yourself, the /autopilot command loads it.
metadata:
  opencode/autoinvoke: false
---

# Autopilot

The user started `/autopilot` and left. This skill holds the rules for the run.
Load it only when an `/autopilot` command, a tick or the compaction notice tells
you to.

## Setup (the only time you ask)

1. The command prompt lists the values the command line gave and the values it
   left out. Ask every missing value in ONE `parley_ask` round. If parley is not
   available, use the `question` tool. Give a recommendation for each value:
   - scope: an epic id, a bead id, a goal in plain words, or the `bd ready` queue
   - `--full`: decide irreversible items too (recommend no)
   - permissions: `merge` and `deploy` grants (recommend none)
   - parallel write lanes: any whole number (recommend 3)
   - budget: a duration (`3h`) or a clock time (`18:00`)
   - a free-text stop condition (optional)
2. Call `autopilot_status` with `action: "arm"` and the answers in `setup`.
3. Create the tick with `tools.opencode.automation_create(<automation>)`, using
   the `automation` object that the call returned. Then call `autopilot_status`
   again with `action: "arm"` and `automation_id`. If the create call fails,
   call `autopilot_status` with `action: "fallback"`.

From here until the run stops, never ask the user anything. While the run is
armed, the plugin denies `question` and the `parley_*` tools for this session and
its subagents.

## Decision policy

- Reversible: pick the most likely option, log it with `autopilot_log`
  (`type: "decision"`, `chosen`, `alternatives`, `reversible: true`,
  `confidence`), and continue.
- Irreversible or outward-facing: log a `blocker` with `parked: true`, park the
  item and move on. Outward-facing covers messages to people, releases and
  anything another team sees.
- With `--full`: decide irreversible items too, within the granted permissions.
  Work beads that are already flagged `human` as well.
- Without `--full`, `autopilot_log` flags the bead of each blocker or ambiguity
  with the `human` label.
- Log each finished unit of work as `progress`: a closed bead, a commit, an
  opened PR or a lane result. Ticks count progress. Six ticks in a row without
  any progress stop the run.
- When an error repeats, give it a short stable `error` signature. The same
  signature twice in a row parks the item.

## Permissions

Allowed by default:

- commits on branches and worktrees, and pushes of feature branches
- opening PRs and MRs
- creating beads, and closing beads you verified
- adding or bumping dependencies
- read-only AWS calls
- evals and probes that leave no resources behind

Spikes are throwaway AWS resources. Tag each one `autopilot-run=<run id>` and
give it a TTL. Before you create a spike, create a teardown child bead that
blocks its parent. Close that bead only with evidence: a tag query that returns
0 resources. Sweep the tag before you stop. A leftover resource is a blocker,
and the run cannot stop as a success while one remains.

Never allowed: a force push, or a push to the default branch.

`merge` needs `--allow merge`, an approve verdict from `code-reviewer` and
green required checks. A deploy (stack create, update or delete) needs
`--allow deploy`. The plugin answers each permission `ask` from these grants,
and it logs every denial as a blocker.

## Lanes

- Write lanes are the lane count chosen at setup. Read-only agents (explore,
  researcher, reviewers) do not use a lane.
- Each writer gets its own Worktrunk worktree. The lead claims no beads. Each
  lane claims its own bead, and the beads plugin renews the claim.
- Stalled lanes follow the tick's `actions`: first `nudge`, then
  `respawn` (abort the lane and start it once more with journal context), then
  `park`.

## Ticks

Every 4 minutes the automation runs `autopilot_status` with `action: "tick"`.
It skips the tick while this session is busy. Otherwise it sends a ping like:

`♥ 14:32 · 2/4 lanes · ready 4 · blocked 2 (+1 unblocked) · parked 1 · 1h12m left`

Post the ping line verbatim and act on its actions due. Keep a tick that has no
actions to that one line.

## Stopping

The run stops when any of these happens:

- the scope is finished
- the budget or the clock deadline is reached
- the free-text condition holds (log a `stop` entry for it)
- the user runs `/autopilot stop`
- six ticks pass without progress
- everything left is blocked or parked

To stop, call `autopilot_status` with `action: "stop"` and a `reason`. It
writes `summary.md`, creates the `autopilot-handoff` bead and disarms the hooks.
Delete the automation with `tools.opencode.automation_delete` when the result
names one. Then print the summary and end the turn.

## Recovery

- After compaction, the plugin queues a notice with a fresh status. Reload this
  skill and continue.
- `/autopilot resume [run-id]` arms a run again in a new session from its
  `state.json`.
- `/autopilot review [run-id]`, in any session, loads the summary and asks one
  question per needs-input item.

The run directory is `$(git rev-parse --git-common-dir)/opencode-scratch/autopilot/<run-id>/`.
It holds `journal.jsonl`, `state.json` and `summary.md`, and `autopilot/latest`
links to the newest run.

When a call here fails unexpectedly, read [references/pitfalls.md](references/pitfalls.md).
