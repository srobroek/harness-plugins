/**
 * What to do after a model failure: which model a role falls back to, whether the
 * failed session is retried, and the notes the plugin shows. Pure.
 */
import { failureScope, healthKey, isTransient } from "./health.ts";
import { modelText, parseCandidate, resolveRole, } from "./resolve.ts";
export const SOURCE = "srobroek.model-roles";
const label = modelText;
/** Roles that list `failed` directly, in name order. */
export function rolesListing(options, failed) {
    return Object.keys(options.roles)
        .sort()
        .filter((role) => (options.roles[role] ?? []).some((entry) => {
        const candidate = parseCandidate(entry);
        return candidate?.kind === "model" && healthKey(candidate.ref) === healthKey(failed);
    }));
}
/**
 * The role to fall back within and the model it now resolves to: the failed agent's
 * own role, else the first role that lists the failed model and now resolves elsewhere.
 */
export function fallbackTarget(options, available, health, role, failed) {
    const within = role !== undefined && Object.hasOwn(options.roles, role) ? [role] : rolesListing(options, failed);
    for (const candidate of within) {
        const model = resolveRole(options.roles, available, candidate, health).model;
        if (model !== undefined && healthKey(model) !== healthKey(failed))
            return { role: candidate, model };
    }
    return undefined;
}
/** Retries the host may spend on the same model for a transient failure before the retry hook switches. */
export const DEFAULT_HOST_RETRIES = 2;
/** Retries on the same model for a transient failure the host would not retry, when there is nowhere to switch. */
export const SAME_MODEL_RETRIES = 5;
/** How long the retry hook waits for `session.switchModel` before leaving the host's decision alone. */
export const DEFAULT_SWITCH_TIMEOUT_MS = 2_000;
/**
 * Whether a failed request should stay on its model for now: a transient failure
 * (throttling, overload, an outage, credentials that did not load) within the host's
 * retry budget. Permanent ones (spent quota, auth, an unknown model, a content filter)
 * switch at once.
 */
export function staysOnModel(kind, attempt, hostRetries) {
    return isTransient(kind) && attempt - 1 <= hostRetries;
}
/**
 * Whether a transient failure the host would not retry is retried on its model anyway:
 * within the host's budget, and after it while there is nowhere to switch, up to
 * `SAME_MODEL_RETRIES` retries.
 */
export function retriesOnModel(kind, attempt, hostRetries) {
    return isTransient(kind) && attempt - 1 <= Math.max(hostRetries, SAME_MODEL_RETRIES);
}
/** The backoff before retry `attempt` (2 for the first) on the same model: 2 s, doubling, at most 30 s. */
export function retryDelay(attempt) {
    return Math.min(30_000, 1_000 * 2 ** Math.max(1, attempt - 1));
}
/**
 * The model the retry hook switches a failing request to: the next healthy candidate
 * of the session's role. Never one that is cooling down or failed recently, so two
 * failing models cannot trade places; when nothing healthy is left the host's own
 * decision stands.
 */
