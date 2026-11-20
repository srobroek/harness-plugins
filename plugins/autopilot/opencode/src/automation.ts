/** The Code Mode program the tick automation runs, and the automation request. Pure. */

import { TICK_EVERY } from "./state.ts"

/**
 * Runs with no model on every trigger. It asks `autopilot_status` for one tick of `args.run`:
 * a busy lead session skips (no send), a stopped run ends the automation.
 */
export const TICK_CODE = [
  "const r = await tools.autopilot_status({ action: 'tick', run: args.run });",
  "const out = (r && r.output) || r || {};",
  "const ticks = ((state && state.ticks) || 0) + 1;",
  "if (out.skip) return { state: { ticks, skipped: ((state && state.skipped) || 0) + 1, last: out.skip } };",
  "if (out.done) return out.prompt ? { done: true, send: { prompt: out.prompt } } : { done: true };",
  "return { state: { ticks, skipped: (state && state.skipped) || 0 }, send: { prompt: out.prompt } };",
].join("\n")

export type AutomationRequest = {
  name: string
  trigger: { type: "every"; every: string }
  action: { type: "code"; code: string; args: { run: string } }
  expires?: string
}

/** The `tools.opencode.automation_create` input for a run. */
export function automationRequest(runId: string, deadline: number | undefined): AutomationRequest {
  return {
    name: `autopilot ${runId}`,
    trigger: { type: "every", every: TICK_EVERY },
    action: { type: "code", code: TICK_CODE, args: { run: runId } },
    ...(deadline !== undefined ? { expires: new Date(deadline + 60_000).toISOString() } : {}),
  }
}
