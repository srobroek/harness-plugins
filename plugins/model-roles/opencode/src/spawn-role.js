/**
 * The `tier` parameter (and its `role` alias) on the built-in `subagent` tool, and the
 * runtime options for `srobroek.model-roles`. Pure: the plugin applies these inside its
 * tool transform and its `execute.before` hook.
 */
import { DEFAULT_HOST_RETRIES, DEFAULT_SWITCH_TIMEOUT_MS } from "./fallback.ts";
import { inputCost } from "./guard.ts";
import { DEFAULT_COOLDOWN_MS, DEFAULT_FLAP_COUNT, DEFAULT_FLAP_WINDOW_MS, DEFAULT_MAX_COOLDOWN_MS, DEFAULT_QUOTA_COOLDOWN_MS, } from "./health.ts";
import { isAvailable, parseCandidate, resolveRole, } from "./resolve.ts";
import { INHERIT_NAMES, resolveTier, TIER_PURPOSE, tierOf } from "./tiers.ts";
export const TIER_PARAM = "tier";
/** The deprecated name of `tier`, still accepted; it also takes the old role names. */
export const ROLE_PARAM = "role";
/** When the parent should pick each well-known tier or old role name. */
export const ROLE_PURPOSE = {
    ...TIER_PURPOSE,
    smol: TIER_PURPOSE.cheap,
    task: TIER_PURPOSE.standard,
    slow: TIER_PURPOSE.strong,
    challenger: TIER_PURPOSE.reviewer,
};
/** Appended to the `subagent` tool description when the `tier` parameter is offered. */
export const ROLE_TOOL_NOTE = "Set `tier` on every new spawn: it picks the model the subagent runs on. Choose the cheapest tier that fits the task. An explicit `model` overrides it; a resumed spawn (`sessionID`) keeps its model unless it passes `tier` or `model`.";
/** The description of the deprecated `role` parameter. */
export const ROLE_ALIAS_DESCRIPTION = "Deprecated: use `tier`. Also accepts the old role names (smol, task, slow, challenger and the like).";
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** Normalise the fallback options and the role purposes. Purposes keep only configured roles. */
export function parseRuntime(raw, options) {
    const input = isRecord(raw) ? raw : {};
    const cooldownMs = typeof input.cooldownMs === "number" && Number.isFinite(input.cooldownMs) && input.cooldownMs >= 0
        ? input.cooldownMs
        : DEFAULT_COOLDOWN_MS;
    const purposes = {};
    if (isRecord(input.purposes)) {
        for (const [role, text] of Object.entries(input.purposes)) {
            if (typeof text === "string" && text.trim() !== "" && Object.hasOwn(options.roles, role))
                purposes[role] = text.trim();
        }
    }
    const count = (value, fallback) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
    const span = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
    const flapCount = count(input.flapCount, DEFAULT_FLAP_COUNT);
    return {
        runtimeFallback: input.runtimeFallback !== false,
        cooldownMs,
        maxCooldownMs: Math.max(cooldownMs, span(input.maxCooldownMs, DEFAULT_MAX_COOLDOWN_MS)),
        quotaCooldownMs: span(input.quotaCooldownMs, DEFAULT_QUOTA_COOLDOWN_MS),
        flapCount: flapCount >= 1 ? flapCount : DEFAULT_FLAP_COUNT,
        flapWindowMs: span(input.flapWindowMs, DEFAULT_FLAP_WINDOW_MS),
        hostRetries: count(input.hostRetries, DEFAULT_HOST_RETRIES),
        switchTimeoutMs: span(input.switchTimeoutMs, DEFAULT_SWITCH_TIMEOUT_MS),
        purposes,
    };
}
/** A short cost label from an input price in USD per million tokens. */
export function costTier(input) {
    if (input === undefined)
        return "cost unknown";
    const tier = input < 1 ? "low cost" : input < 4 ? "medium cost" : "high cost";
    return `${tier}, $${input}/M input tokens`;
}
/**
 * The lowest input cost among a role's available candidates, following `@role` links.
 * Health is ignored, so the figure only moves when availability does.
 */
export function cheapestCost(roles, available, role) {
    let cheapest;
    const seen = new Set();
    const walk = (current) => {
        if (seen.has(current) || !Object.hasOwn(roles, current))
            return;
        seen.add(current);
        for (const entry of roles[current] ?? []) {
            const candidate = parseCandidate(entry);
            if (candidate === undefined)
                continue;
            if (candidate.kind === "role") {
                walk(candidate.role);
                continue;
            }
            if (!isAvailable(candidate.ref, available))
                continue;
            const cost = inputCost(candidate.ref, available);
            if (cost !== undefined && (cheapest === undefined || cost < cheapest))
                cheapest = cost;
        }
    };
    walk(role);
    return cheapest;
}
/**
 * The tiers a spawner may pass, with their purpose and cost class. With a tier table
 * that is its tiers in display order; without one, every role in name order.
 */
