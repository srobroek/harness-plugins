---
name: autopilot
description: User-only unattended-run rules for /autopilot; never load it yourself, the /autopilot command loads it.
---

# Autopilot

The user started `/autopilot` and left. This skill holds the rules for the run.
Load it only when an `/autopilot` command, a tick or the compaction notice tells
you to.

## Setup (the only time you ask)

1. The command prompt lists the values the command line gave and the values it
   left out. Ask every missing value in ONE `parley_ask` round. Without parley,
   ask them all in one message and end the turn until the user answers.
   Recommend an answer for each value:
   - scope: one of these:
     - an epic id or a bead id
     - a goal in plain words
     - the `bd ready` queue
   - ledger: the beads ledger (`.beads` directory) the run reads and writes.
     Skip it unless the scope's beads live in a ledger other than this session
     directory's; the plugin derives it from the scope's bead ids or the session
     directory, and refuses to arm when it cannot. Pass it as `setup.ledger`.
   - `--full`: decide irreversible items too (recommend no)
   - permissions: `merge` and `deploy` grants (recommend none). pi has no
     `self-review` grant: a merge always needs a GitHub approval.
   - parallel write lanes: any whole number (recommend 3)
   - budget: a duration (`3h`) or a clock time (`18:00`)
   - a free-text stop condition (optional)
2. Call `autopilot_status` with `action: "arm"` and the answers in `setup`. The
   plugin starts the 4-minute tick itself; there is nothing to create.

From here until the run stops, never ask the user anything. While the run is
armed, the plugin blocks `question` and the `parley_*` tools for this session
and for every subagent that loads the plugin.

## Decision policy

- Reversible: pick the most likely option and continue. Log it with
  `autopilot_log` and these fields:
  - `type: "decision"`
  - `chosen` and `alternatives`
  - `reversible: true`
  - `confidence`
- Irreversible or outward-facing: log a `blocker` with `parked: true`, park the
  item and move on. Outward-facing covers messages to people, releases and
  anything another team sees.
- With `--full`: decide irreversible items too, within the granted permissions.
  Work beads that are already flagged `human` as well.
- Without `--full`, `autopilot_log` flags the bead of each blocker or ambiguity
  with the `human` label.
- Log each finished unit of work as `progress`. A unit of work is one of these:
  - a closed bead
  - a commit
  - an opened PR
  - a lane result

  Ticks count progress. Six ticks in a row without any progress stop the run.
  On pi the tick cannot see subagents, so a lane result counts only once you
  log it.
- When an error repeats, give it a short stable `error` signature. The same
  signature twice in a row parks the item.

## Permissions

These rules say what you may decide to do. They are not approvals. pi has no
permission prompts, but other extensions open dialogs that wait for a person,
for example a safety confirmation for a destructive command. Nobody is there to
answer one: in the terminal it waits, and a session without dialogs usually
refuses the call. The plugin logs each dialog that opens as a blocker. Before a
call that you expect to need an approval, log a blocker, park the item and move
on. Do not retry a refused call in another form to get around the check.

Before you spawn a reviewer for a round, call
`autopilot_export_review({ pr, base, head })` with the PR number and the
revisions under review, and call it again after each new head. The tool runs
git itself and writes, under the run's `review/<head>/<manifestHash>/`:
`round.diff` (the `base...head` diff), `diffstat.txt`, `files/<path>` (each
changed file at head) and `manifest.json` (the SHA-256 of every file). It
returns `dir` and `manifestHash`; the plugin keeps the hash by `pr@head`.
Put both in the reviewer's prompt: "Review the export at `<dir>` (manifest hash
`<manifestHash>`). Read `manifest.json` first and start your verdict with that
hash line. Do not run git." A verdict that quotes a different hash, or none,
does not count: export again and re-run the review. If the tool refuses (a cap,
a bad revision), narrow the range or log a blocker. Any session that may edit
can write to the export directory, so only the manifest hash vouches for it.

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

