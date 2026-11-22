/**
 * The delivery agents, shipped as V2 agent markdown under `agents/` and registered
 * through `ctx.agent.transform`, so installing the plugin is enough to get them.
 *
 * Markdown and config agents load after plugins, so a user's own `implementer.md`
 * still wins field by field. Each agent names its model-roles tier in the
 * `x-opencode-model-role` header. With the model-roles plugin installed, that tier
 * picks the model. Without it, the file's `model` is a fallback, used only when it is
 * available on this machine; otherwise the agent inherits the session's model. A
 * fallback is marked in the `x-opencode-model-fallback` header, so model-roles never
 * mistakes it for a user's pin.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listsPlugin } from "@srobroek/opencode-lib/agent-fallback";
import { MODEL_FALLBACK_HEADER } from "@srobroek/opencode-lib/model-roles";
export const AGENT_IDS = [
    "implementer",
    "implementer-high",
    "researcher",
    "pr-reviewer",
    "operator",
    "shepherd",
];
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
export function agentPath(id) {
    return fileURLToPath(new URL(`../agents/${id}.md`, import.meta.url));
}
/** Parse one agent file. Throws on a file without frontmatter. */
export function parseAgentFile(id, text) {
    const match = FRONTMATTER.exec(text);
    if (!match)
        throw new Error(`agents/${id}.md has no frontmatter`);
    const data = (Bun.YAML.parse(match[1] ?? "") ?? {});
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    if (data.steps !== undefined && (typeof data.steps !== "number" || !Number.isInteger(data.steps) || data.steps <= 0))
        throw new Error(`agents/${id}.md: steps must be a positive integer`);
    return {
        id,
        description: typeof data.description === "string" ? data.description : undefined,
        mode: typeof data.mode === "string" ? data.mode : "subagent",
        model: typeof data.model === "string" ? data.model : undefined,
        ...(typeof data.hidden === "boolean" ? { hidden: data.hidden } : {}),
        ...(typeof data.steps === "number" ? { steps: data.steps } : {}),
        ...(data.request && typeof data.request === "object" ? { request: data.request } : {}),
        permissions,
        system: text.slice(match[0].length).trim(),
    };
}
/** `provider/model#variant` as a model reference, or undefined when it names none. */
export function parseModel(value) {
    const [path, variant] = value.split("#", 2);
    const slash = path?.indexOf("/") ?? -1;
    if (path === undefined || slash <= 0 || slash === path.length - 1)
        return undefined;
    const ref = { providerID: path.slice(0, slash), id: path.slice(slash + 1) };
    if (variant)
        ref.variant = variant;
    return ref;
}
/** The model ref when it is enabled here (and its variant exists), otherwise undefined. */
export function availableModel(ref, available) {
    if (ref === undefined)
        return undefined;
    const model = available.find((m) => m.providerID === ref.providerID && m.id === ref.id && m.enabled !== false);
    if (model === undefined)
        return undefined;
    if (ref.variant !== undefined && !(model.variants ?? []).some((v) => v.id === ref.variant)) {
        return { providerID: ref.providerID, id: ref.id };
    }
    return ref;
}
const modelLabel = (ref) => `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`;
/**
 * Fill one agent from its file. A created agent takes every field; an existing one
 * (another plugin's, or a host default) keeps what it has and gains the delivery
 * permissions after its own. A fallback model is marked in the fallback header.
 */
export function shapeAgent(draft, file, model, created) {
    draft.name ??= file.id;
    if (created || draft.description === undefined)
        draft.description = file.description;
    if (created || draft.mode === undefined)
        draft.mode = file.mode;
    if (created || draft.system === undefined)
        draft.system = file.system;
    if (file.hidden !== undefined && (created || draft.hidden === undefined))
        draft.hidden = file.hidden;
    if (file.steps !== undefined)
        draft.steps ??= file.steps;
    const { fallback, ...ref } = model ?? {};
    const setModel = model !== undefined && (created || draft.model === undefined);
    if (setModel)
        draft.model = ref;
    if (file.request?.headers)
        draft.request = { ...draft.request, headers: { ...file.request.headers, ...draft.request?.headers } };
    if (setModel && fallback)
        draft.request = { ...draft.request, headers: { ...draft.request?.headers, [MODEL_FALLBACK_HEADER]: modelLabel(ref) } };
    draft.permissions = created ? [...file.permissions] : [...(draft.permissions ?? []), ...file.permissions];
}
export const MODEL_ROLES_PLUGIN = "srobroek.model-roles";
/** Whether a `plugin.list` result includes the model-roles plugin. */
export function hasModelRoles(listed) {
    return listsPlugin(listed, "model-roles");
}
/**
 * Agents another package owns; delivery ships each as a fallback copy, registered only
 * when the owner is not installed and no earlier plugin added the id (see
 * `@srobroek/opencode-lib/agent-fallback`). Keep the copy in sync with the owner's file.
 */
export const FALLBACK_AGENTS = { researcher: "agent-researcher", "pr-reviewer": "agent-reviewer" };
/**
 * The model to give an agent. An explicit `models` option wins; `false` means none.
 * Otherwise the file's model is a fallback for hosts without model-roles, where the
 * role header has no effect.
 */
export function fallbackModel(file, override, modelRoles, available) {
    if (override === false)
        return undefined;
    if (override !== undefined)
        return availableModel(parseModel(override), available);
    if (modelRoles)
        return undefined;
    const ref = availableModel(parseModel(file.model ?? ""), available);
    return ref === undefined ? undefined : { ...ref, fallback: true };
}
/** Read every shipped agent file. */
export function loadAgents(ids = AGENT_IDS) {
    return ids.map((id) => parseAgentFile(id, readFileSync(agentPath(id), "utf8")));
}
