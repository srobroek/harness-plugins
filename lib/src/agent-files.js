/**
 * Register agent markdown shipped inside a plugin package through `ctx.agent.transform`.
 *
 * A plugin keeps its agents as `agents/<id>.md` in the V2 markdown shape that
 * `scripts/convert-agent.ts` writes: flat `description`, `mode`, `hidden` and `steps` keys, a
 * `request.headers` map, a `permissions` list of `action`/`resource`/`effect` items, and
 * the prompt as the body. Shipped agents never pin a model: they name a model-roles tier
 * in the `x-opencode-model-role` header, and without that plugin inherit the session model.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { grantTools } from "./agent-tools.ts";
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MODES = ["subagent", "primary", "all"];
const EFFECTS = ["allow", "ask", "deny"];
function scalar(raw) {
    const value = raw.trim();
    if (value.startsWith('"'))
        return JSON.parse(value);
    if (value.length > 1 && value.startsWith("'") && value.endsWith("'"))
        return value.slice(1, -1);
    return value;
}
/** Parse one agent file. Throws on a key or value outside the shape described above. */
export function parseAgentFile(text, id) {
    const source = text.replace(/^\uFEFF/, "");
    const match = FRONTMATTER.exec(source);
    if (!match)
        throw new Error(`agent ${id}: no frontmatter`);
    const agent = { id, mode: "subagent", permissions: [], system: source.slice(match[0].length).trim() };
    let rule;
    let section;
    const flush = () => {
        if (!rule)
            return;
        const { action, resource, effect } = rule;
        if (!action || !resource || !effect || !EFFECTS.includes(effect))
            throw new Error(`agent ${id}: incomplete permission ${JSON.stringify(rule)}`);
        agent.permissions.push({ action, resource, effect });
        rule = undefined;
    };
    for (const line of (match[1] ?? "").split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line))
            continue;
        if (section === "permissions") {
            const item = /^\s+(-\s+)?([a-z]+):\s*(.*)$/.exec(line);
            if (item) {
                if (item[1])
                    flush();
                rule ??= {};
                const key = item[2];
                if (key !== "action" && key !== "resource" && key !== "effect")
                    throw new Error(`agent ${id}: unknown permission key ${key}`);
                rule[key] = scalar(item[3] ?? "");
                continue;
            }
        }
        if (section === "request" || section === "headers") {
            const headers = /^ {2}headers:\s*$/.exec(line);
            if (headers) {
                agent.request = { headers: {} };
                section = "headers";
                continue;
            }
            const header = /^ {4}([\w-]+):\s*(.*)$/.exec(line);
            if (section === "headers" && header && agent.request) {
                agent.request.headers[header[1] ?? ""] = scalar(header[2] ?? "");
                continue;
            }
            if (/^\s/.test(line))
                throw new Error(`agent ${id}: request supports only headers`);
        }
        flush();
        section = undefined;
        const field = /^([a-z][\w-]*):\s*(.*)$/.exec(line);
        if (!field)
            throw new Error(`agent ${id}: unreadable frontmatter line ${JSON.stringify(line)}`);
        const [, key, value = ""] = field;
        if (key === "description")
            agent.description = scalar(value);
        else if (key === "mode") {
            const mode = scalar(value);
            if (!MODES.includes(mode))
                throw new Error(`agent ${id}: bad mode ${mode}`);
            agent.mode = mode;
        }
        else if (key === "hidden") {
            const hidden = scalar(value);
            if (hidden !== "true" && hidden !== "false")
                throw new Error(`agent ${id}: hidden must be true or false`);
            agent.hidden = hidden === "true";
        }
        else if (key === "steps") {
            const steps = Number(scalar(value));
            if (!Number.isInteger(steps) || steps <= 0)
                throw new Error(`agent ${id}: steps must be a positive integer`);
            agent.steps = steps;
        }
        else if (key === "color")
            agent.color = scalar(value);
        else if (key === "request") {
            if (value.trim() !== "")
                throw new Error(`agent ${id}: request must be a map`);
            section = "request";
        }
        else if (key === "permissions") {
            if (value.trim() === "[]")
                continue;
            if (value.trim() !== "")
                throw new Error(`agent ${id}: permissions must be a list`);
            section = "permissions";
        }
        else
            throw new Error(`agent ${id}: unsupported frontmatter key ${key}`);
    }
    flush();
    return agent;
}
function wildcard(value, pattern) {
    const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${source}$`, "s").test(value);
}
/**
 * The effect OpenCode gives `action` on `resource` under `rules`: the last matching rule
 * wins, and nothing matching means `ask`. Lets tests check an agent's tool boundary.
 */
export function permissionEffect(rules, action, resource = "*") {
    return rules.findLast((rule) => wildcard(action, rule.action) && wildcard(resource, rule.resource))?.effect ?? "ask";
}
// Rules that let an agent read the files of exactly one directory outside the project without a prompt, for
// `registerAgents`' `extra`. Both the directory and its real path are granted, because the host may report either.
// A missing directory grants only the path as given.
export function directoryReadRules(directory) {
    const dirs = [directory];
    try {
        dirs.push(realpathSync(directory));
    }
    catch {
        // A missing directory is reported by whatever registers its content.
    }
    return directoryReadRulesFor(dirs);
}
// The same rules for directories the caller has already resolved and checked. It never touches the file system,
// so no later resolution can change which patterns are granted.
export function directoryReadRulesFor(directories) {
    return [...new Set(directories)].map((dir) => ({ action: "external_directory", resource: join(dir, "*"), effect: "allow" }));
}
/** Read `<path>` and parse it as the agent named by its file name. */
export function readAgentFile(path) {
    return parseAgentFile(readFileSync(path, "utf8"), basename(path, ".md"));
}
/** The absolute path of every `<directory>/*.md`, sorted. */
export function agentPaths(directory) {
    if (!existsSync(directory))
        return [];
    return readdirSync(directory)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => join(directory, name));
}
/** The agent id of each agent file path: its file name without `.md`. */
export function agentIds(paths) {
    return paths.map((path) => basename(path, ".md"));
}
/**
 * Fill an agent from its file. Fields the agent already has win, including its own request
 * headers; the file's permission rules go after existing ones, so its boundary holds (the
 * last matching rule wins). A `created` agent takes the file's mode and `hidden`, because
 * the host gives a new agent `primary` and `hidden: false`.
 */
