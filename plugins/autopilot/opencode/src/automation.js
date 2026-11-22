/** The Code Mode program the tick automation runs, and the automation request. Pure. */
import { TICK_EVERY } from "./state.ts";
/**
 * Runs with no model on every trigger, with `input = { state, now, runs, args }`. It asks
 * `autopilot_status` for one tick of `args.run`, passing the token and session the automation was
 * created for: a busy lead session skips (no send), and a stopped run or a stale binding (the run
 * was resumed elsewhere) ends the automation. A tool result may arrive as its `output` object or
 * as JSON text.
 */
export const TICK_CODE = [
    "const previous = (input && input.state) || {};",
    "const raw = await tools.autopilot_status({ action: 'tick', run: input.args.run, token: input.args.token, session: input.args.session });",
    "let out = raw && typeof raw === 'object' && raw.output !== undefined ? raw.output : raw;",
    "if (typeof out === 'string') { try { out = JSON.parse(out); } catch { out = { error: out }; } }",
    "out = out || {};",
    "const ticks = (previous.ticks || 0) + 1;",
    "const skipped = previous.skipped || 0;",
    "if (out.done) return out.prompt ? { done: true, send: { prompt: out.prompt } } : { done: true };",
    "if (out.skip) return { state: { ticks, skipped: skipped + 1, last: out.skip } };",
    "if (typeof out.prompt !== 'string') return { state: { ticks, skipped, last: String(out.error || 'no prompt') } };",
    "return { state: { ticks, skipped }, send: { prompt: out.prompt } };",
].join("\n");
/** The `tools.opencode.automation_create` input for a run bound to `binding`. */
export function automationRequest(runId, deadline, binding) {
    return {
        name: `autopilot ${runId}`,
        trigger: { type: "every", every: TICK_EVERY },
        action: { type: "code", code: TICK_CODE, args: { run: runId, token: binding.token, session: binding.session } },
        ...(deadline !== undefined ? { expires: new Date(deadline + 60_000).toISOString() } : {}),
    };
}
