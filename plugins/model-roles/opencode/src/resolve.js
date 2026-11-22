/**
 * Pure role resolution for `srobroek.model-roles`. Nothing here touches the
 * plugin context, so every rule is tested directly.
 */
/** Agent request header that names the agent's tier. */
export const ROLE_HEADER = "x-opencode-model-role";
/**
 * Agent request header naming the model a plugin set as a fallback (`provider/model#variant`).
 * An agent model equal to it gives way to the agent's tier; any other model is a user pin.
 */
export const FALLBACK_HEADER = "x-opencode-model-fallback";
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** Normalise raw plugin options, dropping anything malformed. */
export function parseOptions(raw) {
    const input = isRecord(raw) ? raw : {};
    const roles = {};
    if (isRecord(input.roles)) {
        for (const [role, value] of Object.entries(input.roles)) {
            const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
            roles[role] = list.filter((entry) => typeof entry === "string" && entry.trim() !== "");
        }
    }
    const agents = {};
    if (isRecord(input.agents)) {
        for (const [agent, role] of Object.entries(input.agents)) {
            if (typeof role === "string" && role.trim() !== "")
                agents[agent] = role.trim();
        }
    }
    return { roles, agents, fallback: "keep" };
}
/** Parse `provider/model#variant` or `@role`. Returns undefined for anything else. */
export function parseCandidate(input) {
    const text = input.trim();
    if (text.startsWith("@")) {
        const role = text.slice(1).trim();
        return role === "" ? undefined : { kind: "role", role };
    }
    const slash = text.indexOf("/");
    if (slash <= 0)
        return undefined;
    const providerID = text.slice(0, slash);
    const rest = text.slice(slash + 1);
    const hash = rest.lastIndexOf("#");
    const id = hash < 0 ? rest : rest.slice(0, hash);
    const variant = hash < 0 ? undefined : rest.slice(hash + 1);
    if (id === "" || variant === "")
        return undefined;
    return { kind: "model", ref: variant === undefined ? { providerID, id } : { providerID, id, variant } };
}
/** Whether `ref` names an enabled available model and, if it has one, an existing variant. */
export function isAvailable(ref, available) {
    const model = available.find((m) => m.providerID === ref.providerID && m.id === ref.id && m.enabled !== false);
    if (model === undefined)
        return false;
    if (ref.variant === undefined)
        return true;
    return (model.variants ?? []).some((v) => v.id === ref.variant);
}
/**
 * Resolve a role to its first available, healthy candidate, following `@role` links
 * depth-first. A link back into the current chain is skipped, as is a link to an
 * unknown role. When every available candidate is unhealthy, the one that failed
 * longest ago wins, so a role never resolves to nothing just because of a cooldown.
 */
export function resolveRole(roles, available, role, health = () => undefined) {
    if (!Object.hasOwn(roles, role))
        return { model: undefined, reason: "unknown-role" };
    let stale;
    const walk = (current, chain) => {
        for (const entry of roles[current] ?? []) {
            const candidate = parseCandidate(entry);
            if (candidate === undefined)
                continue;
            if (candidate.kind === "model") {
                if (!isAvailable(candidate.ref, available))
                    continue;
                const failedAt = health(candidate.ref);
                if (failedAt === undefined)
                    return { model: candidate.ref, via: chain };
                if (stale === undefined || failedAt < stale.failedAt)
                    stale = { model: candidate.ref, via: chain, failedAt };
                continue;
            }
            if (chain.includes(candidate.role) || !Object.hasOwn(roles, candidate.role))
                continue;
            const found = walk(candidate.role, [...chain, candidate.role]);
            if (found)
                return found;
        }
        return undefined;
    };
    const found = walk(role, [role]);
    if (found)
        return found;
    if (stale)
        return { model: stale.model, via: stale.via, unhealthy: true };
    return { model: undefined, reason: "unavailable" };
}
function headerValue(agent, header) {
    for (const [name, value] of Object.entries(agent.request?.headers ?? {})) {
        if (name.toLowerCase() === header && value.trim() !== "")
            return value.trim();
    }
    return undefined;
}
/**
 * The model the user pinned on an agent (`agents.<id>.model` in config, or a markdown
 * agent's `model`): its own model, unless the fallback header marks that model as a
 * plugin's fallback. A pin wins over every tier the agent has.
 */
export function userPin(agent) {
    if (agent.model === undefined)
        return undefined;
    const marked = headerValue(agent, FALLBACK_HEADER);
    const candidate = marked === undefined ? undefined : parseCandidate(marked);
    if (candidate?.kind === "model" && sameModel(candidate.ref, agent.model))
        return undefined;
    return agent.model;
}
/** The tier an agent declares and where from: plugin options win over the request header, which wins over `implicit`. */
export function agentTier(agent, agents, implicit = {}) {
    if (Object.hasOwn(agents, agent.id))
        return { tier: agents[agent.id], source: "options" };
    const header = headerValue(agent, ROLE_HEADER);
    if (header !== undefined)
        return { tier: header, source: "header" };
    if (Object.hasOwn(implicit, agent.id))
        return { tier: implicit[agent.id], source: "implicit" };
    return undefined;
}
/** The tier an agent declares: plugin options win over the request header, which wins over `implicit`. */
export function roleOf(agent, agents, implicit = {}) {
    return agentTier(agent, agents, implicit)?.tier;
}
/**
 * The model each role-bearing agent should get. Agents the user pinned to a model,
 * and agents whose role is unknown or has nothing available, are absent, so their
 * own model (or inheritance) stays.
 */
export function desiredModels(agents, options, available, health) {
    const result = new Map();
    for (const agent of agents) {
        if (userPin(agent) !== undefined)
            continue;
        const role = roleOf(agent, options.agents, options.implicit);
        if (role === undefined)
            continue;
        const resolution = resolveRole(options.roles, available, role, health);
        if (resolution.model)
            result.set(agent.id, resolution.model);
    }
    return result;
}
/** The variant the host reports when none was chosen; labels leave it out. */
export const DEFAULT_VARIANT = "default";
/** `provider/model#variant` for notes and messages, without the host's `#default`. */
export function modelText(ref) {
    const variant = ref.variant === undefined || ref.variant === DEFAULT_VARIANT ? "" : `#${ref.variant}`;
    return `${ref.providerID}/${ref.id}${variant}`;
}
/** Field-wise model comparison; key order and an absent vs undefined variant do not matter. */
export function sameModel(a, b) {
    if (a === undefined || b === undefined)
        return a === b;
    return a.providerID === b.providerID && a.id === b.id && (a.variant ?? undefined) === (b.variant ?? undefined);
}
/** Ids of agents whose current model differs from the one their role resolves to. */
export function staleAgents(agents, desired) {
    return agents.filter((a) => desired.has(a.id) && !sameModel(a.model, desired.get(a.id))).map((a) => a.id);
}
/** Remove the role and fallback headers (any casing) from outgoing request headers. Returns whether one was removed. */
export function stripRoleHeader(headers) {
    let removed = false;
    for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (lower === ROLE_HEADER || lower === FALLBACK_HEADER) {
            delete headers[name];
            removed = true;
        }
    }
    return removed;
}
