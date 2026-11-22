/**
 * Move sessions out of a worktree before it is removed.
 *
 * OpenCode resolves a session's location for every request that touches the session (the TUI
 * listing it, a wake or drain, a plugin calling `session.get`). A session whose directory is gone
 * fails all of them with "Location not found". So a remover moves every idle session whose location
 * is the target, or inside it, to the repository's canonical checkout first, and refuses to remove
 * if a session there is running, or if any lookup or move fails.
 *
 * The adapter takes the few `ctx.session` calls it needs, so delivery and subagent-worktree (which
 * bundle separate copies of this lib) both use it.
 */
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { insideDirectory } from "./session-lanes.ts";
import { canonicalDirectory } from "./worktree-claims.ts";
const MAX_PAGES = 100;
const toMillis = (value) => {
    if (typeof value === "number")
        return value;
    if (value instanceof Date)
        return value.getTime();
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
};
/** Whether the session's latest execution started and has not ended. An archived session is idle by definition. */
export function sessionRunning(session) {
    if (session.time?.archived !== undefined && session.time.archived !== null)
        return false;
    const busy = toMillis(session.time?.busy);
    const idle = toMillis(session.time?.idle);
    return busy !== undefined && (idle === undefined || busy > idle);
}
/** The repository's canonical main checkout from its git common directory, or `fallback`. Pure. */
export function canonicalCheckout(commonDir, fallback) {
    if (commonDir !== undefined && basename(commonDir) === ".git")
        return dirname(commonDir);
    return fallback;
}
/** One pass over the listing with `archived` fixed, all pages; undefined when a page cannot be read. */
async function listPass(api, projectID, archived) {
    const found = [];
    let query = { ...(projectID === undefined ? {} : { project: projectID }), archived, limit: 100 };
    try {
        for (let pages = 0; pages < MAX_PAGES; pages++) {
            const page = (await api.list(query));
            if (!page || !Array.isArray(page.data))
                return undefined;
            for (const raw of page.data) {
                const session = raw;
                if (typeof session?.id === "string")
                    found.push(session);
            }
            const next = page.cursor?.next;
            if (!next)
                return found;
            query = { cursor: next };
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
/**
 * Every session of the project, archived ones included (an archived session left in a removed worktree
 * keeps its dead location, and unarchiving it later fails), all pages. A session that names another
 * project is dropped even if the host ignored the filter. `undefined` when any page cannot be read or
 * the listing does not end within the page cap: an incomplete answer is unknown, never "none".
 */
export async function listProjectSessions(api, projectID) {
    const live = await listPass(api, projectID, false);
    const shelved = live === undefined ? undefined : await listPass(api, projectID, true);
    if (live === undefined || shelved === undefined)
        return undefined;
    const byId = new Map();
    for (const session of [...live, ...shelved]) {
        if (projectID !== undefined && session.projectID !== undefined && session.projectID !== projectID)
            continue;
        byId.set(session.id, session);
    }
    return [...byId.values()];
}
/** Whether `path` exists. Only ENOENT (or ENOTDIR) means gone; any other error is thrown: unknown is not gone. */
export async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ENOTDIR")
            return false;
        throw error;
    }
}
/**
 * Run under the removal lock, right before the removal. Running sessions block it; each idle session in
 * the target is moved to `destination`; a failed lookup or move blocks it. `exclude` skips sessions the
 * caller already handled (a lane's own child, moved home separately).
 */
export async function evictSessions(api, options) {
    const sessions = await listProjectSessions(api, options.projectID);
    if (sessions === undefined)
        return { ok: false, reason: `the sessions of the project could not all be listed, so who is in ${options.directory} is unknown` };
    const target = canonicalDirectory(options.directory);
    const inside = sessions.filter((session) => {
        if (options.exclude?.has(session.id))
            return false;
        const where = session.location?.directory;
        return typeof where === "string" && insideDirectory(canonicalDirectory(where), target);
    });
    const running = inside.find(sessionRunning);
    if (running)
        return { ok: false, reason: `session ${running.id} is running in ${options.directory}` };
    const moved = [];
    for (const session of inside) {
        try {
            await api.move({ sessionID: session.id, directory: options.destination });
            moved.push(session.id);
        }
        catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            return { ok: false, reason: `session ${session.id} could not be moved out of ${options.directory} (${why}); nothing was removed` };
        }
    }
    return { ok: true, moved };
}
/**
 * Move every session whose location directory no longer exists (ENOENT only; any other error means
 * unknown and the session is left alone) to the first of `destinationsFor(session)` that exists. A running
 * session is never moved. Archived ones are repaired like the rest. A session with no existing destination
 * is reported as failed, not moved to a path that is not there. Each move is logged through `log`.
 */
export async function repairStrandedSessions(api, options) {
    const sessions = await listProjectSessions(api, options.projectID);
    if (sessions === undefined)
        return { error: "the sessions of the project could not all be listed" };
    const exists = options.exists ?? pathExists;
    const result = { moved: [], failed: [] };
    for (const session of sessions) {
        const where = session.location?.directory;
        if (typeof where !== "string" || where === "")
            continue;
        try {
            if (await exists(resolve(where)))
                continue;
        }
        catch (error) {
            options.log?.(`session ${session.id}: ${where} could not be checked (${error instanceof Error ? error.message : String(error)}); left alone`);
            continue;
        }
        if (sessionRunning(session))
            continue;
        let to;
        for (const candidate of options.destinationsFor(session)) {
            try {
                if (await exists(resolve(candidate))) {
                    to = candidate;
                    break;
                }
            }
            catch {
                // A destination that cannot be checked is not one to move to.
            }
        }
        if (to === undefined) {
            const reason = "no existing destination to move it to";
            result.failed.push({ sessionID: session.id, reason });
            options.log?.(`could not move session ${session.id} out of ${where}: ${reason}`);
            continue;
        }
        try {
            await api.move({ sessionID: session.id, directory: to });
            result.moved.push({ sessionID: session.id, from: where, to });
            options.log?.(`moved session ${session.id} out of ${where} (gone) to ${to}`);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            result.failed.push({ sessionID: session.id, reason });
            options.log?.(`could not move session ${session.id} out of ${where}: ${reason}`);
        }
    }
    return result;
}
