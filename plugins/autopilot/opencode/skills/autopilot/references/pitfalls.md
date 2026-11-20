# Autopilot pitfalls

## A tick prompt arrives in the middle of a turn

**Symptom:** `Autopilot tick. Post this ping verbatim` shows up between tool calls of a running turn.
**Cause:** an automation `send` goes into the session even while it executes. The tick skips while the host's session record shows a running execution. A turn that starts between that check and the send still gets the prompt.
**Fix:** post the ping, finish the current step, and keep working.

## autopilot_status says the run is in setup

**Symptom:** `run is in setup: finish the setup round and call action "arm"`
**Cause:** the agent skipped the setup round, or the arm call failed validation.
**Fix:** call `autopilot_status` with `action: "arm"` and the setup answers. Correct any `--for` or `--until-time` value that the call rejects.

## A permission request is denied as irreversible

**Symptom:** `irreversible command parked: it discards work; logged as a blocker`
**Cause:** the command needed approval and matches a command that discards work, such as `git reset --hard` or `rm -r`. Only a `--full` run decides those commands.
**Fix:** find a reversible way, for example a new branch or worktree in place of a reset. If none exists, move on to the next item; the blocker stays in the journal for the user.

## A permission request is denied because autopilot cannot read it

**Symptom:** `autopilot allows only commands it can read: ...; logged as a blocker`
**Cause:** the command needed approval and the gate could not prove it safe. The message names the cause: an unknown command or flag, a quoted flag, a variable or command substitution, a wrapper such as `sh -c`, or a push without an explicit branch.
**Fix:** rewrite the command in a plain, literal form, for example `git push origin feat/x`, and run it again. If no such form exists, leave the blocker for the user and move on to the next item.

## autopilot_status reports that it cannot use its run files

**Symptom:** `autopilot cannot use its run files: <path>: ...`
**Cause:** `state.json`, `journal.jsonl` or `summary.md` exists but is unreadable or corrupt, or another plugin instance moved the state on (`generation ... on disk`).
**Fix:** do not treat the run as finished. Check the file named in the message. For a generation conflict, call `autopilot_status` again; it reads the newer state. For a corrupt file, log the blocker and stop the run with `/autopilot stop` once the file is repaired.