export function shapeAgent(agent, file, created) {
    agent.name ??= file.id;
    if (file.description !== undefined)
        agent.description ??= file.description;
    if (created || agent.mode === undefined)
        agent.mode = file.mode;
    agent.system ??= file.system;
    // The host fills a new agent's `hidden` with false before the callback runs.
    if (file.hidden !== undefined && (created || agent.hidden === undefined))
        agent.hidden = file.hidden;
    if (file.steps !== undefined)
        agent.steps ??= file.steps;
    if (file.color !== undefined)
        agent.color ??= file.color;
    if (file.request)
        agent.request = { ...agent.request, headers: { ...file.request.headers, ...agent.request?.headers } };
    agent.permissions = [...(agent.permissions ?? []), ...file.permissions];
}
/**
 * Register every agent file. Files are read once, before the transform registers. `extra`
 * rules go after each file's own, for boundaries only known at runtime, such as the
 * plugin's install directory; `grant` adds the MCP tool rules to the agents it names.
 */
export async function registerAgents(agent, paths, extra = [], grant) {
    const files = paths
        .map(readAgentFile)
        .map((file) => grantTools(file, grant))
        .map((file) => ({ ...file, permissions: [...file.permissions, ...extra] }));
    return registerAgentFiles(agent, files);
}
/**
 * Register parsed agents, creating each one the host does not have yet. For plugins that
 * build {@link AgentFile}s from another format instead of reading V2 agent markdown.
 */
export async function registerAgentFiles(agent, files, options = {}) {
    return agent.transform((editor) => {
        for (const file of files) {
            const created = editor.get(file.id) === undefined;
            if (!created && options.onExisting) {
                options.onExisting(file.id);
                continue;
            }
            editor.update(file.id, (info) => {
                const mutable = info;
                const existing = [...(mutable.permissions ?? [])];
                shapeAgent(mutable, file, created);
                if (options.permissions)
                    mutable.permissions = options.permissions(existing, file, editor);
            });
        }
    });
}
