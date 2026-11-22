/**
 * A lease-based, cross-process file lock.
 *
 * The algorithm is the one `plugins/beads/opencode/src/bd-embedded-write-lock.ts` ships and has been
 * reviewed against (the embedded Dolt write lock), reproduced here for plugins that cannot import
 * beads. It was not extracted from that module because there it is interleaved with the Beads
 * store resolution, a process-global registry of nested owners, a ticket queue, the `bd` writer
 * attachment and a shell-command planner; making it generic would have meant reworking a heavily
 * tested 1,800-line file. What is reproduced is the protocol, line for line in intent:
 *
 *  - A hold is a file created with `O_EXCL` (`wx`) holding `{ host, pid, owner, token, taken,
 *    expires }`. The token identifies THIS acquisition, so a late heartbeat or release from an
 *    owner whose lease lapsed cannot touch a successor's record.
 *  - The lease is renewed on a heartbeat while the holder works. A hold nobody renews expires on
 *    its own; a live pid alone never keeps it (a pid says only that the process exists).
 *  - `abandoned`: a holder on this host whose pid is gone is abandoned at once; otherwise the lease
 *    decides; an unparseable record is judged by its file age against one lease.
 *  - Taking over an abandoned hold happens under a second, "steal" lock, re-reading the hold while
 *    under it. Two waiters that judged one hold abandoned would otherwise each unlink it, and the
 *    second would delete the FRESH hold the first had just created.
 *  - The steal lock is held only SYNCHRONOUSLY (no await between taking and dropping it), which is
 *    what bounds the window in which it can be left behind. A steal lock whose holder crashed in
 *    that window is judged like any hold (dead pid, expired lease) and cleared. Clearing it is a
 *    check-then-unlink, exactly as in beads: two waiters clearing the same dead steal lock at the
 *    same instant can in theory remove each other's fresh one. The window needs a process to die
 *    inside a microsecond-wide synchronous section and two others to race its cleanup; it is the
 *    risk beads accepts, and this module adds no second protocol on top of it.
 *  - Record replacement and deletion (renewal, release) also go through the steal lock, so a
 *    stalled release cannot unlink a successor's hold.
 *
 * Re-entrant for the same async call chain: code that runs inside a held lock may call back into
 * it for the same path without waiting on itself.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { readBounded } from "./bounded-read.ts";
import { processAlive } from "./subprocess.ts";
const LEASE_MS = 120_000;
const RENEW_MS = 20_000;
const WAIT_MS = 120_000;
const POLL_MS = 20;
const POLL_MAX_MS = 400;
export function parseLeaseRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const { host, pid, owner, token, taken, expires } = value;
    if (typeof host !== "string" || typeof owner !== "string" || typeof token !== "string")
        return undefined;
    if (typeof pid !== "number" || !Number.isInteger(pid) || typeof taken !== "number" || typeof expires !== "number")
        return undefined;
    return { host, pid, owner, token, taken, expires };
}
/**
 * Whether a hold may be taken over (beads' `abandoned`). Unparseable: judged by file age against one
 * lease. A holder on this host whose pid is gone is abandoned at once. Otherwise the lease decides:
 * nobody renewed it, so nobody is waiting on what it guarded. Pure.
 */
export function leaseAbandoned(record, facts) {
    if (record === undefined)
        return facts.ageMs > facts.leaseMs;
    if (record.host === facts.host && !facts.alive(record.pid))
        return true;
    return facts.now > record.expires;
}
const insideLock = new AsyncLocalStorage();
/**
 * Run `fn` outside any lock this call chain holds. Another PROCESS never inherits the holder's
 * re-entrancy; tests that simulate a second plugin instance inside one process use this to be a
 * stranger to the lock.
 */