Never do: a force push, a mirror push, or a push to the default branch.

Commands that discard work (`git reset --hard`, `git clean -f`, `git branch -D`,
`git switch --discard-changes`, deleting a remote branch, `git stash drop`,
`rm -r`, `bd delete`) are irreversible. Run one only in a `--full` run.
Otherwise, log it as a blocker and park the item.

A merge needs `--allow merge`, a GitHub review in state `APPROVED` on the
exact head SHA from an account other than the PR author (ask the reviewer to
submit it with `gh pr review --approve`; a comment verdict does not count), and
green checks. Merge only through `autopilot_merge({ pr, sha, method })` with
the SHA the reviewer approved; never run `gh pr merge` in a shell. Without
`--allow merge` the plugin refuses the merge and logs a blocker. Pass the
repository's documented merge method (see AGENTS.md, CONTRIBUTING or the
README; `squash`, `rebase` or `merge`), never a guess: the tool refuses a
method the repository does not allow. It also refuses when the head moved, the
approval is for another SHA, a required check is not green, branch protection
or rulesets cannot be read, or the base branch uses a merge queue: after a
moved head or a bad approval, re-review the new head; for the rest, log a
blocker and park the item. Report a merge only when the tool says merged; the
tool re-reads the PR to confirm it. When the only reviewer is the PR author's
own account, log a blocker and park the item. A deployment (stack create,
update or delete) needs `--allow deploy`.

## Lanes

- Lanes are pi-subagents children: start each with the `subagent` tool. The
  number of write lanes is the count chosen at setup, with no upper limit.
  Read-only agents take no lane. These agents are read-only:
  - `explore` and `researcher`
  - the reviewers
  - `debug`
- Each writer gets its own Worktrunk worktree. Each lane claims its own bead.
  The lead leaves bead claims to the lanes.
- The tick sees no subagents on pi: the ping shows `0/<lanes> lanes`, and it
  names no stalled lane. Track your lanes yourself. Nudge a lane that has been
  silent for 12 minutes, restart it once with journal context if it stays
  silent, then park its item.

## Ticks

Every 4 minutes, while this session is idle, the plugin runs the tick and sends
a prompt with a ping like:

`♥ 14:32 · 0/4 lanes · ready 4 · blocked 2 (+1 unblocked) · parked 1 · 1h12m left`

Post the ping line verbatim and act on its actions due. Keep a tick that has no
actions to that one line. The tick runs inside this pi process: print mode
(`pi -p`) ends with its prompt and gets no ticks.

## Stopping

The run stops when any of these happens:

- the scope is finished
- the budget or the clock deadline is reached
- the free-text condition holds (log a `stop` entry for it)
- the user runs `/autopilot stop`
- six ticks pass without progress

To stop, call `autopilot_status` with `action: "stop"` and a `reason`. The call
does these things:

- writes `summary.md`
- creates the `autopilot-handoff` bead
- disarms the gates

Then print the summary and end the turn.

## Recovery

- After compaction, the plugin queues a notice with a fresh status. Reload this
  skill and continue.
- `/autopilot resume [run-id]` arms a run again in this session from its latest
  state file and restarts the tick here. Ticks bound to the old session no
  longer count.
- If a stop reports `phase: "stopping"`, the summary or the handoff bead did not
  land. The next tick retries; call `autopilot_status` with `action: "stop"` to
  retry now. The run is stopped only when both exist.
- `/autopilot review [run-id]`, in any session, loads the summary and asks one
  question per needs-input item.

The run directory is `$(git rev-parse --git-common-dir)/opencode-scratch/autopilot/<run-id>/`.
It holds `journal.jsonl`, the state files `state.<N>.json` (the highest number
is the state; `state.json` links to it for reading by hand) and `summary.md`.
The `autopilot/latest` link points to the newest run.

When a call here fails unexpectedly, read [references/pitfalls.md](references/pitfalls.md).
