/**
 * Spawn receipts for `srobroek.model-roles`: for each subagent spawn the plugin routes, the
 * tier asked for and where from, the model it got, the precedence rule that picked the
 * variant, and what it fell back past. Pure; the plugin keeps the last few in storage.
 */
import { nearestVariant } from "./catalog.ts";
import { candidateStatus, describeCandidate } from "./check.ts";
import { modelText, parseCandidate } from "./resolve.ts";
export const RECEIPTS_KEY = "receipts";
export const RECEIPT_LIMIT = 50;
export function pushReceipt(list, receipt, limit = RECEIPT_LIMIT) {
    return [receipt, ...list].slice(0, limit);
}
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value) => Array.isArray(value) && value.every((v) => typeof v === "string");
/** Stored receipts, malformed entries dropped. */
export function readReceipts(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((r) => isRecord(r) &&
        typeof r.at === "number" &&
        typeof r.agent === "string" &&
        typeof r.source === "string" &&
        typeof r.rule === "string" &&
        isStrings(r.fallbacks) &&
        isStrings(r.warnings));
}
const bare = (ref) => `${ref.providerID}/${ref.id}`;
/** The rule that picked a tier-resolved model's variant, and what was dropped on the way. */
export function explainSpawn(input) {
    const { model, meta } = input;
    const listed = input.models.find((m) => m.providerID === model.providerID && m.id === model.id);
    const variants = listed?.variants ?? [];
    const effort = meta?.effort === "auto" ? undefined : meta?.effort;
    const warnings = [];
    let rule;
    if (model.variant !== undefined) {
        const explicit = input.explicit.some((entry) => {
            const candidate = parseCandidate(entry);
            return candidate?.kind === "model" && bare(candidate.ref) === bare(model) && candidate.ref.variant === model.variant;
        });
        if (explicit || effort === undefined) {
            rule = "candidate-variant";
            if (effort !== undefined && nearestVariant(variants, effort) !== model.variant)
                warnings.push(`${modelText(model)} sets its own variant, which wins over the tier effort ${effort}`);
        }
        else
            rule = meta?.effortFrom === "base" ? "base-tier-effort" : meta?.effortFrom === "builtin" ? "builtin-effort" : "tier-effort";
    }
    else {
        rule = "model-default";
        if (effort !== undefined)
            warnings.push(variants.length === 0
                ? `${modelText(model)} has no variants; it runs at the model default, not effort ${effort}`
                : `${modelText(model)} has no variant near effort ${effort}; it runs at the model default`);
    }
    return { rule, fallbacks: fallbacksBefore(input), warnings };
}
/** Candidates ahead of the winner that were not usable, with the check's reason. */
function fallbacksBefore(input) {
    const out = [];
    for (const entry of input.order) {
        const candidate = parseCandidate(entry);
        if (candidate?.kind !== "model")
            continue;
        const { ref } = candidate;
        if (bare(ref) === bare(input.model) && (ref.variant === undefined || ref.variant === input.model.variant))
            break;
        const status = candidateStatus(entry, input.models, input.roles, input.health, input.now);
        if (status.status !== "available")
            out.push(`${entry}: ${describeCandidate(status)}`);
    }
    return out;
}
const SOURCE_TEXT = {
    "tier-param": "tier param",
    "role-param": "role param",
    agent: "agent tier",
    auto: "auto routing",
};
const RULE_TEXT = {
    "explicit-model": "explicit model",
    "agent-pin": "the agent's own model",
    "candidate-variant": "candidate variant",
    "tier-effort": "tier effort",
    "base-tier-effort": "base tier effort",
    "builtin-effort": "built-in effort",
    "auto-effort": "auto effort",
    "model-default": "model default",
    snapshot: "the child's snapshot",
    "guard-reroute": "the guard's reroute",
};
/** The receipts for `model_roles_check`, newest first, one line each. */
export function formatReceipts(list) {
    if (list.length === 0)
        return [];
    const lines = ["", "Recent spawns (newest first):"];
    for (const r of list) {
        const time = new Date(r.at).toISOString().slice(11, 19);
        const source = SOURCE_TEXT[r.source] ?? r.source;
        const asked = r.tier === undefined ? source : `tier ${r.tier} (${r.alias === undefined ? "" : `${r.alias}, `}${source})`;
        const parts = [`${time} ${r.agent}: ${asked} → ${r.model ?? "the agent's model"} by ${RULE_TEXT[r.rule] ?? r.rule}${r.configRevision === undefined ? "" : ` (config ${r.configRevision})`}`];
        if (r.fallbacks.length > 0)
            parts.push(`fell back past ${r.fallbacks.join(", ")}`);
        if (r.explore !== undefined)
            parts.push(`exploring arm ${r.explore}`);
        for (const warning of r.warnings)
            parts.push(`warning: ${warning}`);
        lines.push(`  - ${parts.join("; ")}`);
    }
    return lines;
}
