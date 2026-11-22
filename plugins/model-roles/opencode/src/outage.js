/**
 * When a failure is worth a note, and which text. A provider-wide failure class (auth,
 * credentials, quota, outage) is one provider outage: one note when it starts, one line per
 * stopped subagent session, one note when the first call succeeds again. A per-model failure
 * is rate limited per (parent session, model, class). Pure over an explicit state.
 */
import { failureNote } from "./fallback.ts";
import { FAILURE_CLASSES, failureScope, healthKey } from "./health.ts";
/** A model's failure notice repeats at most once in this window. */
export const NOTICE_DEDUPE_MS = 60_000;
/** An outage whose failures stopped this long ago and never saw a success is announced afresh. */
export const OUTAGE_STALE_MS = 15 * 60_000;
export const newNoticeState = () => ({ outages: new Map(), notices: new Map(), contextNotices: new Map(), events: new Map() });
/** Event ids remembered; the oldest go first. */
export const MAX_EVENTS = 500;
/** Whether the event `id` is still to be handled, and claim it. An event without an id is always handled. */
export function claimEvent(state, id, now) {
    if (id === undefined)
        return true;
    if (state.events.has(id))
        return false;
    state.events.set(id, now);
    if (state.events.size > MAX_EVENTS)
        state.events.delete(state.events.keys().next().value);
    return true;
}
const SHARED = Symbol.for("srobroek.model-roles.notice-state");
/**
 * The notice state every instance of the plugin in this process shares (a reload or a second load
 * would otherwise start from nothing and repeat notices). `holder` is `globalThis`. A state left by an
 * older build is kept and gains the maps it lacks. `first` is true for the instance that creates it,
 * which restores the persisted outages.
 */
export function acquireNoticeState(holder) {
    const found = holder[SHARED];
    if (found === undefined || typeof found.state !== "object" || found.state === null) {
        const shared = { state: newNoticeState(), refs: 1 };
        holder[SHARED] = shared;
        return { state: shared.state, first: true };
    }
    const fresh = newNoticeState();
    for (const key of Object.keys(fresh))
        if (!(found.state[key] instanceof Map))
            found.state[key] = fresh[key];
    found.refs = (Number.isFinite(found.refs) ? found.refs : 0) + 1;
    return { state: found.state, first: false };
}
/** An instance is done with the shared state; the last one drops it. */
export function releaseNoticeState(holder) {
    const found = holder[SHARED];
    if (found === undefined)
        return;
    found.refs -= 1;
    if (found.refs <= 0)
        delete holder[SHARED];
}
/** Storage key of the persisted outages. */
export const OUTAGES_KEY = "outages";
/** The open outages as plain data for `ctx.storage`. */
export function snapshotOutages(state) {
    return [...state.outages.values()].map((o) => ({ providerID: o.providerID, kind: o.kind, lastAt: o.lastAt, notifyTo: o.notifyTo, stopped: [...o.stopped] }));
}
const optionalString = (value) => (typeof value === "string" ? value : undefined);
/** Load persisted outages into `state`; anything malformed is skipped, and open outages are never replaced. */
export function restoreOutages(state, raw) {
    if (!Array.isArray(raw))
        return;
    for (const item of raw) {
        if (typeof item !== "object" || item === null)
            continue;
        const o = item;
        if (typeof o.providerID !== "string" || typeof o.notifyTo !== "string" || typeof o.lastAt !== "number" || !Array.isArray(o.stopped))
            continue;
        if (typeof o.kind !== "string" || !FAILURE_CLASSES.includes(o.kind))
            continue;
        const key = `${o.providerID}\0${o.kind}`;
        if (state.outages.has(key))
            continue;
        const stopped = new Map();
        for (const entry of o.stopped.slice(-MAX_TRACKED)) {
            if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "object" || entry[1] === null)
                continue;
            const s = entry[1];
            stopped.set(entry[0], { agent: optionalString(s.agent), sessionID: optionalString(s.sessionID), parent: optionalString(s.parent) });
        }
        state.outages.set(key, { providerID: o.providerID, kind: o.kind, lastAt: o.lastAt, notifyTo: o.notifyTo, stopped });
    }
}
/**
 * Whether the context overflow of one execution of `sessionID` is still to be handled, and claim it.
 * The failure event and the `subagent` tool error of one execution claim once, so the parent hears
 * once. A later execution (a resume) has its own claim. `execution` is the id of the event that
 * started the execution, when known. A claim lasts `NOTICE_DEDUPE_MS`; expired claims are dropped.
 */
