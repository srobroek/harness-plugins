# Autopilot pitfalls

## A tick prompt arrives in the middle of a turn

**Symptom:** `Autopilot tick. Post this ping verbatim` shows up between tool calls of a running turn.
**Cause:** an automation `send` steers the session even while it executes. The tick skips only when the plugin saw `session.execution.started` without an end, which it cannot see for executions that began before the server restart.
**Fix:** post the ping, finish the current step, and keep working. The next tick sees the execution events again.

## autopilot_status says the run is in setup

**Symptom:** `run is in setup: finish the setup round and call action "arm"`
**Cause:** the setup round was skipped or the arm call failed validation.
**Fix:** call `autopilot_status` with `action: "arm"` and the setup answers; fix any `--for` or `--until-time` value it rejects.
