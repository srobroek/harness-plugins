/**
 * The optional auto decider for `srobroek.model-roles`: a small model picks a tier
 * for a fresh `general` spawn that names no model and no tier, and an effort for a
 * tier whose effort is `"auto"`. Pure: the plugin calls `ctx.generate.text` with
 * `buildDeciderPrompt` and applies `parseDecision`, `pickRole` and `capRole` in its
 * `execute.before` hook.
 */
import { modelText, parseCandidate, resolveRole, roleOf, } from "./resolve.ts";
import { describeChoice } from "./spawn-role.ts";
import { rankOf } from "./tiers.ts";
/** How long a spawn waits for the decider before it takes the default role. */
export const DEFAULT_AUTO_TIMEOUT_MS = 5000;
/** The longest slice of the spawn prompt the decider sees. */
export const DECIDER_PROMPT_LIMIT = 6000;
/** Auto decisions `model_roles_check` lists, newest first. */
export const AUTO_HISTORY_LIMIT = 20;
export const DEFAULT_AUTO_ROLES = ["cheap", "standard"];
/** The decider runs on the cheap tier at effort none. */
export const DEFAULT_DECIDER = "@tiny";
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * Normalise the `auto` option. `undefined` means auto routing is off. `true` means
 * the defaults. Allowed roles keep only configured ones; with none left it is off.
 */
export function parseAuto(raw, options) {
    if (raw === undefined || raw === false || raw === null)
        return undefined;
    const input = isRecord(raw) ? raw : {};
    if (input.enabled === false)
        return undefined;
    const listed = Array.isArray(input.roles)
        ? input.roles.filter((r) => typeof r === "string").map((r) => r.trim())
        : [...DEFAULT_AUTO_ROLES];
    const roles = [...new Set(listed)].filter((role) => role !== "" && Object.hasOwn(options.roles, role));
    if (roles.length === 0)
        return undefined;
    const wanted = typeof input.default === "string" ? input.default.trim() : "";
    const fallback = roles.includes(wanted)
        ? wanted
        : roles.includes("standard")
            ? "standard"
            : roles.includes("task")
                ? "task"
                : roles[0];
    const decider = typeof input.decider === "string" && input.decider.trim() !== "" ? input.decider.trim() : DEFAULT_DECIDER;
    const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? input.timeoutMs
        : DEFAULT_AUTO_TIMEOUT_MS;
    return { decider, roles, default: fallback, timeoutMs, capAtParent: input.capAtParent !== false };
}
/** The model the decider runs on, or `undefined` when nothing is available for it. */
export function deciderModel(auto, options, available, health) {
    const candidate = parseCandidate(auto.decider);
    if (candidate === undefined)
        return undefined;
    if (candidate.kind === "role")
        return resolveRole(options.roles, available, candidate.role, health).model;
    const listed = available.some((m) => m.providerID === candidate.ref.providerID && m.id === candidate.ref.id && m.enabled !== false);
    return listed ? candidate.ref : undefined;
}
/**
 * Whether auto routing may pick a role for this spawn. Never when the spawn resumes
 * a session, names a model or a role, or its agent has a model or a role of its own.
 */
export function autoEligible(input, agent, options) {
    if (!isRecord(input) || agent === undefined)
        return false;
    if (typeof input.sessionID === "string" && input.sessionID !== "")
        return false;
    if (typeof input.model === "string" && input.model.trim() !== "")
        return false;
    if (typeof input.role === "string" && input.role.trim() !== "")
        return false;
    if (agent.model !== undefined)
        return false;
    return roleOf(agent, options.agents, options.implicit) === undefined;
}
/** The decider prompt. The spawn prompt is cut to `DECIDER_PROMPT_LIMIT` characters. */
export function buildDeciderPrompt(input) {
    const task = input.prompt.length > DECIDER_PROMPT_LIMIT ? `${input.prompt.slice(0, DECIDER_PROMPT_LIMIT)}\n[truncated]` : input.prompt;
    const names = input.choices.map((choice) => choice.role).join(", ");
    const agent = input.agent.description?.trim();
    return [
        "You route a subagent task to a model tier. Reply with ONLY a JSON object, no prose:",
        `{"role": "<one of: ${names}>", "confident": true|false}`,
        "",
        "Tiers:",
        ...input.choices.map((choice) => `- ${describeChoice(choice)}`),
        "",
        "Pick the cheapest tier that fits the task. Set confident to false when the task is ambiguous.",
        "",
        `Agent: ${input.agent.id}${agent ? ` — ${agent}` : ""}`,
        `Spawn description: ${input.description?.trim() || "(none)"}`,
        "Task:",
        "<<<",
        task,
        ">>>",
    ].join("\n");
}
/**
 * Read the decider's reply: the first JSON object in it, code fence or not. A role
 * outside `allowed` or a missing `confident` flag is no decision.
 */