export function claimContextNotice(state, sessionID, execution, now) {
    for (const [id, at] of state.contextNotices)
        if (now - at >= NOTICE_DEDUPE_MS)
            state.contextNotices.delete(id);
    const key = `${sessionID}\0${execution ?? ""}`;
    if (state.contextNotices.has(key))
        return false;
    state.contextNotices.set(key, now);
    return true;
}
/**
 * Whether the parent's `subagent` tool error may post the context note for `sessionID`, and claim it.
 * It may only when no notice of that session is live: the child's failure event owns the switch and
 * its note, and a late tool error of an earlier execution must not repeat or contradict it.
 */
export function claimToolContextNotice(state, sessionID, now) {
    for (const [id, at] of state.contextNotices)
        if (now - at >= NOTICE_DEDUPE_MS)
            state.contextNotices.delete(id);
    for (const key of state.contextNotices.keys())
        if (key.startsWith(`${sessionID}\0`))
            return false;
    state.contextNotices.set(`${sessionID}\0tool-error`, now);
    return true;
}
/** Whether the parent's tool error already posted the context note for `sessionID`, so the failure event stays quiet. */
export function toolContextNoticeLive(state, sessionID, now) {
    const at = state.contextNotices.get(`${sessionID}\0tool-error`);
    return at !== undefined && now - at < NOTICE_DEDUPE_MS;
}
/**
 * Whether a note of this kind wakes its session. A subagent failure and a recovery name sessions the
 * recipient must resume, so they wake it. A root session's own failure note and a context note
 * (the child already switched) only inform.
 */
export const noticeResumes = (kind) => kind === "subagent-fallback" || kind === "recovery";
const stoppedKey = (report) => report.subagent?.sessionID ?? `${report.notifyTo}\0${report.subagent?.agent ?? ""}`;
const stoppedLine = (stopped, provider, kind, first) => {
    const who = stopped.agent === undefined ? "A subagent" : `Subagent '${stopped.agent}'`;
    const retry = stopped.sessionID === undefined ? "spawn it again" : `resume it with sessionID ${stopped.sessionID}`;
    return first ? `${who} stopped: ${retry} when the provider is back.` : `${who} stopped by the ${provider} outage (${kind}): ${retry} when the provider is back.`;
};
/** The note a failure earns, if any. Updates `state`. */
export function decideFailureNotice(state, report) {
    const { failed, kind, now, notifyTo } = report;
    if (failureScope(kind) === "provider")
        return decideOutage(state, report);
    const key = `${notifyTo}\0${healthKey(failed)}\0${kind}`;
    const last = state.notices.get(key);
    if (last !== undefined && now - last < NOTICE_DEDUPE_MS)
        return undefined;
    state.notices.set(key, now);
    return { sessionID: notifyTo, text: report.plain ?? failureNote(report) };
}
/** The recovery note names this many stopped sessions and counts the rest ("+N more"). */
export const MAX_STOPPED = 20;
/**
 * Stopped sessions an outage remembers, so a repeat failure of a child is not announced again.
 * Past it the oldest are forgotten, so an outage that keeps failing new children stays bounded.
 */
