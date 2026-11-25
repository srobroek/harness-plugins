# Autopilot pitfalls

## A tick prompt arrives in the middle of a turn

**Symptom:** `Autopilot tick. Post this ping verbatim` shows up between tool calls of a running turn.
**Cause:** an automation `send` goes into the session even while it executes. The tick skips while the host's session record shows a running execution. A turn that starts between that check and the send still gets the prompt.
**Fix:** post the ping, finish the current step, and keep working.

## autopilot_status says the run is in setup

**Symptom:** `run is in setup: finish the setup round and call action "arm"`
**Cause:** the agent skipped the setup round, or the arm call failed validation.
**Fix:** call `autopilot_status` with `action: "arm"` and the setup answers. Correct any `--for` or `--until-time` value that the call rejects.

## A permission request is denied while the run is armed

**Symptom:** `autopilot never approves a permission ask while the run is unattended; logged as a blocker`
**Cause:** the user's permission rules ask about this call, and nobody is there to answer. The plugin denies every `ask` and journals the permission kind and the command or pattern.
**Fix:** do not retry the call in another form to get around the prompt. Park the item, leave the blocker for the user, and move on to the next item.

## autopilot_status reports that it cannot use its run files

**Symptom:** `autopilot cannot use its run files: <path>: ...`
**Cause:** the latest `state.<N>.json`, `journal.jsonl` or `summary.md` exists but is unreadable or corrupt. A corrupt latest state file is never skipped for an older one.
**Fix:** do not treat the run as finished. Check the file named in the message, log the blocker, and stop the run with `/autopilot stop` once the file is repaired.

## autopilot_status reports that the state moved on under the call

**Symptom:** `state moved on under this call (...)`, with `stale: true`.
**Cause:** another writer, such as a second plugin instance or a stalled earlier call, created that state generation first. Nothing was overwritten, and the plugin journaled an `issue`.
**Fix:** call `autopilot_status` again. It reads the latest state and acts on it.
