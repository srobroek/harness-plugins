import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Plugin } from "@opencode/plugin";
import { describeError, describeResult, help, plan, stillOpen } from "./rounds.ts";
const SOURCE = "parley-demo";
function loadSamples(directory) {
    const candidates = [path.join(directory, "samples"), path.resolve(import.meta.dirname, "../../../samples")];
    const dir = candidates.find((candidate) => existsSync(path.join(candidate, "plan.md"))) ?? candidates[0] ?? "samples";
    const read = (name) => {
        try {
            return readFileSync(path.join(dir, name), "utf8");
        }
        catch {
            return `(samples/${name} not found)`;
        }
    };
    return { dir, plan: read("plan.md"), diff: read("change.diff") };
}
/**
 * `/parley-demo <subcommand>` opens parley rounds without a model: it calls the parley tools'
 * executors from `ctx.tool.list()` directly and posts each result to the session as a synthetic
 * message, which is what the model would have received.
 */
export default Plugin.define({
    id: "playground.parley-demo",
    async setup(ctx) {
        const running = new Map();
        const notify = (sessionID, message, kind) => {
            const { text, description } = typeof message === "string" ? { text: message, description: message } : message;
            return ctx.session
                .synthetic({
                sessionID,
                text,
                description,
                metadata: { source: SOURCE, kind },
                delivery: "steer",
                resume: false,
            })
                .then(() => { }, (error) => console.error(`${SOURCE}: could not post to ${sessionID}`, error));
        };
        const executor = async (name) => {
            const tools = await ctx.tool.list();
            return tools.find((tool) => tool.id === name || tool.name === name)?.execute;
        };
        const runStep = async (sessionID, step, signal) => {
            const execute = await executor(step.tool);
            if (!execute)
                throw new Error(`${step.tool} is not registered; is the parley plugin loaded?`);
            const context = {
                sessionID,
                agent: "build",
                messageID: `msg_${SOURCE}`,
                id: `call_${SOURCE}_${crypto.randomUUID()}`,
                signal,
                progress: async () => { },
            };
            return execute(step.input, context);
        };
        const run = async (sessionID, steps) => {
            const controller = new AbortController();
            const set = running.get(sessionID) ?? new Set();
            set.add(controller);
            running.set(sessionID, set);
            try {
                let previous;
                for (const step of steps) {
                    if (controller.signal.aborted)
                        return;
                    if ("ifOpen" in step && step.ifOpen && !stillOpen(previous))
                        continue;
                    try {
                        previous = await runStep(sessionID, step, controller.signal);
                        await notify(sessionID, describeResult(step.label, step.tool, previous), "result");
                    }
                    catch (error) {
                        await notify(sessionID, describeError(step.label, step.tool, error, controller.signal.aborted), "error");
                        return;
                    }
                    const status = previous?.output?.status;
                    if (status === "cancelled" || status === "unavailable")
                        return;
                }
            }
            finally {
                set.delete(controller);
                if (set.size === 0)
                    running.delete(sessionID);
            }
        };
        const commands = await ctx.command.transform((editor) => {
            editor.add({
                name: "parley-demo",
                description: "parley playground: all | <kind> | conditional | files | statuses | wait | timeout | resume | fallback | cancel | end",
                execute: async (input) => {
                    const { sessionID } = input;
                    const planned = plan(input.prompt.text ?? "", loadSamples(ctx.location.directory));
                    if ("error" in planned)
                        return notify(sessionID, planned.error, "error");
                    if ("special" in planned) {
                        if (planned.special === "help")
                            return notify(sessionID, help(), "help");
                        const active = running.get(sessionID);
                        for (const controller of active ?? [])
                            controller.abort();
                        return notify(sessionID, `Aborted ${active?.size ?? 0} running demo call(s).`, "cancel");
                    }
                    // Tool calls block until the user submits, so run them in the background and return now.
                    void run(sessionID, planned.steps);
                },
            });
        });
        return async () => {
            for (const set of running.values())
                for (const controller of set)
                    controller.abort();
            running.clear();
            await commands.dispose();
        };
    },
});
