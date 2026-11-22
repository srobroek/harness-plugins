import { describe, expect, test } from "bun:test";
import { automationRequest, TICK_CODE } from "./automation.ts";
const program = new Function("input", "tools", `return (async () => {\n${TICK_CODE}\n})()`);
/** Run the tick program as a code action would: `input` as documented, one `autopilot_status` tool. */
async function runTick(result, state) {
    const calls = [];
    const tools = {
        autopilot_status: async (args) => {
            calls.push(args);
            return result;
        },
    };
    const output = await program({ state, now: 0, runs: 1, args: { run: "r1", token: "k1", session: "ses_lead" } }, tools);
    return { output, calls };
}
describe("tick program", () => {
    test("asks autopilot_status for one tick of the run named in args", async () => {
        const { calls } = await runTick({ output: { prompt: "p" } });
        expect(calls).toEqual([{ action: "tick", run: "r1", token: "k1", session: "ses_lead" }]);
    });
    test("sends the prompt and counts the tick", async () => {
        const { output } = await runTick({ output: { prompt: "ping" } }, { ticks: 2, skipped: 1 });
        expect(output).toEqual({ state: { ticks: 3, skipped: 1 }, send: { prompt: "ping" } });
    });
    test("sends nothing while the lead session is busy", async () => {
        const { output } = await runTick({ output: { skip: "lead session busy" } }, { ticks: 2, skipped: 1 });
        expect(output).toEqual({ state: { ticks: 3, skipped: 2, last: "lead session busy" } });
    });
    test.each([
        ["with a closing prompt", { done: true, prompt: "stop now" }, { done: true, send: { prompt: "stop now" } }],
        ["after the run stopped", { done: true, stopped: "scope finished" }, { done: true }],
    ])("ends the automation %s", async (_name, out, expected) => {
        expect((await runTick({ output: out })).output).toEqual(expected);
    });
    test("reads a tool that returns its JSON as text", async () => {
        const { output } = await runTick(JSON.stringify({ prompt: "ping" }));
        expect(output).toEqual({ state: { ticks: 1, skipped: 0 }, send: { prompt: "ping" } });
    });
    test("sends nothing when the result has no prompt", async () => {
        const { output } = await runTick({ output: { error: "no autopilot run" } });
        expect(output).toEqual({ state: { ticks: 1, skipped: 0, last: "no autopilot run" } });
    });
});
describe("automationRequest", () => {
    test("ticks every 4 minutes and expires a minute after the deadline", () => {
        const deadline = Date.UTC(2026, 10, 20, 18, 0);
        expect(automationRequest("r1", deadline, { token: "k1", session: "ses_lead" })).toEqual({
            name: "autopilot r1",
            trigger: { type: "every", every: "4 minutes" },
            action: { type: "code", code: TICK_CODE, args: { run: "r1", token: "k1", session: "ses_lead" } },
            expires: "2026-11-20T18:01:00.000Z",
        });
    });
    test("has no expiry without a deadline", () => {
        expect(automationRequest("r1", undefined, { token: "k1", session: "ses_lead" })).not.toHaveProperty("expires");
    });
});
