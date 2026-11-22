/**
 * The fallback tick: a process-wide registry of unref'd intervals, one per lead session, so two
 * plugin instances in one process never tick a run twice. Used only when automation_create fails.
 */
export const realClock = {
    setInterval: (callback, ms) => {
        const timer = setInterval(callback, ms);
        timer.unref?.();
        return timer;
    },
    clearInterval: (timer) => clearInterval(timer),
};
const REGISTRY = Symbol.for("srobroek.autopilot.ticks");
function registry() {
    const holder = globalThis;
    holder[REGISTRY] ??= new Map();
    return holder[REGISTRY];
}
export class Ticks {
    clock;
    warn;
    #owner = {};
    constructor(clock = realClock, warn = () => { }) {
        this.clock = clock;
        this.warn = warn;
    }
    /** Start ticking `sessionID`; a session that already ticks in any instance is left alone. */
    start(sessionID, ms, beat) {
        if (registry().has(sessionID))
            return;
        const entry = { owner: this.#owner, clock: this.clock, running: false, timer: undefined };
        entry.timer = this.clock.setInterval(() => {
            if (entry.running)
                return;
            entry.running = true;
            beat()
                .catch((error) => this.warn("fallback tick failed", { sessionID, error: error instanceof Error ? error.message : String(error) }))
                .finally(() => {
                entry.running = false;
            });
        }, ms);
        registry().set(sessionID, entry);
    }
    active(sessionID) {
        return registry().has(sessionID);
    }
    stop(sessionID) {
        const entry = registry().get(sessionID);
        if (!entry)
            return;
        registry().delete(sessionID);
        entry.clock.clearInterval(entry.timer);
    }
    dispose() {
        for (const [key, entry] of [...registry()])
            if (entry.owner === this.#owner)
                this.stop(key);
    }
}
