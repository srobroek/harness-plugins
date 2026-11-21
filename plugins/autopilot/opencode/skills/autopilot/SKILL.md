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
   available, use the `question` tool. Recommend an answer for each value:
   - scope: one of these:
     - an epic id or a bead id
     - a goal in plain words
     - the `bd ready` queue
   - ledger: the beads ledger (`.beads` directory) the run reads and writes.
     Skip it unless the scope's beads live in a ledger other than this session
     directory's; the plugin derives it from the scope's bead ids or the session
     directory, and refuses to arm when it cannot. Pass it as `setup.ledger`.
   - `--full`: decide irreversible items too (recommend no)
   - permissions: `merge` and `deploy` grants (recommend none)
   - `self-review` (recommend no): lets a merge rest on the plugin-run review
     (`autopilot_review`) instead of a GitHub approval
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
- When an error repeats, give it a short stable `error` signature. The same
  signature twice in a row parks the item.

## Permissions

These rules say what you may decide to do. They are not approvals: while the
run is armed, the plugin denies every permission `ask` and logs it as a
blocker. The user's own permission rules already allow what they trust, and an
`ask` is what they wanted to be asked about. When a call is denied that way,
log the item, park it, and move on. Do not retry it in another form to get
around the prompt. The exceptions are your own lanes' worktrees (the
plugin allows `<root>/*` for a writer lane's linked worktree that it recorded at a tick
and still finds unchanged), `autopilot_merge` under `--allow merge`, and
reading the directory `autopilot_export_review` returns.

Reviews of a local round you spawn yourself go to `code-reviewer`, with the
export below. Do not send export paths to `pr-reviewer`: its permissions deny
local reads and its contract is a PR on the forge. `code-reviewer` reads with
`read`, `grep` and `glob`, which ask `external_directory` for a path outside its
worktree. While the run is armed the hook allows that ask for exactly one
directory: the export the run made last. Its other permissions stay as they are
(everything not listed is denied; it has no `edit`).

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
a bad revision), narrow the range or log a blocker.

The export directory is writable by any session that may edit, so the allow is
not an integrity guarantee. The manifest hash is: when the plugin spawns a
reviewer itself, it verifies the directory against the stored hash immediately
before the prompt and refuses on any difference, extra or missing file, or
symlink. Exporting identical content again re-publishes a damaged directory
under the same hash and keeps the damaged one aside.

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
exact head SHA from an account other than the PR author (ask `code-reviewer`
to submit it with `gh pr review --approve`; a comment verdict does not count),
and green checks. Merge only through `autopilot_merge({ pr, sha, method })`
with the SHA the reviewer approved; never run `gh pr merge` in a shell,
because the plugin denies that ask. Pass the repository's documented merge
method (see AGENTS.md, CONTRIBUTING or the README; `squash`, `rebase` or
`merge`), never a guess: the tool refuses a method the repository does not
allow. It also refuses when the head moved, the approval is for another SHA, a
required check is not green, branch protection or rulesets cannot be read, or the
base branch uses a merge queue: after a moved head or a bad approval, re-review
the new head; for the rest, log a blocker and park the item. Report a merge only
when the tool says merged; the tool re-reads the PR to confirm it. When the only
reviewer is the PR author's own account, log a blocker and park the item. A
deployment (stack create, update or delete) needs `--allow deploy`; that grant
decides what you do and never approves a permission prompt.

Under `--allow self-review` a merge may rest on a review the plugin runs itself.
Call `autopilot_review({ pr, sha })` with the PR head; it returns at once. The
plugin exports the round, starts a `code-reviewer` session and sends it one
prompt. Read the verdict under `reviews` in `autopilot_status`: `pending`,
`done` with `approve` or `request-changes`, or `void` with a reason. The verdict
comes from the host's record of that session, so you cannot write or edit it.
Do not message the reviewer session: a follow-up voids the review, and a head
that has a finished review is not reviewed again. Only an `approve` for exactly
the head you merge replaces the GitHub approval; checks, required contexts and
the base and head re-reads still apply, and branch protection that requires an
approving review still refuses the merge.

## Lanes

- The number of write lanes is the count chosen at setup, with no upper limit.
  Read-only agents take no lane. These agents are read-only:
  - `explore` and `researcher`
  - the reviewers
  - `debug`

  The ping counts only busy subagents that hold a lane.
- Each writer gets its own Worktrunk worktree. Each lane claims its own bead,
  and the beads plugin renews the claim. The lead leaves bead claims to the
  lanes.
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

To stop, call `autopilot_status` with `action: "stop"` and a `reason`. The call
does these things:

- writes `summary.md`
- creates the `autopilot-handoff` bead
- disarms the hooks

Delete the automation with `tools.opencode.automation_delete` when the result
names one. Then print the summary and end the turn.

## Recovery

- After compaction, the plugin queues a notice with a fresh status. Reload this
  skill and continue.
- `/autopilot resume [run-id]` arms a run again in a new session from its
  latest state file. The resume prompt names the old tick automation: delete it,
  then create the new one. The old automation's ticks are stale and end it.
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