export function roleChoices(options, available, purposes = {}) {
    if (options.tiers !== undefined)
        return Object.entries(options.tiers).map(([role, meta]) => ({
            role,
            purpose: meta.purpose,
            cost: cheapestCost(options.roles, available, role),
            available: resolveRole(options.roles, available, role).model !== undefined,
            costText: meta.cost,
        }));
    return Object.keys(options.roles)
        .sort()
        .map((role) => ({
        role,
        purpose: purposes[role] ?? ROLE_PURPOSE[role] ?? `work that suits the '${role}' model role`,
        cost: cheapestCost(options.roles, available, role),
        available: resolveRole(options.roles, available, role).model !== undefined,
    }));
}
/** Choices for the named tiers or old role names, in the order given; unknown names are left out. */
export function choicesFor(names, options, available, purposes = {}) {
    const listed = new Map(roleChoices(options, available, purposes).map((choice) => [choice.role, choice]));
    return names
        .filter((name) => Object.hasOwn(options.roles, name))
        .map((name) => listed.get(name) ?? {
        role: name,
        purpose: purposes[name] ?? options.tiers?.[tierOf(name)]?.purpose ?? ROLE_PURPOSE[name] ?? `work that suits the '${name}' model role`,
        cost: cheapestCost(options.roles, available, name),
        available: resolveRole(options.roles, available, name).model !== undefined,
    });
}
export function describeChoice(choice) {
    const tier = !choice.available
        ? "no model available now; the agent's own model applies"
        : (choice.costText ?? costTier(choice.cost));
    return `'${choice.role}': ${choice.purpose} (${tier})`;
}
/** The `tier` parameter's description: one line per tier. */
export function roleParamDescription(choices) {
    return [
        "Model tier the subagent runs on. Pick the cheapest one that fits the task:",
        ...choices.map((choice) => `- ${describeChoice(choice)}`),
    ].join("\n");
}
const JSON_TYPES = { String: "string", Boolean: "boolean", Number: "number" };
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The `subagent` tool's input as JSON Schema. Accepts a JSON Schema object as is, or
 * reads an Effect struct's AST of plain strings, booleans and numbers. Anything else
 * returns `undefined`, so the caller leaves the schema alone.
 */
export function toJsonSchema(input) {
    if (isRecord(input) && input.type === "object" && isRecord(input.properties))
        return structuredClone(input);
    const ast = input?.ast;
    if (!isRecord(ast) || ast._tag !== "Objects" || !Array.isArray(ast.propertySignatures))
        return undefined;
    if (Array.isArray(ast.indexSignatures) && ast.indexSignatures.length > 0)
        return undefined;
    const properties = {};
    const required = [];
    for (const signature of ast.propertySignatures) {
        if (!isRecord(signature) || typeof signature.name !== "string" || !isRecord(signature.type))
            return undefined;
        const type = signature.type;
        const json = typeof type._tag === "string" ? JSON_TYPES[type._tag] : undefined;
        if (json === undefined)
            return undefined;
        const property = { type: json };
        let description = isRecord(type.annotations) && typeof type.annotations.description === "string" ? type.annotations.description : undefined;
        for (const check of Array.isArray(type.checks) ? type.checks : []) {
            const annotations = isRecord(check) && isRecord(check.annotations) ? check.annotations : {};
            if (typeof annotations.description === "string")
                description ??= annotations.description;
            const representation = isRecord(annotations.representation) ? annotations.representation : {};
            const payload = isRecord(representation.payload) ? representation.payload : {};
            if (representation.id === "effect/schema/isStartingWith" && typeof payload.startsWith === "string")
                property.pattern = `^${escapeRegExp(payload.startsWith)}`;
        }
        if (description !== undefined)
            property.description = description;
        properties[signature.name] = property;
        const optional = isRecord(type.context) && type.context.isOptional === true;
        if (!optional)
            required.push(signature.name);
    }
    return { type: "object", properties, required, additionalProperties: false };
}
/** `schema` with an optional `tier` enum over `tiers`, and the deprecated free-form `role`. */
export function withRoleParam(schema, tiers, description) {
    const next = structuredClone(schema);
    next.properties[TIER_PARAM] = { type: "string", enum: [...tiers], description };
    next.properties[ROLE_PARAM] = { type: "string", description: ROLE_ALIAS_DESCRIPTION };
    next.required = (next.required ?? []).filter((name) => name !== ROLE_PARAM && name !== TIER_PARAM);
    return next;
}
/** The tool description with the role note appended once. */
export function withRoleNote(description) {
    return description.includes(ROLE_TOOL_NOTE) ? description : `${description.trimEnd()}\n${ROLE_TOOL_NOTE}`;
}
const SUBAGENTS_HEADING = "\n\nAvailable subagents:";
/** The parameters to freeze from the `subagent` tool's current input schema. */
export function captureTierParam(input) {
    const properties = isRecord(input) && isRecord(input.properties) ? input.properties : {};
    const tier = properties[TIER_PARAM];
    const role = properties[ROLE_PARAM];
    if (!isRecord(tier))
        return {};
    return { tier: structuredClone(tier), ...(isRecord(role) ? { role: structuredClone(role) } : {}) };
}
/** A stored {@link FrozenTierParam}, or `undefined` when the value is not one. */
export function readFrozenTierParam(value) {
    if (!isRecord(value))
        return undefined;
    if (value.tier !== undefined && !isRecord(value.tier))
        return undefined;
    if (value.role !== undefined && !isRecord(value.role))
        return undefined;
    return {
        ...(isRecord(value.tier) ? { tier: value.tier } : {}),
        ...(isRecord(value.role) ? { role: value.role } : {}),
    };
}
/**
 * The `subagent` tool with `frozen` in place of whatever `tier` and `role` it has now:
 * the two parameters go last, after every other plugin's, so the schema bytes do not depend
 * on the order the tool transforms ran in, and the role note follows the frozen `tier`.
 */