export const MAX_TRACKED = 500;
/** Whether `id` is new to the outage; it is remembered either way. */
function remember(outage, id, stopped) {
    if (outage.stopped.has(id))
        return false;
    outage.stopped.set(id, stopped);
    if (outage.stopped.size > MAX_TRACKED)
        outage.stopped.delete(outage.stopped.keys().next().value);
    return true;
}
function decideOutage(state, report) {
    const { failed, kind, now, notifyTo } = report;
    const provider = failed.providerID;
    const key = `${provider}\0${kind}`;
    const found = state.outages.get(key);
    const outage = found ?? { providerID: provider, kind, lastAt: now, notifyTo, stopped: new Map() };
    // A quiet outage is announced again, but keeps its resume list and dedupe state.
    const announce = found === undefined || now - found.lastAt >= OUTAGE_STALE_MS;
    state.outages.set(key, outage);
    outage.lastAt = now;
    let line;
    if (report.subagent !== undefined) {
        const stopped = { agent: report.subagent.agent, sessionID: report.subagent.sessionID, parent: notifyTo };
        if (remember(outage, stoppedKey(report), stopped))
            line = stoppedLine(stopped, provider, kind, announce);
    }
    if (!announce)
        return line === undefined ? undefined : { sessionID: notifyTo, text: line };
    outage.notifyTo = notifyTo;
    const phase = report.cooldownMs > 0 ? "down" : "failing";
    const head = `Provider ${provider} is ${phase} (${kind}). ${failureNote(report)}`;
    return { sessionID: notifyTo, text: line === undefined ? head : `${head} ${line}` };
}
/** A session was deleted or has run successfully since: it no longer needs resuming. */
export function forgetSession(state, sessionID) {
    for (const key of state.contextNotices.keys())
        if (key.startsWith(`${sessionID}\0`))
            state.contextNotices.delete(key);
    for (const outage of state.outages.values()) {
        outage.stopped.delete(sessionID);
    }
}
/** The recovery notes for a call that succeeded on `model`: every open outage of its provider ends. */
export function decideRecovery(state, model) {
    const notices = [];
    for (const [key, outage] of state.outages) {
        if (outage.providerID !== model.providerID)
            continue;
        state.outages.delete(key);
        // Each stopped child's own parent hears, with its own children; the session that heard the start always does.
        const byParent = new Map([[outage.notifyTo, []]]);
        for (const s of outage.stopped.values()) {
            if (s.sessionID === undefined)
                continue;
            const parent = s.parent ?? outage.notifyTo;
            byParent.set(parent, [...(byParent.get(parent) ?? []), s]);
        }
        for (const [parent, resumable] of byParent) {
            let text = `Provider ${outage.providerID} recovered (${outage.kind}).`;
            if (resumable.length > 0) {
                const list = resumable.slice(0, MAX_STOPPED).map((s) => `${s.agent ?? "subagent"} (${s.sessionID})`);
                if (resumable.length > MAX_STOPPED)
                    list.push(`+${resumable.length - MAX_STOPPED} more`);
                text += ` Resume the stopped subagents: ${list.join(", ")}.`;
            }
            notices.push({ sessionID: parent, text });
        }
    }
    return notices;
}
/** Requests kept per session; a session runs one at a time, so only a backlog of unhandled ends grows it. */
const MAX_REQUESTS = 8;
export function recordRequest(log, sessionID, model, at) {
    const list = log.get(sessionID) ?? [];
    list.push({ at, model: { providerID: model.providerID, id: model.id } });
    if (list.length > MAX_REQUESTS)
        list.shift();
    log.set(sessionID, list);
}
/**
 * The model of the request that an execution ending at `endedAt` ran: the session's latest
 * request started before then. That request and every earlier one are consumed; later requests
 * belong to later executions and stay. The host's end events carry only the session and a
 * timestamp, so the time is the only link between an end and its request.
 */
export function settleRequest(log, sessionID, endedAt) {
    const list = log.get(sessionID);
    if (list === undefined)
        return undefined;
    // Strict: a request's own end comes after its response, so one at the end's millisecond is the next execution's.
    const done = list.filter((entry) => entry.at < endedAt);
    const rest = list.filter((entry) => entry.at >= endedAt);
    if (rest.length > 0)
        log.set(sessionID, rest);
    else
        log.delete(sessionID);
    return done.at(-1)?.model;
}