export function parseDecision(text, allowed) {
    const start = text.indexOf("{");
    const end = text.indexOf("}", start);
    if (start < 0 || end < 0)
        return undefined;
    let value;
    try {
        value = JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return undefined;
    }
    if (!isRecord(value) || typeof value.role !== "string" || typeof value.confident !== "boolean")
        return undefined;
    const role = value.role.trim();
    return allowed.includes(role) ? { role, confident: value.confident } : undefined;
}
/** The decided role, or the default with the reason the decision was not taken. */
export function pickRole(decision, auto, failure) {
    if (failure !== undefined)
        return { role: auto.default, reason: failure };
    if (decision === undefined)
        return { role: auto.default, reason: "invalid" };
    if (!decision.confident)
        return { role: auto.default, reason: "unsure" };
    return { role: decision.role, reason: "confident" };
}
/**
 * Keep `role` unless its model ranks above the parent's: then the highest allowed
 * tier at or under the parent's rank, else the lowest allowed one. Unknown ranks
 * leave the tier alone.
 */
export function capRole(role, costs, parentCost) {
    const chosen = costs.find((entry) => entry.role === role)?.cost;
    if (parentCost === undefined || chosen === undefined || chosen <= parentCost)
        return role;
    const known = costs.filter((entry) => entry.cost !== undefined);
    const under = known.filter((entry) => entry.cost <= parentCost).sort((a, b) => b.cost - a.cost)[0];
    if (under !== undefined)
        return under.role;
    return known.sort((a, b) => a.cost - b.cost)[0]?.role ?? role;
}
/** The lineup rank of the model each tier resolves to right now. */
export function roleCosts(roles, options, available, health) {
    return roles.map((role) => {
        const model = resolveRole(options.roles, available, role, health).model;
        return { role, cost: model === undefined ? undefined : rankOf(model, options.classes) };
    });
}
/** The decider prompt for an effort: the variants the model has, and the task. */
export function buildEffortPrompt(input) {
    const task = input.prompt.length > DECIDER_PROMPT_LIMIT ? `${input.prompt.slice(0, DECIDER_PROMPT_LIMIT)}\n[truncated]` : input.prompt;
    return [
        "You pick the reasoning effort for a subagent task. Reply with ONLY a JSON object, no prose:",
        `{"effort": "<one of: ${input.variants.join(", ")}>"}`,
        "",
        "Pick the lowest effort that does the task well: low for lookups and mechanical edits, higher for design, debugging and subtle reasoning.",
        "",
        `Tier: ${input.tier}`,
        `Spawn description: ${input.description?.trim() || "(none)"}`,
        "Task:",
        "<<<",
        task,
        ">>>",
    ].join("\n");
}
/** The effort in the decider's reply, if it is one of `allowed`. */
export function parseEffort(text, allowed) {
    const start = text.indexOf("{");
    const end = text.indexOf("}", start);
    if (start < 0 || end < 0)
        return undefined;
    try {
        const value = JSON.parse(text.slice(start, end + 1));
        const effort = typeof value.effort === "string" ? value.effort.trim() : "";
        return allowed.includes(effort) ? effort : undefined;
    }
    catch {
        return undefined;
    }
}
/** A short tag for the spawn description, so the choice shows in the session title. */
export function autoTag(record) {
    const why = record.capped !== undefined ? `capped from ${record.capped}` : record.reason;
    return `[auto: ${record.role}, ${why}]`;
}
/** The spawn description with the auto tag appended. */
export function withAutoTag(description, record) {
    const text = typeof description === "string" ? description.trim() : "";
    return text === "" ? autoTag(record) : `${text} ${autoTag(record)}`;
}
/** `history` with `record` in front, at most `AUTO_HISTORY_LIMIT` long. */
export function pushHistory(history, record) {
    return [record, ...history].slice(0, AUTO_HISTORY_LIMIT);
}
/** The auto history as lines for `model_roles_check`. */
export function formatHistory(history) {
    if (history.length === 0)
        return [];
    return [
        "",
        "Recent auto routing (newest first):",
        ...history.map((r) => {
            const model = r.model === undefined ? "no model available; agent default" : modelText(r.model);
            const why = r.capped !== undefined ? `${r.reason}, capped from ${r.capped}` : r.reason;
            return `  - ${new Date(r.at).toISOString()} ${r.agent} → ${r.role} (${model}; ${why}; ${r.ms} ms)`;
        }),
    ];
}
