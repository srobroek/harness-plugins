/**
 * Lease heartbeats for the claims a session holds.
 *
 * bd keeps a claim lease for five minutes; `bd heartbeat <id>` renews it. While a session
 * executes, each claim with a known actor and store is renewed every minute. Between
 * executions the timers pause, so an idle or crashed session lets its leases lapse and
 * `bd reclaim` can hand the work on. The lease list is plain JSON in plugin storage; the
 * timers are process-wide, so two plugin instances never renew one lease twice.
 */
import { dirname } from "node:path";
import { mutationTargetIds, optionValue } from "./claims.ts";
import { parseTrailingJson } from "./gate-admission.ts";
import { claimEnvironment } from "./release.ts";
/** Renew at one fifth of bd's five-minute lease. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** One heartbeat must not occupy most of the next tick. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;
/** Read stored leases back, dropping anything malformed. */
export function readLeases(value) {
    const leases = {};
    if (value === null || typeof value !== "object")
        return leases;
    for (const [key, lease] of Object.entries(value)) {
        if (lease === null || typeof lease !== "object")
            continue;
        const l = lease;
        if (typeof l.id === "string" && typeof l.actor === "string" && typeof l.store === "string")
            leases[key] = { id: l.id, actor: l.actor, store: l.store };
    }
    return leases;
}
/**
 * Bead ids whose lease a successful command ends: a status other than `in_progress`.
 * Closing and unclaiming already drop the claim itself.
 */
export function leaseEndingIds(invocations) {
    const ids = new Set();
    for (const invocation of invocations) {
        if (invocation.verb !== "update")
            continue;
        const status = optionValue(invocation.args, ["--status", "-s"]);
        if (status !== undefined && status.toLowerCase() !== "in_progress")
            for (const id of mutationTargetIds(invocation.args))
                ids.add(id);
    }
    return [...ids];
}
/**
 * The leases after one command: claims that came or went since `before`, minus leases the
 * command ended. A claim whose actor or store is unknown cannot be renewed.
 */
export function nextLeases(current, before, after, ended) {
    const next = {};
    for (const [key, lease] of Object.entries(current))
        if (after.claims[key] !== undefined)
            next[key] = lease;
    for (const [key, claim] of Object.entries(after.claims)) {
        if (before.claims[key] !== undefined || claim.actor === null || claim.store === null)
            continue;
        next[key] = { id: claim.id, actor: claim.actor, store: claim.store };
    }
    for (const [key, lease] of Object.entries(next))
        if (ended.includes(lease.id))
            delete next[key];
    return next;
}
/** Why a heartbeat result means the lease is no longer held, or `undefined` when it renewed. */
export function heartbeatFailure(result) {
    if (!("output" in result))
        return result.failure;
    const text = result.output.trim();
    if (text === "")
        return undefined;
    const parsed = parseTrailingJson(text);
    if (parsed === undefined)
        return "bd heartbeat returned invalid JSON";
    const error = parsed?.error;
    if (error !== undefined && error !== null && String(error).trim() !== "")
        return `bd heartbeat returned an error: ${String(error)}`;
    return undefined;
}
/** Run one `bd heartbeat` for `lease`, under the embedded write lock like every plugin write. */
export function heartbeatOnce(lease, run, base) {
    const env = claimEnvironment(lease, base);
    return run(dirname(lease.store), ["heartbeat", lease.id, "--json"], Date.now() + HEARTBEAT_TIMEOUT_MS, env).then(heartbeatFailure, (error) => (error instanceof Error ? error.message : String(error)));
}
export const realClock = {
    setInterval: (callback, ms) => {
        const timer = setInterval(callback, ms);
        timer.unref?.();
        return timer;
    },
    clearInterval: (timer) => clearInterval(timer),
};
const REGISTRY = Symbol.for("srobroek.beads.heartbeats");
/**
 * Never change this key: every plugin version in a process must see the same timers.
 * Entries an older version created may lack fields a newer one added, so a reader
 * treats every field except `owner` and `timer` as optional.
 */
function timers() {
    const holder = globalThis;
    holder[REGISTRY] ??= new Map();
    return holder[REGISTRY];
}
const timerKey = (sessionID, key) => `${sessionID}\0${key}`;
/** The renewal timers one plugin instance owns. */
export class Heartbeats {
    #owner = {};
    #clock;
    #beat;
    #observer;
    constructor(beat, clock = realClock, observer = () => { }) {
        this.#beat = beat;
        this.#clock = clock;
        this.#observer = observer;
    }
    /** Run `sessionID`'s timers for exactly `leases`; `now` also renews each one once. */
    run(sessionID, leases, now = false) {
        const prefix = `${sessionID}\0`;
        for (const key of [...timers().keys()]) {
            if (key.startsWith(prefix) && leases[key.slice(prefix.length)] === undefined)
                this.#stop(key);
        }
        for (const [key, lease] of Object.entries(leases)) {
            const id = timerKey(sessionID, key);
            if (!timers().has(id)) {
                const entry = { owner: this.#owner, clock: this.#clock, running: false, timer: undefined };
                entry.timer = this.#clock.setInterval(() => this.#observer(this.#tick(id, sessionID, key, lease)), HEARTBEAT_INTERVAL_MS);
                timers().set(id, entry);
            }
            if (now)
                this.#observer(this.#tick(id, sessionID, key, lease));
        }
    }
    /** Stop every timer of `sessionID`; the stored leases stay for the next execution. */
    pause(sessionID) {
        const prefix = `${sessionID}\0`;
        for (const key of [...timers().keys()])
            if (key.startsWith(prefix))
                this.#stop(key);
    }
    /** Whether a timer runs for this lease, in any instance. */
    active(sessionID, key) {
        return timers().has(timerKey(sessionID, key));
    }
    /** Stop the timers this instance started. */
    dispose() {
        for (const [key, entry] of [...timers()])
            if (entry.owner === this.#owner)
                this.#stop(key);
    }
    #stop(key) {
        const entry = timers().get(key);
        if (entry === undefined)
            return;
        timers().delete(key);
        try {
            (entry.clock ?? this.#clock).clearInterval(entry.timer);
        }
        catch {
            // The host may already have cleared it.
        }
    }
    async #tick(id, sessionID, key, lease) {
        const entry = timers().get(id);
        if (entry === undefined || entry.running)
            return;
        entry.running = true;
        try {
            await this.#beat(sessionID, key, lease);
        }
        finally {
            entry.running = false;
        }
    }
}
