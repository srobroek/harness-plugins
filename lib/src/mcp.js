/**
 * MCP servers a plugin adds through `ctx.mcp.transform`.
 *
 * Servers are written in the Claude Code `.mcp.json` format, so the same file ships to
 * Claude Code and Codex through the marketplace export and to OpenCode through
 * `registerMcp`. The OpenCode side differs from a config entry in four ways:
 *
 * - `${VAR}` and `${VAR:-default}` are expanded here from `process.env`, because OpenCode
 *   does not expand `{env:VAR}` in configs a plugin sets. A server that names an unset
 *   variable without a default is skipped.
 * - A server already in the editor (the user's config) is left alone, so config wins.
 * - Code Mode is set explicitly on every server.
 * - The `mcp` option picks `auto` (only where the plugin's relevance check passes),
 *   `always` or `off`, and `mcpServers` turns single servers on or off by name.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export const MCP_MODES = ["auto", "always", "off"];
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringRecord = (value) => isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
/** Parse a `.mcp.json` document (`{ "mcpServers": { ... } }`). Throws on a malformed server. */
export function parseMcpJson(text, where = ".mcp.json") {
    const document = JSON.parse(text);
    if (!isRecord(document))
        throw new Error(`${where}: expected an object`);
    const servers = document.mcpServers ?? {};
    if (!isRecord(servers))
        throw new Error(`${where}: mcpServers must be an object`);
    const result = {};
    for (const [name, server] of Object.entries(servers)) {
        const at = `${where}: ${name}`;
        if (!isRecord(server))
            throw new Error(`${at}: expected an object`);
        const type = server.type ?? (server.url === undefined ? "stdio" : "http");
        if (type !== "stdio" && type !== "http" && type !== "sse")
            throw new Error(`${at}: unknown type ${String(type)}`);
        if (type === "stdio") {
            if (typeof server.command !== "string" || server.command === "")
                throw new Error(`${at}: command is required`);
            if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every((a) => typeof a === "string")))
                throw new Error(`${at}: args must be strings`);
            if (server.env !== undefined && !isStringRecord(server.env))
                throw new Error(`${at}: env must map to strings`);
            if (server.cwd !== undefined && typeof server.cwd !== "string")
                throw new Error(`${at}: cwd must be a string`);
        }
        else {
            if (typeof server.url !== "string" || server.url === "")
                throw new Error(`${at}: url is required`);
            if (server.headers !== undefined && !isStringRecord(server.headers))
                throw new Error(`${at}: headers must map to strings`);
        }
        result[name] = { ...server, type };
    }
    return result;
}
/** Read and parse `path`; a missing file has no servers. */
export function loadMcpJson(path) {
    if (!existsSync(path))
        return {};
    return parseMcpJson(readFileSync(path, "utf8"), path);
}
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
/** Expand `${VAR}` and `${VAR:-default}`; collects the names of unset variables without a default. */
export function expandVars(value, env, missing) {
    return value.replace(VARIABLE, (_, name, fallback) => {
        const found = env[name];
        if (found !== undefined && found !== "")
            return found;
        if (fallback !== undefined)
            return fallback;
        if (found === undefined)
            missing.add(name);
        return "";
    });
}
const expandRecord = (record, env, missing) => record === undefined
    ? undefined
    : Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expandVars(value, env, missing)]));
/** Convert one Claude-format server to an OpenCode config, or list the unset variables it needs. */
export function toOpenCode(server, env) {
    const missing = new Set();
    let config;
    if (server.type === "http" || server.type === "sse" || (server.type === undefined && server.url !== undefined)) {
        const headers = expandRecord(server.headers, env, missing);
        config = {
            type: "remote",
            url: expandVars(server.url ?? "", env, missing),
            ...(headers === undefined ? {} : { headers }),
            codemode: true,
        };
    }
    else {
        const environment = expandRecord(server.env, env, missing);
        config = {
            type: "local",
            command: [server.command ?? "", ...(server.args ?? [])].map((part) => expandVars(part, env, missing)),
            ...(server.cwd === undefined ? {} : { cwd: expandVars(server.cwd, env, missing) }),
            ...(environment === undefined ? {} : { environment }),
            codemode: true,
        };
    }
    if (missing.size > 0)
        return { missing: [...missing].sort() };
    return { config: config };
}
/** Read the `mcp` and `mcpServers` plugin options. Unknown values fall back to `auto` and are ignored. */
export function parseMcpOptions(options) {
    const mode = MCP_MODES.includes(options?.mcp) ? options?.mcp : "auto";
    const servers = {};
    if (isRecord(options?.mcpServers)) {
        for (const [name, value] of Object.entries(options.mcpServers))
            if (typeof value === "boolean")
                servers[name] = value;
    }
    return { mode, servers };
}
/** Decide which servers to add. Pure apart from calling `settings.relevant`. */
export function planMcp(servers, options, settings = {}) {
    const plan = { add: [], skipped: [] };
    const names = Object.keys(servers);
    const skipAll = (reason) => ({ add: [], skipped: names.map((name) => ({ name, reason })) });
    if (options.mode === "off")
        return skipAll("mcp is off");
    if (options.mode === "auto" && settings.relevant !== undefined && !settings.relevant())
        return skipAll("not relevant here");
    const off = new Set(settings.off ?? []);
    for (const name of names) {
        const server = servers[name];
        if (!(options.servers[name] ?? !off.has(name))) {
            plan.skipped.push({ name, reason: "turned off" });
            continue;
        }
        const converted = toOpenCode(server, settings.env ?? process.env);
        if ("missing" in converted) {
            plan.skipped.push({ name, reason: `unset ${converted.missing.join(", ")}` });
            continue;
        }
        plan.add.push([name, { ...converted.config, ...settings.extra?.[name] }]);
    }
    return plan;
}
/** Apply a plan to an editor, leaving every server already configured under that name alone. */
export function applyMcp(editor, add) {
    for (const [name, config] of add) {
        if (editor.get(name) !== undefined)
            continue;
        editor.set(name, structuredClone(config));
    }
}
/** The directories a relevance check should look in: the location and its project root. */
export function locationDirectories(ctx) {
    const location = ctx.location;
    const directories = [location.directory];
    const root = location.project?.directory;
    if (typeof root === "string" && root !== location.directory)
        directories.push(root);
    return directories;
}
/**
 * Add `servers` through `ctx.mcp.transform` as `options` and `settings` allow. Returns the
 * registration (a no-op when nothing is added) and the plan, so a caller can report skips.
 */
export async function registerMcp(ctx, servers, options, settings = {}) {
    const plan = planMcp(servers, options, settings);
    if (plan.add.length === 0)
        return { registration: { dispose: async () => { } }, plan };
    const registration = await ctx.mcp.transform((editor) => applyMcp(editor, plan.add));
    return { registration, plan };
}
/**
 * Add the servers of the `.mcp.json` at the root of the package whose module URL is
 * `moduleUrl` (one level above `src/` and the bundled `dist/`), reading the plugin's
 * `mcp` and `mcpServers` options.
 */
export async function registerPluginMcp(ctx, moduleUrl, settings = {}) {
    const { relevant, servers: more, ...rest } = settings;
    const servers = { ...loadMcpJson(fileURLToPath(new URL("../.mcp.json", moduleUrl))), ...more };
    const options = parseMcpOptions(ctx.options);
    const check = relevant === undefined ? undefined : () => locationDirectories(ctx).some(relevant);
    return registerMcp(ctx, servers, options, { ...rest, relevant: check });
}
