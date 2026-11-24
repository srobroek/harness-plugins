# autopilot

Runs an OpenCode or pi session unattended. `/autopilot` asks its setup
questions in one round and then arms the session. After that, the session asks
no more questions. The session records decisions and blockers in a journal. A
4-minute tick keeps the session moving. The run stops on an explicit or an
implicit condition and leaves a debrief and a handoff bead. The sections below
describe OpenCode; [pi](#pi) lists what differs there.

## Commands

| Command | Does |
| --- | --- |
| `/autopilot [scope] [flags]` | Starts a run. The scope is an epic or bead id, a goal in plain words, or nothing for the `bd ready` queue. |
| `/autopilot resume [run-id]` | Arms an unfinished run again in this session, from its latest state file. |
| `/autopilot review [run-id]` | Loads a stopped run's summary and asks one question per needs-input item. |
| `/autopilot stop` | Stops the run in this session and writes the debrief. |

Flags:

- `--full` or `--no-full`
- `--allow merge,deploy,self-review` or `--allow none`
- `--lanes N`
- `--for 3h` or `--until-time 18:00`
- `--until "<condition>"`, or `--until ""` for no condition

`--allow self-review` (default off, recommended no) lets a merge rest on the
plugin-run review instead of a GitHub approval; see "Plugin-run review" below.

The setup round asks for each value that the command-line flags leave out.
`--allow merge`, `--allow deploy` and `--full` govern what the agent decides to
do on its own and what the plugin itself does. Only `--allow merge` reaches the
permission hook, and only for `autopilot_merge`. The
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
- The plugin denies every permission `ask` and journals it as a blocker, with
  its permission kind and the command or pattern it asked about. Your own
  OpenCode permission rules already allow what you trust, and an `ask` is what
  you wanted to be asked about. Nobody is there to answer it. Two asks are
  exceptions, and only an `ask` is ever changed:
  - An `external_directory` ask for exactly `<root>/*`. At a tick, the plugin
    records the directory of each writer lane (not `explore`, the reviewers,
    `debug` or another read-only agent) when it is a linked, non-primary
    worktree that `worktree.list` shows for this project. It stores the real
    path with the device and inode. When the ask arrives, the plugin checks
    that the path is still a plain directory, not a symlink, with the same
    device, inode and real path, and that the project still lists it. No
    wildcard may appear in `<root>`. A symlink alias of the root matches. A
    sibling, a subdirectory, a symlink leading elsewhere, or a root that was
    removed and recreated does not. A lane is recorded at the first tick after
    it starts.
  - An `autopilot_merge` ask for one PR and SHA, under `--allow merge`.
  - An `external_directory` ask for `<dir>/*`, where `<dir>` is the one export
    directory the run made last (`review/<head>/<manifest hash>/`, see
    `autopilot_export_review`) or a directory under it. The plugin records
    that export in its storage, compares real paths, and requires the
    directory to be a plain directory, not a symlink. A wildcard, a `..`
    climb, a sibling, `review/` itself, an older export and a symlink leading
    outside do not match. The allow is for the directory, not for reads: the
    ask carries no read/write distinction, and where the user's rules allow
    `edit` for a path, this ask is the only prompt in the way. The directory
    is model-writable. What a reviewer reads is trusted only through the
    export's manifest hash, not through this permission.
  Shell, edit, MCP and deploy asks stay denied.
- After compaction, the plugin queues a notice with the rules and a fresh
  status.

The plugin keeps armed runs in its storage, so a run survives a server restart.
Every state change holds a lease file in the run directory, so two plugin
instances take turns. The lease does not decide which write wins. Each state
write creates a new numbered file, `state.<N>.json`, and never replaces an
existing one. When two writers race for the same number, one of them wins and
the other fails, and the losing call starts again from the latest state. So a
second plugin instance, or a writer that stalled and lost its lease, never
overwrites a newer state. When a run file is missing, the plugin treats it as absent. When
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
two. When that lookup fails, the plugin creates nothing and retries later.

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

`autopilot_export_review({ pr, base, head })` prepares a review round for
reviewers that cannot run git while the run is armed. `pr` is a positive
integer that keys the stored manifest hash. The plugin runs git itself, as
argument arrays with no shell and with `--no-ext-diff` and `--no-textconv`, in
the run's repository. It rejects a revision that is not a string, starts with
`-` or holds whitespace, then resolves `base` and `head` to full SHAs with
`git rev-parse --verify <rev>^{commit}`. It writes, under
`<run dir>/review/<head-sha>/<manifest-hash>/`:

- `round.diff`: the three-dot diff `base...head`, what `head` changed since it
  left `base`, as a pull request shows it. Work that landed on `base` since is
  not in it.
- `diffstat.txt`: the diffstat of the same range.
- `files/<repo-relative path>`: each file the diff touches (deleted files
  excluded), as it is at `head`.
- `manifest.json`: `base`, `head`, `mergeBase`, the SHA-256 and size of the
  diff, the diffstat and every file, and the skipped files.

It returns the directory, the file list, the skipped files and `manifestHash`
(the SHA-256 of `manifest.json`). The hash is stored in plugin storage under
`review/<pr>@<head>`, and the export becomes the run's current one, the only
directory the hook opens.

Binary files, files above 512 KiB, submodules and unsafe paths (`..`,
absolute, `.git`) are skipped and listed. A range with more than 300 changed
files, a diff above 4 MiB or more than 8 MiB of file content is refused and
nothing is written. Exports are immutable: a published directory is never
overwritten or deleted. Exporting the same content again returns the same
directory if it still verifies; if it was damaged, the damaged directory is
renamed to `.rejected-<id>` and a fresh one is published under the same hash.

`verifyExport(dir, storedManifestHash)` is the check for whoever hands the
export to a reviewer (the plugin, before it prompts one). It refuses unless
`manifest.json` hashes to the stored value and every file, the diff and the
diffstat match their recorded SHA-256 and size, and there is no extra or
missing file or directory, no symlink and no non-regular file. The allowed path
is model-writable, so the manifest hash is the integrity anchor; the
permission is not.

`autopilot_merge({ pr, sha, method })` merges one PR. It asks the host for the
action `autopilot_merge` on `<pr>@<sha>`, which the hook allows only under
`--allow merge`. The tool then reads the PR from `gh` and refuses unless all of
these hold:

- The PR is open and its head is `sha`.
- A GitHub review in state `APPROVED` on commit `sha` exists from an account
  other than the PR author, and no reviewer's latest review requests changes.
  A comment never counts.
- Every check run and status on `sha` is success, neutral or skipped, and at
  least one exists. Each context that branch protection or a ruleset requires
  is also present and passing. If either source cannot be read, the tool
  refuses; a branch GitHub reports as "Branch not protected" counts as read.
- The base branch has no merge queue (a `merge_queue` ruleset rule). Merge
  queues are unsupported and the tool refuses, journaling an issue.
- `method` (`squash`, `rebase` or `merge`) is one the repository allows.

Just before merging, it re-reads the PR's base branch and head. It refuses if
the base is not the one whose protection and rulesets it read, or if the head is
not `sha`. It then merges through the synchronous REST endpoint, as an
argument array with no shell:
`gh api -X PUT repos/{owner}/{repo}/pulls/<pr>/merge -f sha=<sha> -f merge_method=<method>`.
It never calls `gh pr merge`, so it can neither enable auto-merge nor use
`--admin`, and GitHub enforces its own protection. Success needs a response
with `merged: true` and a `sha`. Any non-2xx response is a refusal, for example
405 for a queue-required or protected branch and 409 for a head mismatch; the
journal issue carries the status and message. As a final check, the tool
re-reads the PR (`state,headRefOid,mergeCommit,autoMergeRequest`) and reports
success only when it is `MERGED` at `sha` with a merge commit and no auto-merge
request. It journals the result: an `action` on success, an `issue` on a
refusal. GitHub only. The approval and check judgments live in
`lib/src/pr-approval.ts`, which `delivery_land` shares.

## Plugin-run review

`autopilot_review({ pr, sha })` starts a review that a merge can rest on without
a GitHub approval, because the model that asks for the merge cannot write the
verdict. It refuses unless a run is armed, the PR is open at `sha`, and the
`code-reviewer` agent exists. It then exports the round (as `autopilot_export_review`
does), verifies the export against its stored manifest hash, and creates a child
of the lead session with agent `code-reviewer`, metadata
`{ source, pr, sha, nonce }` and permissions that deny `edit`, `shell`,
`subagent` and `autopilot_*`. It verifies the export once more right before it
sends the one prompt: the diff (at most 256 KiB, else the call refuses) between
lines with a random delimiter, marked as untrusted, and the closing line
`VERDICT: APPROVE <sha>` or `VERDICT: REQUEST_CHANGES <sha>`. The call returns
at once. Plugin storage keeps only a pointer (`pr`, `sha`, session, nonce,
prompt hash, manifest hash, start time), never a verdict.

`autopilot_status` (and `autopilot_merge`) resolve each review from the host:
the session's parent, agent and metadata match; the transcript holds exactly
one user message and its hash is the prompt's; there is no synthetic message,
agent switch or later activity; the last idle and the session outcome are
`succeeded`; and the reviewer's final assistant text, outside any code fence,
ends in a verdict line naming `sha`. A follow-up message, a failed or
interrupted turn or a verdict for another SHA voids it. A reviewer that is not
done 30 minutes after the start is interrupted and voided, and so is a reviewer
whose transcript shows it finished later than that. The verdict line must be the
last non-blank line of the reply. The base of the export is the base commit SHA
GitHub reports for the PR, fetched if needed; the call refuses when it is
missing or the export is empty while GitHub reports changed files.

A head is reviewed at most once, however the review ends. Plugin storage backs
the claim files: a start is also refused when storage holds a pointer for the
head under any PR number or lead, and a storage read that fails refuses the
start, is journaled as a blocker and appears as `storageErrors` in
`autopilot_status`, labelled by operation and resource and cleared only by the
same operation on the same resource succeeding (a sweep cursor that cannot be
read stops the sweep, and a merge under the grant refuses when the review record
cannot be read); it is never read as "no record". The export is also refused
when its diff is empty or its changed-file count differs from the `changed_files`
that GitHub reports (a rename counts once, as `git diff --name-status -M`
lists it). Each status call resolves the newest 20 reviews and the next 25
pointers after a cursor kept in plugin storage, so every deadline is enforced
over successive calls. Before any reviewer
exists the call creates claim files (`pr-<pr>@<sha>` and `head-<sha>`) in
`<git common dir>/opencode-scratch/autopilot/review-claims/`, with the same
create-exclusive link the run state uses. They are released only when the start
is refused, never after a verdict, void, deleted session or follow-up, so a
verdict cannot be re-rolled.

Under `--allow self-review`, `autopilot_merge` skips only the GitHub approval,
and only when the resolved review approves exactly the head being merged.
Checks, required contexts, the head and base re-reads and the repository's
merge method all still apply.

Residual risks:

- Prompt injection through the diff can talk the reviewer into `APPROVE`. The
  delimiter and the fence-aware parse stop a forged verdict line, not a
  persuaded reviewer.
- Same-user writes are out of scope: a process running as you can edit the
  scratch area (claim files, run state), the host database
  (`~/.local/share/opencode/opencode.db`) and call the OpenCode server API, and
  so can create or edit sessions and forge a record the plugin accepts.
- `--allow self-review` is weaker than a second GitHub account. The reviewer is
  a model the same installation runs, with the same user and the same host.
- Branch protection that requires approving reviews still refuses the merge:
  GitHub does not know about the plugin's review.

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
- `state.<N>.json`: the run state, one file per write. The highest number is
  the state, and the plugin keeps the latest five. A corrupt latest file is a
  blocker; the plugin never falls back to an older one.
- `state.json`: a symlink to the latest `state.<N>.json`, for reading by hand.
  The plugin never reads it.
- `summary.md`: the debrief, written at stop

`autopilot/latest` links to the newest run. At stop, the plugin also creates a
bead with the label `autopilot-handoff`. That bead links the run directory and
lists the items that need input. The plugin's own `bd` writes take the embedded
store's write lock, as the beads plugin's writes do.

## pi

`pi/extensions/autopilot.js` is the same run as a pi extension, built from
`pi-src/autopilot.ts` over the run code in `shared/`, which the OpenCode plugin
also runs. The run directory, the journal, the state files, the stop
conditions and the handoff bead are the same, so `/autopilot review` reads a
run that either host wrote.

Install it with `pi install npm:@srobroek/pi-autopilot`, or load the file
with `pi -e plugins/autopilot/pi/extensions/autopilot.js`. It needs
[pi-subagents](https://www.npmjs.com/package/pi-subagents): the run's write
lanes and reviewers are its `subagent` children. parley's pi package
(`npm:@srobroek/pi-parley-rounds`) asks the setup round in one panel, and the
beads pi package (`npm:@srobroek/pi-beads-enforcer`) gates the lanes' `bd`
calls. Both are optional.

A foreground pi-subagents child loads none of the parent's extensions. For the
gates to cover the lanes, list this extension for every child in pi's
`settings.json`:

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": ["/absolute/path/to/autopilot/pi/extensions/autopilot.js"]
  }
}
```

### What pi has and what it lacks

| OpenCode | pi |
| --- | --- |
| `autopilot_status`, `autopilot_log`, `autopilot_merge`, `autopilot_export_review` | Ported with the same names and input schemas. |
| `autopilot_review` and `--allow self-review` | Not ported. See below. |
| `/autopilot [scope] [flags] \| resume \| review \| stop` | Ported. The command sends its prompt as a user message. |
| `question` and `parley_*` denied while armed | Ported as a `tool_call` block, for the lead and for each child that loads the extension. |
| Every permission `ask` denied and journaled | pi has no permission rules. A dialog that another extension opens while a run is armed is journaled as a blocker. The plugin cannot answer or close it. |
| `external_directory` allowed for lane worktrees and the review export | Not needed: pi has no directory permission. |
| `autopilot_merge` checked by the permission hook | The plugin decides as the hook decides an `ask`. In a running run, `--allow merge` allows the merge, and without it the merge is denied and journaled. Outside a run, the user confirms in a dialog. A session that cannot show one is refused. |
| Re-prompt after a turn that ends in a question | Ported on `agent_settled`, as a plugin message that starts a turn. A turn the user aborted is not re-prompted. |
| Notice after compaction | Ported on `session_compact`, delivered after the current turn. |
| Tick automation | pi has no automations. Arming and `/autopilot resume` start the plugin's in-process timer for the lead session. It ticks every 4 minutes and skips while the session is busy. `pi -p` exits after its prompt, so a print-mode run gets no ticks. |
| Child sessions in the tick | pi lists no child sessions to an extension. The ping counts 0 busy lanes. The stall ladder (nudge, restart, park) and "a finished subagent" as progress do not apply. "Everything left is blocked or parked" never stops a run. The other stop conditions apply. |
| Plugin storage | One JSON file per key under `$PI_CODING_AGENT_DIR/autopilot/storage/` (default `~/.pi/agent`), which every pi process reads. |

Every pi session runs in its own extension runtime. A subagent child finds its
run through its session headers: each child's `parentSession` names its
parent's session file, up to the armed lead. Each `question` or `parley_*` call
reads the armed runs from storage again, so a child sees a run that its lead
armed after the child started. The gate fails closed in two cases:

- A parent header that cannot be read counts as an unknown lineage. Its asks
  are blocked while any run is armed.
- Storage that cannot be read blocks every ask.

`autopilot_review` is not ported. On OpenCode, the verdict that a merge rests
on comes from a reviewer session that the host keeps. The plugin creates that
session with fixed permissions and re-reads its record on every status call:
parent, agent, metadata, a single prompt with a known hash, and the outcome.
It also interrupts a reviewer that runs past its deadline. pi has no host
session API for any of that. A pi-subagents reviewer's answer would live only
in the extension's memory and in files that the model can write. On pi,
`/autopilot --allow self-review` and an arm with `self-review` are refused, and
every merge needs a GitHub approval.

The pi tree ships `SKILL.pi.md` as its skill. It describes the timer tick, the
missing child view and the merge rules above.

## Works with

This package works with these pi packages. Install them next to it.

| Package | Required | For | Install |
| --- | --- | --- | --- |
| `pi-subagents` | yes | the subagent tool that runs the run's write lanes and reviewers | `pi install npm:pi-subagents` |
| `@srobroek/pi-parley-rounds` | no | parley_ask, which asks the setup round's questions in one panel | `pi install npm:@srobroek/pi-parley-rounds` |
| `@srobroek/pi-beads-enforcer` | no | the bd gates and per-session actors the lanes' bead claims rely on | `pi install npm:@srobroek/pi-beads-enforcer` |
