import { afterEach, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { roundKey } from "./persist.ts";
import { Parley, settingsFrom } from "./service.ts";
import { opened, quiet, until } from "./test-wait.ts";
import tui from "./tui.tsx";
const location = { directory: "/repo" };
const question = [
    { id: "a", title: "A", kind: "confirm", recommended: "yes" },
    { id: "b", title: "B", kind: "confirm", recommended: "yes" },
];
const realSetInterval = globalThis.setInterval;
afterEach(() => {
    globalThis.setInterval = realSetInterval;
});
function memoryStore(data) {
    return {
        directory: location.directory,
        owns: async () => true,
        list: async () => [...data].filter(([key]) => key.startsWith("round:")).map(([, value]) => value),
        save: async (round) => void data.set(roundKey(round.id), JSON.parse(JSON.stringify(round))),
        remove: async (id) => void data.delete(roundKey(id)),
        listOutbox: async () => [],
        saveOutbox: async () => { },
        removeOutbox: async () => { },
    };
}
/** A TUI wired to whichever server instance `current()` returns, as after a plugin reload the TUI keeps running. */
async function attachTui(current) {
    const terminal = await createTestRenderer({ width: 40, height: 10 });
    const intervals = [];
    globalThis.setInterval = ((run, ms) => {
        intervals.push({ ms, run });
        return realSetInterval(() => { }, 1_000_000);
    });
    let event = async () => { };
    const pendingReplies = [];
    const toasts = [];
    const slots = [];
    const layers = [];
    const colour = RGBA.fromHex("#ffffff");
    const palette = new Proxy({}, { get: () => colour });
    const context = {
        location,
        theme: new Proxy({}, { get: () => palette }),
        renderer: terminal.renderer,
        client: {
            rpc: () => ({
                attach: async (input) => current().attach(input),
                pending: async () => {
                    const reply = current().pending({});
                    pendingReplies.push({ instance: reply.instance, rounds: reply.rounds.length });
                    return reply;
                },
                submit: async (input) => current().submit(input),
                cancel: async (input) => current().cancel(input),
                deliver: async (input) => current().deliver(input),
                events: {
                    on: (_name, callback) => {
                        event = callback;
                        return () => { };
                    },
                },
            }),
        },
        keymap: { layer: (factory) => void layers.push(factory) },
        data: { listen: () => () => { }, session: { get: () => ({ location }) } },
        ui: {
            tabs: { enabled: () => false },
            router: { current: () => ({ type: "session", sessionID: "s" }), navigate: () => { } },
            panel: { current: () => undefined, open: () => true, close: () => { } },
            toast: { show: (input) => void toasts.push(input) },
            dialog: { confirm: async () => false },
            slot: (config) => {
                slots.push(config);
                return () => { };
            },
        },
        attention: { notify: async () => ({ ok: true }) },
    };
    const cleanup = await tui.setup(context);
    await until(() => pendingReplies.length > 0, "the first fetch");
    await quiet();
    const heartbeat = () => intervals.find((item) => item.ms === 10_000)?.run();
    // The app slot registers the commands; `parley.focus` is enabled only while this session has a round on screen.
    const shown = () => {
        slots.find((slot) => slot.append === "app")?.render();
        const commands = layers.at(-1)?.().commands ?? [];
        return commands.find((command) => command.id === "parley.focus")?.enabled?.() === true;
    };
    return {
        heartbeat,
        shown,
        pendingReplies,
        toasts,
        event: (data) => event({ data, location }),
        stop: async () => {
            cleanup?.();
            await terminal.dispose();
        },
    };
}
const server = (store) => new Parley({ settings: settingsFrom({}, {}), emit: async () => { }, ...(store ? { store } : {}) });
test("after a reload the heartbeat fetches the restored round again from the new server instance", async () => {
    const data = new Map();
    const before = server(memoryStore(data));
    before.attach({ clientID: "x" });
    void before.ask({ questions: question, timeout_s: 0 }, { sessionID: "s" });
    await opened(before);
    let running = before;
    const view = await attachTui(() => running);
    try {
        expect(view.shown()).toBe(true);
        await before.suspend();
        const after = server(memoryStore(data));
        await after.restore();
        running = after;
        const fetched = view.pendingReplies.length;
        view.heartbeat();
        // Without the heartbeat noticing the new instance nothing asks the server again.
        await until(() => view.pendingReplies.length > fetched, "the heartbeat to fetch again");
        await quiet();
        expect(view.pendingReplies.length).toBeGreaterThan(fetched);
        expect(view.pendingReplies.at(-1)).toEqual({ instance: after.instance, rounds: 1 });
        expect(view.shown()).toBe(true);
    }
    finally {
        await view.stop();
    }
});
test("a round the new server instance never had stays on screen, with its draft, through later refreshes", async () => {
    const before = server();
    before.attach({ clientID: "x" });
    void before.ask({ questions: question, timeout_s: 0 }, { sessionID: "s" });
    await opened(before);
    let running = before;
    const view = await attachTui(() => running);
    try {
        expect(view.shown()).toBe(true);
        running = server();
        const fetched = view.pendingReplies.length;
        view.heartbeat();
        await until(() => view.pendingReplies.length > fetched, "the heartbeat to fetch again");
        await quiet();
        expect(view.pendingReplies.at(-1)?.rounds).toBe(0);
        // An ordinary refresh (any event) after the reload must not drop the round the user may still be answering.
        const refreshed = view.pendingReplies.length;
        await view.event({ sessionID: "s", roundID: "other", action: "updated" });
        await until(() => view.pendingReplies.length > refreshed, "the event to refresh");
        await quiet();
        expect(view.shown()).toBe(true);
    }
    finally {
        await view.stop();
    }
});
test("a round closed elsewhere without a reload still leaves the screen", async () => {
    const only = server();
    only.attach({ clientID: "x" });
    void only.ask({ questions: question, timeout_s: 0 }, { sessionID: "s" });
    await opened(only);
    const view = await attachTui(() => only);
    try {
        expect(view.shown()).toBe(true);
        const roundID = only.pending({}).rounds[0]?.roundID ?? "";
        await only.cancel({ roundID });
        await view.event({ sessionID: "s", roundID, action: "closed", status: "cancelled" });
        await until(() => !view.shown(), "the round to leave the screen");
        expect(view.shown()).toBe(false);
    }
    finally {
        await view.stop();
    }
});
test("a round whose message to the agent kept failing comes back on screen with the error", async () => {
    const data = new Map();
    const before = server(memoryStore(data));
    before.attach({ clientID: "x" });
    void before.ask({ questions: question, timeout_s: 0 }, { sessionID: "s" });
    await opened(before);
    await before.suspend();
    let view;
    const after = new Parley({
        settings: settingsFrom({}, {}),
        store: memoryStore(data),
        retryDelaysMs: [60, 60],
        emit: async (event) => {
            await view?.event(event);
        },
        deliver: async () => {
            throw new Error("host down");
        },
    });
    await after.restore();
    view = await attachTui(() => after);
    try {
        const roundID = after.pending({}).rounds[0]?.roundID ?? "";
        const yes = [{ id: "a", status: "accepted" }, { id: "b", status: "accepted" }];
        await after.submit({ roundID, answers: yes });
        await view.event({ sessionID: "s", roundID, action: "closed", status: "submitted" });
        await until(() => !view.shown(), "the round to leave the screen");
        expect(view.shown()).toBe(false);
        await until(() => view.shown(), "the undelivered card to come back", 5000);
        expect(view.shown()).toBe(true);
        expect(view.toasts.some((toast) => toast.variant === "warning" && toast.message.includes("host down"))).toBe(true);
    }
    finally {
        await view.stop();
    }
});