export const outsideLocks = (fn) => insideLock.exit(fn);
const stealPathFor = (lock) => `${lock}.steal`;
/** Delay before poll `attempt`: exponential, capped, jittered (beads' `backoffDelayMs`). */
export function backoffDelayMs(attempt, random = Math.random) {
    const ceiling = Math.min(POLL_MAX_MS, POLL_MS * 2 ** Math.min(attempt, 16));
    return Math.max(1, Math.round(ceiling / 2 + (ceiling / 2) * random()));
}
const ageOf = (path, now) => {
    try {
        return now - statSync(path).mtimeMs;
    }
    catch {
        return 0;
    }
};
function abandoned(path, c) {
    const record = readBounded(path);
    // Absent: released while we were reading it. Unreadable: not a small regular file, never taken over.
    if (record.kind !== "text")
        return false;
    let parsed;
    try {
        parsed = parseLeaseRecord(JSON.parse(record.text));
    }
    catch {
        parsed = undefined;
    }
    return leaseAbandoned(parsed, { now: c.now(), host: c.host, alive: c.alive, leaseMs: c.leaseMs, ageMs: ageOf(path, c.now()) });
}
const recordFor = (c, token) => {
    const taken = c.now();
    return { host: c.host, pid: process.pid, owner: c.owner.slice(0, 256), token, taken, expires: taken + c.leaseMs };
};
/** Whether the file at `lock` still records the hold with `token`. */
function stillOurs(lock, token, host) {
    try {
        const record = readBounded(lock);
        if (record.kind !== "text")
            return false;
        const parsed = parseLeaseRecord(JSON.parse(record.text));
        return parsed?.token === token && parsed.pid === process.pid && parsed.host === host;
    }
    catch {
        return false;
    }
}
/** Take over a hold whose owner is gone, under the steal lock, re-reading the hold while under it. Synchronous throughout. */
function takeOverIfAbandoned(c) {
    if (!abandoned(c.lock, c))
        return;
    c.afterJudged?.();
    let fd;
    try {
        fd = openSync(c.steal, "wx");
    }
    catch (error) {
        if (error.code !== "EEXIST")
            return;
        // The steal lock is judged like any hold: a crashed stealer's is cleared.
        if (abandoned(c.steal, c)) {
            try {
                unlinkSync(c.steal);
            }
            catch {
                // Another waiter cleared it first.
            }
        }
        return;
    }
    try {
        writeSync(fd, JSON.stringify(recordFor(c, `steal-${randomUUID()}`)));
        if (abandoned(c.lock, c))
            unlinkSync(c.lock);
    }
    catch {
        // The hold went away on its own.
    }
    finally {
        closeSync(fd);
        try {
            unlinkSync(c.steal);
        }
        catch {
            // Cleared as stale by a waiter; harmless.
        }
    }
}
/** Serialise record replacement and deletion with stale-holder takeover (beads' `withOwnership`). Synchronous. */
function withOwnership(c, token, change) {
    let fd;
    try {
        fd = openSync(c.steal, "wx");
    }
    catch (error) {
        if (error.code === "EEXIST")
            return "busy";
        throw error;
    }
    try {
        if (!stillOurs(c.lock, token, c.host))
            return "lost";
        change();
        return "done";
    }
    finally {
        closeSync(fd);
        try {
            unlinkSync(c.steal);
        }
        catch {
            /* A competing cleanup already removed it. */
        }
    }
}
function rewrite(c, token) {
    return withOwnership(c, token, () => {
        const fd = openSync(c.lock, "w");
        try {
            writeSync(fd, JSON.stringify(recordFor(c, token)));
        }
        finally {
            closeSync(fd);
        }
    });
}
/**
 * Run `work` holding the lease lock at `lockPath` (its directory must exist). Fails closed: a lock
 * error that is not a live hold, and a wait that runs out, return `failed` and `work` does not run.
 */
export async function withLease(lockPath, options, work) {
    const held = insideLock.getStore();
    if (held?.has(lockPath))
        return { kind: "done", value: await work() };
    const c = {
        lock: lockPath,
        steal: stealPathFor(lockPath),
        now: options.now ?? Date.now,
        host: options.host ?? hostname().split(".")[0] ?? "localhost",
        alive: options.alive ?? processAlive,
        leaseMs: options.leaseMs ?? LEASE_MS,
        owner: options.owner,
        afterJudged: options.seams?.afterJudged,
    };
    const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    const random = options.random ?? Math.random;
    const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
    const token = `${process.pid}-${Date.now()}-${randomUUID()}`;
    let attempt = 0;
    let fd;
    while (fd === undefined) {
        try {
            // Exclusive create is the whole cross-process guarantee.
            fd = openSync(lockPath, "wx");
            writeSync(fd, JSON.stringify(recordFor(c, token)));
        }
        catch (error) {
            if (fd !== undefined) {
                closeSync(fd);
                fd = undefined;
            }
            const code = error.code;
            if (code !== "EEXIST")
                return { kind: "failed", reason: `the lock at ${lockPath} could not be taken (${code ?? "unknown error"})` };
            if (readBounded(lockPath).kind === "unreadable" || readBounded(c.steal).kind === "unreadable") {
                return { kind: "failed", reason: `the lock path ${lockPath} (or its steal lock) is not a small regular file, so its holder cannot be read safely` };
            }
            takeOverIfAbandoned(c);
            if (Date.now() >= deadline) {
                return { kind: "failed", busy: true, reason: `the lock at ${lockPath} stayed held for ${Math.round(((options.waitMs ?? WAIT_MS) / 1000) * 10) / 10}s` };
            }
            await sleep(Math.min(backoffDelayMs(attempt++, random), Math.max(1, deadline - Date.now())));
        }
    }
    const owned = fd;
    // The heartbeat keeps a long hold alive; a hold nobody renews expires on its own.
    const heartbeat = setInterval(() => {
        try {
            if (rewrite(c, token) === "lost")
                clearInterval(heartbeat);
        }
        catch {
            // A lease that cannot be renewed simply expires: the safe direction.
        }
    }, options.renewMs ?? RENEW_MS);
    heartbeat.unref?.();
    try {
        const value = await insideLock.run(new Set([...(held ?? []), lockPath]), async () => work());
        return { kind: "done", value };
    }
    finally {
        clearInterval(heartbeat);
        try {
            closeSync(owned);
        }
        catch {
            // Nothing to do; the file is what other processes see.
        }
        // Release by token under the steal lock; if that is busy retry briefly, then leave it to the lease.
        const releaseBy = Date.now() + 2_000;
        for (;;) {
            try {
                if (withOwnership(c, token, () => unlinkSync(lockPath)) !== "busy")
                    break;
            }
            catch {
                break;
            }
            if (Date.now() >= releaseBy)
                break;
            await sleep(POLL_MS);
        }
    }
}
