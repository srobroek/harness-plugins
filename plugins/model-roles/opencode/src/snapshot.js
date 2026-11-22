/**
 * The model a child session resolved to, kept for its lifetime: a resume reuses it, so a
 * `/tiers` save or a reload never moves a running child. Pure; the plugin persists it as
 * `spawn-model:<childID>`, next to `spawn-role:<childID>`.
 */
import { textHash } from "./classify.ts";
import { parseCandidate } from "./resolve.ts";
/** Storage key prefix for a child's resolved model. */
export const SPAWN_MODEL_KEY_PREFIX = "spawn-model:";
export const SNAPSHOT_LIMIT = 1000;
export const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** JSON with object keys sorted, so equal configs give equal text. */
const stable = (value) => {
    if (Array.isArray(value))
        return `[${value.map(stable).join(",")}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
};
/** A stable hash of the effective tier config: the tiers and the candidate lists they resolve through. */
export const configRevision = (options) => textHash(stable({ roles: options.roles, tiers: options.tiers ?? {} }));
/** A stored snapshot, or `undefined` when it is missing or malformed. */
export function readSnapshot(value) {
    if (!isRecord(value) || typeof value.model !== "string" || typeof value.configRevision !== "string" || typeof value.at !== "number")
        return undefined;
    if (parseCandidate(value.model)?.kind !== "model")
        return undefined;
    const snapshot = { model: value.model, configRevision: value.configRevision, at: value.at };
    if (typeof value.tier === "string")
        snapshot.tier = value.tier;
    if (isRecord(value.explore) && typeof value.explore.arm === "string" && typeof value.explore.p === "number" && typeof value.explore.policy === "string" && Array.isArray(value.explore.eligible))
        snapshot.explore = { policy: value.explore.policy, eligible: value.explore.eligible.filter((a) => typeof a === "string"), arm: value.explore.arm, p: value.explore.p };
    if (value.failedOver === true)
        snapshot.failedOver = true;
    if (value.rule === "guard-reroute" || value.rule === "explicit-model" || value.rule === "agent-pin")
        snapshot.rule = value.rule;
    if (Array.isArray(value.overflowed)) {
        const overflowed = value.overflowed.filter((entry) => typeof entry === "string");
        if (overflowed.length > 0)
            snapshot.overflowed = overflowed;
    }
    return snapshot;
}
/** Whether the child's prompt already overflowed `model`, whatever the variant. */
export function hasOverflowed(snapshot, model) {
    return (snapshot?.overflowed ?? []).some((entry) => {
        const candidate = parseCandidate(entry);
        return candidate?.kind === "model" && candidate.ref.providerID === model.providerID && candidate.ref.id === model.id;
    });
}
/** The model a snapshot names, if it still parses. */
export function snapshotModel(snapshot) {
    const candidate = parseCandidate(snapshot.model);
    return candidate?.kind === "model" ? candidate.ref : undefined;
}
/** Why `model` cannot run now (no such model, disabled, or no such variant), or `undefined` when it can. */
export function unavailableReason(model, available) {
    const listed = available.find((m) => m.providerID === model.providerID && m.id === model.id);
    if (listed === undefined)
        return "the model is unknown";
    if (listed.enabled === false)
        return "the model is unavailable";
    if (model.variant !== undefined && !(listed.variants ?? []).some((v) => v.id === model.variant))
        return `the model has no variant '${model.variant}'`;
    return undefined;
}
/**
 * Keys to delete: unreadable or older than `maxAgeMs`, then the oldest beyond `limit`. A key in `open`
 * (a child that never ended) is exempt from the age: after a restart the host resumes every child whose
 * execution claim was never released, however long ago it began (opencode v2.3.0
 * `packages/core/src/session/execution/restart.ts:368-466`). `limit` still bounds them, and the ledger
 * drops an open record at its own age.
 */
export function staleSnapshots(entries, now, limit = SNAPSHOT_LIMIT, maxAgeMs = SNAPSHOT_MAX_AGE_MS, open = new Set()) {
    const stale = [];
    const live = [];
    for (const { key, value } of entries) {
        const snapshot = readSnapshot(value);
        if (snapshot === undefined || (now - snapshot.at > maxAgeMs && !open.has(key)))
            stale.push(key);
        else
            live.push({ key, at: snapshot.at });
    }
    live.sort((a, b) => b.at - a.at);
    for (const { key } of live.slice(limit))
        stale.push(key);
    return stale;
}