export function retryTarget(facts) {
    if (staysOnModel(facts.kind, facts.attempt, facts.hostRetries))
        return undefined;
    const within = facts.role !== undefined && Object.hasOwn(facts.options.roles, facts.role) ? [facts.role] : rolesListing(facts.options, facts.failed);
    for (const role of within) {
        const resolution = resolveRole(facts.options.roles, facts.available, role, facts.health);
        if (resolution.model === undefined || resolution.unhealthy)
            continue;
        if (healthKey(resolution.model) === healthKey(facts.failed))
            continue;
        return { role, model: resolution.model };
    }
    return undefined;
}
/** A cooldown as text: seconds, minutes or hours. */
export function duration(ms) {
    if (ms < 60_000)
        return `${Math.round(ms / 1_000)} s`;
    if (ms < 3_600_000)
        return `${Math.round(ms / 60_000)} min`;
    return `${Math.round((ms / 3_600_000) * 10) / 10} h`;
}
/** What happened and, when the model now sits out, what its tier resolves to. */
export function failureNote(facts) {
    const failed = `Model ${label(facts.failed)} failed (${facts.kind})`;
    if (facts.cooldownMs <= 0)
        return `${failed}; it stays in use unless it keeps failing.`;
    const scope = facts.scope ?? failureScope(facts.kind);
    const who = scope === "provider" ? `every ${facts.failed.providerID} model` : "it";
    const head = `${failed}; ${who} sits out new resolutions for ${duration(facts.cooldownMs)}.`;
    if (facts.target === undefined)
        return `${head} No other candidate is available for it.`;
    return `${head} Tier ${facts.target.role} now resolves to ${label(facts.target.model)}.`;
}
/** The note for a request the retry hook moved to another model. */
export function switchNote(facts) {
    return `${failureNote(facts)} The request was retried on ${label(facts.target.model)}.`;
}
export function subagentNote(facts) {
    const who = facts.agent === undefined ? "A subagent" : `Subagent '${facts.agent}'`;
    let retry;
    if (facts.cooldownMs <= 0)
        retry = facts.resumable === undefined ? "The spawn may be retried as is." : `Resume it with sessionID ${facts.resumable}, or spawn it again.`;
    else if (facts.target === undefined)
        retry = "Retrying it would hit the same model; pick another agent or tier.";
    else if (facts.spawnRole !== undefined) {
        retry = `Spawn it again with tier: "${facts.spawnRole}"; that tier now runs ${label(facts.target.model)}.`;
        if (facts.resumable !== undefined)
            retry += ` Or resume it with sessionID ${facts.resumable}; it was switched to that model.`;
    }
    else
        retry = "The spawn may be retried: it now resolves to the next model.";
    return `${who} failed. ${failureNote(facts)} ${retry}`;
}
/** The receipt fallback reason for a session moved to a larger-context candidate. */
export const CONTEXT_FALLBACK_REASON = "context-length";
/**
 * The first candidate with a strictly larger context window than `failed`. A limit that is
 * unknown, on either side, never counts as larger, and neither does an equal one: the same
 * prompt would fail there too.
 */
export function contextFallback(candidates, failed, limits) {
    const own = limits.get(healthKey(failed));
    if (own === undefined)
        return undefined;
    return candidates.find((candidate) => {
        const limit = limits.get(healthKey(candidate));
        return healthKey(candidate) !== healthKey(failed) && limit !== undefined && limit > own;
    });
}
const tokens = (limit) => (limit === undefined ? "unknown limit" : `${limit} tokens`);
/** The note when a larger-context candidate exists: where the session now runs, or which model to switch to. */
export function contextSwitchNote(facts) {
    const head = `context too long for ${label(facts.failed)} (${tokens(facts.limit)})`;
    const target = `${label(facts.target)} (${tokens(facts.targetLimit)})`;
    if (facts.resumable !== undefined)
        return `${head}; the session now runs ${target}. Resume it with sessionID ${facts.resumable} to continue on the larger context.`;
    const where = facts.tier === undefined ? "its tier" : `tier ${facts.tier}`;
    return `${head}; ${where} has a larger-context candidate, ${target}. Switch to it or compact the session.`;
}
/** The tool error's note when a larger-context candidate exists: it switches nothing, the child's failure report does. */
export function contextPendingSwitchNote(facts) {
    return `context too long for ${label(facts.failed)} (${tokens(facts.limit)}); model-roles moves it to ${label(facts.target)} (${tokens(facts.targetLimit)}) when its failure is reported.`;
}
/** The note when no candidate of the tier can take a prompt that was too long. */
/** The note for an overflow of a child whose model the user chose (a spawn `model` or an agent pin): it is never switched. */
export function pinnedContextNote(failed, limit) {
    return `context too long for ${label(failed)} (${tokens(limit)}); ${label(failed)} was chosen explicitly, so model-roles does not switch it. Compact the session, or spawn with a larger-context model.`;
}
export function contextNote(failed, limit, tier) {
    const where = tier === undefined ? "its tier" : `tier ${tier}`;
    return `context too long for ${label(failed)} (${tokens(limit)}); no larger-context candidate in ${where}. Compact the session or use a tier with a larger-context model`;
}
