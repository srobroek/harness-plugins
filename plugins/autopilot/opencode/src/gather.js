/** Reading the world for one tick: beads, git and child sessions. */
import { ledgerEnv } from "./ledger.ts";
function parseArray(text) {
    const start = text.indexOf("[");
    if (start < 0)
        return [];
    try {
        const value = JSON.parse(text.slice(start));
        return Array.isArray(value) ? value : [];
    }
    catch {
        return [];
    }
}
const ids = (items) => items.map((item) => item?.id).filter((id) => typeof id === "string");
/** A cold embedded store can take 30-50 s for one read. */
export const BD_READ_TIMEOUT_MS = 90_000;
/** `bd list --all`, `bd ready` and `bd blocked`, as JSON, from `ledger` and no other. */
export async function readBeads(directory, run, ledger) {
    const env = ledgerEnv(ledger);
    const [list, ready, blocked] = await Promise.all([
        run(directory, "bd", ["list", "--all", "--brief", "--json", "--limit", "0"], BD_READ_TIMEOUT_MS, env),
        run(directory, "bd", ["ready", "--brief", "--json", "--limit", "0"], BD_READ_TIMEOUT_MS, env),
        run(directory, "bd", ["blocked", "--json"], BD_READ_TIMEOUT_MS, env),
    ]);
    const beads = parseArray(list.stdout).flatMap((raw) => {
        const item = raw;
        if (typeof item?.id !== "string" || typeof item.status !== "string")
            return [];
        return [{ id: item.id, status: item.status, parent: item.parent ?? null, ...(item.issue_type ? { issue_type: item.issue_type } : {}), labels: item.labels ?? null }];
    });
    return { beads, ready: ids(parseArray(ready.stdout)), blocked: ids(parseArray(blocked.stdout)), ok: list.ok && ready.ok && blocked.ok };
}
/** Commits reachable from any ref; a rising count means someone committed. */
export async function commitCount(directory, run) {
    const result = await run(directory, "git", ["rev-list", "--all", "--count"]);
    const count = Number(result.stdout.trim());
    return result.ok && Number.isFinite(count) ? count : 0;
}
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
/**
 * Whether a session is executing. The host stamps `time.busy` when an execution starts and
 * `time.idle` when it ends, and keeps both across restarts.
 */
export function sessionBusy(info) {
    const busy = finite(info?.time?.busy);
    const idle = finite(info?.time?.idle);
    return busy !== undefined && (idle === undefined || busy > idle);
}
/**
 * A child session as a tick sees it. `lastSeen` is the newest event the plugin saw for it since
 * load; without one, the session's own timestamps stand in. Nothing counts from before `armedAt`.
 */
export function childFrom(info, lastSeen, armedAt, worktree) {
    const stamped = Math.max(finite(info.time?.updated) ?? 0, finite(info.time?.busy) ?? 0);
    return {
        sessionID: info.id,
        ...(typeof info.title === "string" && info.title ? { title: info.title } : {}),
        ...(typeof info.agent === "string" && info.agent ? { agent: info.agent } : {}),
        ...(worktree !== undefined ? { worktree } : {}),
        busy: sessionBusy(info),
        lastActivity: Math.max(lastSeen ?? stamped, armedAt),
    };
}
/** The last event time per session, fed by the event stream, and a parent cache. */
export class Activity {
    now;
    #last = new Map();
    #parent = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    /** Record one host event. */
    observe(event) {
        const record = event;
        const type = record?.type;
        const sessionID = record?.data?.sessionID;
        if (typeof type !== "string" || typeof sessionID !== "string")
            return;
        if (type === "session.deleted") {
            this.#last.delete(sessionID);
            this.#parent.delete(sessionID);
            return;
        }
        this.#last.set(sessionID, this.now());
    }
    /** The newest event time for `sessionID` since load, if any. */
    lastSeen(sessionID) {
        return this.#last.get(sessionID);
    }
    cachedParent(sessionID) {
        return this.#parent.has(sessionID) ? (this.#parent.get(sessionID) ?? null) : undefined;
    }
    rememberParent(sessionID, parentID) {
        this.#parent.set(sessionID, parentID);
    }
}
