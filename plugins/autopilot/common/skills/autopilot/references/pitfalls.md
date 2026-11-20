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