export function applyFrozenTierParam(tool, frozen) {
    const input = tool.input;
    if (!isRecord(input) || !isRecord(input.properties))
        return tool;
    const properties = {};
    for (const [name, value] of Object.entries(input.properties))
        if (name !== TIER_PARAM && name !== ROLE_PARAM)
            properties[name] = value;
    if (frozen.tier !== undefined)
        properties[TIER_PARAM] = frozen.tier;
    if (frozen.tier !== undefined && frozen.role !== undefined)
        properties[ROLE_PARAM] = frozen.role;
    const next = { ...input, properties };
    if (Array.isArray(input.required))
        next.required = input.required.filter((name) => name !== TIER_PARAM && name !== ROLE_PARAM);
    let description = tool.description;
    const noted = description.includes(ROLE_TOOL_NOTE);
    if (frozen.tier === undefined && noted)
        description = description.replace(`\n${ROLE_TOOL_NOTE}`, "").replace(ROLE_TOOL_NOTE, "");
    if (frozen.tier !== undefined && !noted) {
        const at = description.indexOf(SUBAGENTS_HEADING);
        description = at === -1 ? withRoleNote(description) : `${withRoleNote(description.slice(0, at))}${description.slice(at)}`;
    }
    return { description, input: next };
}
export const modelLabel = (ref) => `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`;
/**
 * Apply the `tier` (or deprecated `role`) argument of one `subagent` call. Precedence:
 * an explicit `model`, then the target agent's user pin (`pinned`: the tier is dropped),
 * then `tier`, then `role`, then whatever the agent itself resolves to (its tier in the
 * `agents` option or header, its fallback model, or inheritance), which the host applies.
 * `callerVendor` puts another vendor first for a tier with `distinctVendor`.
 */
export function planSpawn(input, options, available, health, callerVendor, pinned = false) {
    if (!isRecord(input) || (!Object.hasOwn(input, ROLE_PARAM) && !Object.hasOwn(input, TIER_PARAM)))
        return { input };
    const { [ROLE_PARAM]: rawRole, [TIER_PARAM]: rawTier, ...rest } = input;
    const tier = typeof rawTier === "string" ? rawTier.trim() : "";
    const role = tier !== "" ? tier : typeof rawRole === "string" ? rawRole.trim() : "";
    if (role === "" || INHERIT_NAMES.includes(role))
        return { input: rest };
    if (typeof rest.sessionID === "string" && rest.sessionID !== "")
        return { input: rest };
    if (typeof rest.model === "string" && rest.model.trim() !== "")
        return { input: rest };
    if (!Object.hasOwn(options.roles, role)) {
        const known = options.tiers !== undefined ? Object.keys(options.tiers) : Object.keys(options.roles).sort();
        return {
            input: rest,
            error: `Unknown model tier '${role}'. Pass one of: ${known.join(", ") || "(none configured)"}.`,
        };
    }
    if (pinned)
        return { input: rest };
    const model = resolveTier(options, available, role, health, callerVendor).model;
    if (model === undefined)
        return { input: rest, role };
    return { input: { ...rest, model: modelLabel(model) }, role, model };
}
/** The model a spawn's `model` argument names, if any. */
export function inputModel(input) {
    if (!isRecord(input) || typeof input.model !== "string")
        return undefined;
    const candidate = parseCandidate(input.model);
    return candidate?.kind === "model" ? candidate.ref : undefined;
}
/** Storage key for the role a child session was spawned with. */
export const SPAWN_ROLE_KEY_PREFIX = "spawn-role:";
/** Storage key for the `tier` parameter a session first saw. */
export const TIER_FREEZE_KEY_PREFIX = "tier-param:";
