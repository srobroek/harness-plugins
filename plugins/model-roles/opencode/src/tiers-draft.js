/**
 * The `/tiers` editor's draft: one tier's unsaved models (fallback order, each with an
 * optional `#variant`), effort and purpose, the pure operations on it, the config it
 * produces and the options each menu shows. The TUI entry only wires these to dialogs.
 */
import { applyEdit, compact, configuredModels, tierSummary } from "./tiers-ui.ts";
/** The model an entry names, without its `#variant`. */
export const entryRef = (entry) => entry.split("#")[0] ?? entry;
/** An entry's `#variant`, if any. */
export const entryVariant = (entry) => {
    const at = entry.indexOf("#");
    return at < 0 ? undefined : entry.slice(at + 1);
};
export function createDraft(row, isNew = false) {
    const models = configuredModels(row);
    const purpose = row.configured?.purpose ?? row.purpose;
    const effort = row.configured?.effort;
    return {
        row,
        models: [...models],
        purpose,
        reset: false,
        isNew,
        initial: { models: [...models], purpose, ...(effort === undefined ? {} : { effort }) },
        ...(effort === undefined ? {} : { effort }),
    };
}
const withModels = (draft, models) => ({ ...draft, models });
/** The entry that names `entry`'s model with `variant` (none: inherit the tier effort). */
export const withVariant = (entry, variant) => (variant === undefined ? entryRef(entry) : `${entryRef(entry)}#${variant}`);
/**
 * Select a model (a bare `provider/model`) at the end of the order, or drop the entry
 * given. Entries are identified by their whole text, so two rows of one model with
 * different variants stay apart.
 */
