import { expect, test } from "bun:test";
import plugin from "./index.ts";
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
function host(directory, data, writeMs) {
    const tools = new Map();
    let handlers = {};
    const context = {
        options: {},
        location: { directory },
        storage: {
            get: async (key) => data.get(key),
            set: async (key, value) => {
                await tick(writeMs);
                data.set(key, JSON.parse(JSON.stringify(value)));
            },
            remove: async (key) => void data.delete(key),
            scan: async (options) => ({ entries: [...data].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => ({ key, value })) }),
        },
        session: { get: async () => ({ location: { directory } }), synthetic: async () => ({}) },
        rpc: {
            register: async (_definition, registered) => {
                handlers = registered;
                return { events: { emit: async () => { } }, dispose: async () => { } };
            },
        },
        tool: {
            transform: async (edit) => {
                edit({ add: (tool) => void tools.set(tool.name, tool), update: () => { } });
                return { dispose: async () => { } };
            },
            list: async () => [],
        },
    };
    return { context, tools, call: (name, input) => handlers[name]?.(input) };
}
const question = { id: "q", title: "Q", kind: "confirm", recommended: "yes" };
const second = { id: "q2", title: "Q2", kind: "confirm", recommended: "yes" };
const toolContext = { sessionID: "s", id: "call-1", signal: new AbortController().signal, progress: async () => { } };
test("the cleanup waits for queued saves, so the next instance restores the final state", async () => {
    const data = new Map();
    const first = host("/repo", data, 20);
    const cleanup = await plugin.setup(first.context);
    await first.call("attach", { clientID: "tui" });
    const asking = first.tools.get("parley_ask")?.execute({ questions: [question, second] }, toolContext);
    await tick();
    const { rounds } = (await first.call("pending", {}));
    const roundID = rounds[0]?.roundID ?? "";
    await first.call("submit", { roundID, sessionID: "s", answers: [{ id: "q", status: "accepted" }], final: false });
    const draining = typeof cleanup === "function" ? cleanup() : undefined;
    expect(draining).toBeInstanceOf(Promise);
    await draining;
    expect((await asking)?.output.status).toBe("unavailable");
    const stored = data.get(`round:${roundID}`);
    expect(stored.status).toBe("open");
    expect(stored.answers.map((answer) => answer.id)).toEqual(["q"]);
    const next = host("/repo", data, 0);
    await plugin.setup(next.context);
    const restored = (await next.call("pending", {}));
    expect(restored.rounds.map((round) => round.roundID)).toEqual([roundID]);
    expect(restored.rounds[0]?.answers).toHaveLength(1);
});
test("a second location does not restore the first location's rounds", async () => {
    const data = new Map();
    const a = host("/a", data, 0);
    const cleanupA = await plugin.setup(a.context);
    await a.call("attach", { clientID: "tui" });
    void a.tools.get("parley_ask")?.execute({ questions: [question] }, toolContext);
    await tick();
    await (typeof cleanupA === "function" ? cleanupA() : undefined);
    const b = host("/b", data, 0);
    // The session is visible, but belongs to location /a.
    b.context.session.get = (async () => ({ location: { directory: "/a" } }));
    await plugin.setup(b.context);
    expect((await b.call("pending", {})).rounds).toEqual([]);
});
