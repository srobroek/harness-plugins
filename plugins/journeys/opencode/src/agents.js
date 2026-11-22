import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export const AGENT_IDS = ["journey-scribe", "journey-validator"];
export const AGENT_PATHS = AGENT_IDS.map((id) => fileURLToPath(new URL(`../agents/${id}.md`, import.meta.url)));
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** Parse an agent markdown file written by `scripts/convert-agent.ts`. */
export function parseAgentFile(id, text) {
    const match = FRONTMATTER.exec(text);
    if (!match)
        throw new Error(`${id}: agent file has no frontmatter`);
    const data = (Bun.YAML.parse(match[1] ?? "") ?? {});
    const mode = data.mode === "primary" || data.mode === "all" ? data.mode : "subagent";
    const agent = {
        id,
        mode,
        permissions: Array.isArray(data.permissions) ? data.permissions : [],
        system: text.slice(match[0].length).trim(),
    };
    if (typeof data.description === "string")
        agent.description = data.description;
    if (typeof data.hidden === "boolean")
        agent.hidden = data.hidden;
    if (typeof data.steps === "number")
        agent.steps = data.steps;
    if (data.request && typeof data.request === "object")
        agent.request = data.request;
    return agent;
}
export function loadAgents(paths = AGENT_PATHS) {
    return paths.map((path, at) => parseAgentFile(AGENT_IDS[at] ?? path, readFileSync(path, "utf8")));
}
/**
 * Apply a shipped agent. Fields the user configured for the same id win, and so do
 * configured permissions: they go after the shipped ones, and the last matching rule wins.
 * A `created` agent gets the shipped mode and `hidden`, and its shipped rules go after the
 * host's defaults (`* allow` among them), because the host fills a new agent with
 * `primary`, `hidden: false` and those defaults before the callback runs.
 */
export function shapeAgent(agent, file, created) {
    agent.name ??= file.id;
    if (file.description !== undefined)
        agent.description ??= file.description;
    if (created || agent.mode === undefined)
        agent.mode = file.mode;
    agent.system ??= file.system;
    if (file.hidden !== undefined && (created || agent.hidden === undefined))
        agent.hidden = file.hidden;
    if (file.steps !== undefined)
        agent.steps ??= file.steps;
    if (file.request?.headers)
        agent.request = { ...agent.request, headers: { ...file.request.headers, ...agent.request?.headers } };
    agent.permissions = created ? [...(agent.permissions ?? []), ...file.permissions] : [...file.permissions, ...(agent.permissions ?? [])];
}