export function toggle(draft, entry) {
    return withModels(draft, draft.models.includes(entry) ? draft.models.filter((e) => e !== entry) : [...draft.models, entry]);
}
/** Move an entry one place in the fallback order; the ends stay put. */
export function move(draft, entry, direction) {
    const from = draft.models.indexOf(entry);
    const to = direction === "up" ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= draft.models.length)
        return draft;
    const models = [...draft.models];
    models.splice(from, 1);
    models.splice(to, 0, entry);
    return withModels(draft, models);
}
/** Pin one entry to a variant, or `undefined` to let it inherit the tier effort. */
export function setVariant(draft, entry, variant) {
    const index = draft.models.indexOf(entry);
    if (index < 0)
        return draft;
    const models = [...draft.models];
    models[index] = withVariant(entry, variant);
    return withModels(draft, models);
}
export function setEffort(draft, effort) {
    const { effort: _drop, ...rest } = draft;
    return effort === undefined ? rest : { ...rest, effort };
}
export function setPurpose(draft, purpose) {
    return { ...draft, purpose };
}
/** Back to auto: no models, no effort, the saved purpose kept for a custom tier. */
export function reset(draft) {
    const { effort: _drop, ...rest } = draft;
    return { ...rest, models: [], purpose: draft.initial.purpose, reset: true };
}
const sameConfig = (a, b) => {
    const key = (c) => JSON.stringify(Object.entries(c ?? {}).sort(([x], [y]) => x.localeCompare(y)));
    return key(a) === key(b);
};
/** Whether saving would change the tier: the draft's resulting config against the untouched draft's. */
export function dirty(draft) {
    return draft.isNew || !sameConfig(toConfig(draft), toConfig(createDraft(draft.row)));
}
/** The config to save (`undefined`: remove the entry). Goes through `applyEdit`; variants stay. */
export function toConfig(draft) {
    const { row } = draft;
    const start = draft.reset
        ? row.builtin
            ? undefined
            : { model: "auto", purpose: draft.initial.purpose }
        : row.configured;
    let config = start;
    const step = (edit) => {
        const { configured: _old, ...rest } = row;
        config = applyEdit(config === undefined ? rest : { ...rest, configured: config }, edit);
    };
    // An absent model setting stays absent (a legacy roles-backed tier keeps its candidates) until Models or Reset changes it.
    const { models, initial } = draft;
    const touched = draft.isNew || draft.reset || models.length !== initial.models.length || models.some((e, i) => e !== initial.models[i]);
    if (touched)
        step({ kind: "models", models });
    step({ kind: "effort", effort: draft.effort });
    const purpose = draft.purpose.trim();
    if (purpose !== "" && purpose !== draft.initial.purpose)
        step({ kind: "purpose", purpose });
    return config;
}
/** The draft as the `state` RPC's `draft` argument, to preview what it would resolve to. */
export const toPreviewDraft = (draft) => ({ [draft.row.name]: toConfig(draft) ?? null });
const modelsSummary = (draft) => draft.models.length === 0 ? `auto: ${draft.row.candidates.join(", ") || "none"}` : draft.models.join(", ");
/** An unset effort: the tier's own, with its level when the state knows it and the draft did not clear a saved one. */
const tierEffortText = (draft) => draft.row.effort !== undefined && draft.initial.effort === undefined ? `Tier default (${draft.row.effort})` : "Tier default";
/** The tier menu: Models, Effort, Purpose, Preview, Reset, Save, Cancel. */
export function tierMenuOptions(draft, preview) {
    return [
        { title: "Models", value: "models", description: modelsSummary(draft) },
        { title: "Effort", value: "effort", description: draft.effort ?? tierEffortText(draft) },
        { title: "Purpose", value: "purpose", description: draft.purpose },
        { title: `Preview: ${preview ?? "…"}`, value: "preview", description: "What this tier resolves to with the draft" },
        { title: "Reset to auto", value: "reset", description: draft.row.builtin ? "Remove this tier's settings" : "Keep only the purpose" },
        { title: dirty(draft) ? "Save *" : "Save", value: "save", description: "Write the tier and apply it" },
        { title: "Cancel", value: "cancel", description: dirty(draft) ? "Discard the changes" : "Back to the tier list" },
    ];
}
const MARK = {
    unhealthy: "unhealthy",
    "unknown-id": "unknown model",
    "unknown-variant": "unknown variant",
    "provider-unavailable": "not available now",
};
/** Selected models first in fallback order, numbered; then the rest. A selected entry the host does not list stays visible. */
export function modelOptions(draft, available) {
    const health = new Map((draft.row.health ?? []).map((h) => [h.entry, h.status]));
    const listed = new Set(available.map((m) => m.ref));
    const selected = draft.models.map((entry, i) => {
        const ref = entryRef(entry);
        const variant = entryVariant(entry);
        const mark = MARK[health.get(entry) ?? ""];
        return {
            title: `☑ ${i + 1}. ${entry}`,
            value: entry,
            description: [variant === undefined ? "inherits tier effort" : `variant ${variant}`, mark].filter(Boolean).join(", "),
            ...(!listed.has(ref) && !entry.startsWith("@") ? { footer: "not listed now" } : {}),
        };
    });
    const chosen = new Set(draft.models.map(entryRef));
    const rest = available
        .filter((m) => !chosen.has(m.ref))
        .map((m) => ({
        title: `☐ ${m.ref}`,
        value: m.ref,
        ...(m.variants.length > 0 ? { description: `variants: ${m.variants.join(", ")}` } : {}),
    }));
    return [...selected, ...rest];
}
export const INHERIT = "\u0000inherit";
/** The variant submenu for one model. */
export function variantOptions(model) {
    return [
        { title: "Inherit tier effort (→ nearest variant)", value: INHERIT },
        ...(model?.variants ?? []).map((v) => ({ title: v, value: v })),
    ];
}
/** Short rows: a DialogSelect row has room for an id and a few words, so the model and description live in the details menu. */
export function agentOptions(agents, config) {
    const rows = agents.map((a) => ({
        title: a.id,
        value: a.id,
        description: `${a.tier ?? "no tier"}${a.pinned !== undefined ? " · own model" : ""}`,
    }));
    if (config?.alsoLoads === undefined)
        return rows;
    // One short note: a project entry under another package string runs as a second instance.
    return [{ title: "A second model-roles entry also loads", value: "", disabled: true, description: config.alsoLoads }, ...rows];
}
const SOURCE_TEXT = {
    options: "your setting",
    header: "agent default",
    implicit: "auto-classified",
};
/** Where an agent's tier comes from, in words. */
export function sourceText(source) {
    return source === undefined ? "none" : SOURCE_TEXT[source];
}
/** Break `text` into lines of at most `width` characters, at spaces where it can. */
export function wrap(text, width = 52) {
    const lines = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
        for (let rest = word; rest !== "";) {
            const room = line === "" ? width : width - line.length - 1;
            if (rest.length <= room) {
                line = line === "" ? rest : `${line} ${rest}`;
                rest = "";
            }
            else if (line !== "") {
                lines.push(line);
                line = "";
            }
            else {
                lines.push(rest.slice(0, width));
                rest = rest.slice(width);
            }
        }
    }
    if (line !== "")
        lines.push(line);
    return lines;
}
export const CHANGE_TIER = "\u0000change";
export const BACK = "\u0000back";
/** The details menu of one agent: one disabled row per fact (long text wrapped over rows), then the actions. */
export function agentDetailOptions(agent, config) {
    const note = (text) => wrap(text).map((line, i) => ({ title: i === 0 ? line : `  ${line}`, value: "", disabled: true }));
    const from = config?.origin === "project" ? `project config (${config.path ?? "unknown"})` : undefined;
    const fact = (label, value) => wrap(`${label}: ${value}`).map((line, i) => ({ title: i === 0 ? line : `  ${line}`, value: "", disabled: true }));
    return [
        ...fact("Tier", agent.tier ?? "no tier (session model)"),
        ...fact("From", sourceText(agent.source)),
        ...fact("Resolves to", agent.tier === undefined ? "the session model" : (agent.resolved ?? "nothing available")),
        ...(agent.pinned === undefined ? [] : fact("Own model", `${agent.pinned} (wins over the tier)`)),
        ...(agent.description === undefined ? [] : fact("About", agent.description)),
        ...(from === undefined ? [] : note(agent.source === "options" ? `Set by ${from}` : `Project config (${config?.path ?? "unknown"}) holds the model-roles entry`)),
        { title: "Change tier…", value: CHANGE_TIER },
        { title: "Back", value: BACK },
    ];
}
export const AGENT_DEFAULT = "\u0000agent-default";
/** The tier picker for one agent: the agent default first, then every tier with its summary. */
export function agentTierOptions(tiers) {
    return [
        { title: "Agent default", value: AGENT_DEFAULT, description: "Remove your setting; the agent's own tier or auto-classification applies" },
        ...tiers.map((t) => ({ title: t.name, value: t.name, description: tierSummary(t) })),
    ];
}
/** The picker row to mark: the agent's own setting, else the agent default. */
export const agentTierCurrent = (agent) => (agent.source === "options" && agent.tier !== undefined ? agent.tier : AGENT_DEFAULT);
/** What the adopt confirmation shows of a tier config. */
const adoptText = (config) => {
    const model = config?.model;
    return `models: ${Array.isArray(model) ? model.join(", ") : "auto"}; effort: ${config?.effort ?? "tier default"}`;
};
/**
 * The tier config that makes the arm `to` the control in place of `from`, for the "Adopt
 * recommendation" action. A tier with a model list gets `to` first, replacing the entry of the
 * same model, so its variant is pinned. A derived or borrowing tier that resolves to the arm's
 * model now takes an effort arm (that model at another variant) as its effort. A roles tier keeps
 * its candidates' explicit variants over the tier effort, so it, like a tier that resolves to
 * another model or an arm of another model, gets a list of `to` and then the current candidates,
 * which pins `to`. Everything else in the config stays.
 */
export function adoptPlan(row, from, to) {
    const current = row.configured;
    const listed = configuredModels(row);
    const base = entryRef(to);
    const variant = entryVariant(to);
    const others = (entries) => entries.filter((e) => entryRef(e) !== base);
    const next = listed.length > 0
        ? { ...current, model: [to, ...others(listed)] }
        : entryRef(from) === base && variant !== undefined && row.source !== "roles" && row.resolved !== undefined && entryRef(row.resolved) === base
            ? { ...current, effort: variant }
            : { ...current, model: [to, ...others(row.candidates)] };
    return { config: compact(next), before: adoptText(current), after: adoptText(next), from, to };
}
