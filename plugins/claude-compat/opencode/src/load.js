/**
 * Read Claude plugin sources into one {@link Bundle} per project, and share bundles
 * between setups of the same project and configuration. Nothing here registers anything;
 * `index.ts` adapts a bundle to the plugin context.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { convertAgent, convertCommand, convertSkill, parseClaudeMcp, rewriteRoot, } from "./convert.ts";
import { parseHooks } from "./hooks.ts";
import { containedPath, discoverPlugins, inside, sourcePath } from "./source.ts";
import { verifyProjectApproval } from "./trust.ts";
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * Manifest component paths (string or list) and the default directory, each canonical and
 * inside the plugin root; defaults first. Escapes are reported and skipped.
 */
function componentPaths(plugin, key, fallback, diagnostics) {
    const value = plugin.manifest[key];
    const extra = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
    const paths = [];
    for (const path of [fallback, ...extra]) {
        try {
            const real = containedPath(plugin.root, path);
            if (real !== undefined)
                paths.push(real);
        }
        catch (error) {
            diagnostics.push({ where: `${plugin.name}: ${path === fallback ? key : `manifest ${key}`}`, message: String(error) });
        }
    }
    return [...new Set(paths)];
}
/** Canonical entries of `dir` (a canonical directory inside `root`); escaping symlinks are reported. */
function entries(root, dir, diagnostics) {
    const found = [];
    for (const name of readdirSync(dir).sort()) {
        try {
            const real = containedPath(root, join(dir, name));
            if (real !== undefined)
                found.push({ name, real, directory: statSync(real).isDirectory() });
        }
        catch (error) {
            diagnostics.push({ where: join(dir, name), message: String(error) });
        }
    }
    return found;
}
/** `SKILL.md` files of a skills directory (or of one skill directory), canonical and inside `root`. */
function skillFiles(root, dir, diagnostics) {
    if (!statSync(dir).isDirectory())
        return [];
    const children = entries(root, dir, diagnostics);
    const own = children.find((entry) => entry.name === "SKILL.md" && !entry.directory);
    if (own)
        return [own.real];
    return children
        .filter((entry) => entry.directory)
        .flatMap((entry) => entries(root, entry.real, diagnostics).filter((file) => file.name === "SKILL.md" && !file.directory))
        .map((file) => file.real);
}
/**
 * Markdown files under `path` (a file or a directory, recursively, four levels), canonical
 * and inside `root`, named by their path relative to `path`.
 */
function markdownFiles(root, path, diagnostics) {
    if (!statSync(path).isDirectory())
        return path.endsWith(".md") ? [{ file: path, name: basename(path, ".md") }] : [];
    const found = [];
    const seen = new Set();
    const walk = (dir, prefix, depth) => {
        if (seen.has(dir))
            return;
        seen.add(dir);
        for (const entry of entries(root, dir, diagnostics)) {
            if (entry.directory) {
                if (depth < 4)
                    walk(entry.real, [...prefix, entry.name], depth + 1);
            }
            else if (entry.name.endsWith(".md"))
                found.push({ file: entry.real, name: [...prefix, entry.name.slice(0, -3)].join(":") });
        }
    };
    walk(path, [], 0);
    return found;
}
/** A plugin file read only when it is inside the root after resolving links; undefined when missing. */
function pluginFile(root, path) {
    const real = containedPath(root, path);
    return real === undefined ? undefined : { path: real, text: readFileSync(real, "utf8") };
}
/** Everything one plugin contributes. Per-file failures become diagnostics. */
export function loadPlugin(plugin, settings) {
    const { name, manifest } = plugin;
    const root = realpathSync(plugin.root);
    const out = { skills: [], agents: [], commands: [], mcp: [], hooks: [], instructions: [], diagnostics: [] };
    const report = (where, error) => out.diagnostics.push({ where, message: String(error) });
    for (const key of ["lspServers", "outputStyles"])
        if (manifest[key] !== undefined)
            out.diagnostics.push({ where: name, message: `Manifest ${key} is not supported` });
    for (const dir of componentPaths({ ...plugin, root }, "skills", "skills", out.diagnostics))
        for (const path of skillFiles(root, dir, out.diagnostics)) {
            try {
                const converted = convertSkill(path, root);
                out.skills.push(converted.skill);
                out.diagnostics.push(...converted.diagnostics);
            }
            catch (error) {
                report(path, error);
            }
        }
    for (const dir of componentPaths({ ...plugin, root }, "agents", "agents", out.diagnostics))
        for (const { file, name: agentName } of markdownFiles(root, dir, out.diagnostics)) {
            try {
                const converted = convertAgent(readFileSync(file, "utf8"), { plugin: name, name: agentName, root }, settings);
                out.agents.push(converted.agent);
                out.diagnostics.push(...converted.diagnostics);
            }
            catch (error) {
                report(file, error);
            }
        }
    for (const dir of componentPaths({ ...plugin, root }, "commands", "commands", out.diagnostics))
        for (const { file, name: commandName } of markdownFiles(root, dir, out.diagnostics)) {
            try {
                const converted = convertCommand(readFileSync(file, "utf8"), `${name}:${commandName}`, root);
                out.commands.push({ ...converted.command, plugin: name });
                out.diagnostics.push(...converted.diagnostics);
            }
            catch (error) {
                report(file, error);
            }
        }
    const servers = {};
    const mcpDocuments = [];
    try {
        const file = pluginFile(root, ".mcp.json");
        if (file)
            mcpDocuments.push([JSON.parse(file.text), file.path]);
        if (typeof manifest.mcpServers === "string") {
            const path = inside(root, manifest.mcpServers);
            mcpDocuments.push([JSON.parse(readFileSync(path, "utf8")), path]);
        }
        else if (isRecord(manifest.mcpServers))
            mcpDocuments.push([{ mcpServers: manifest.mcpServers }, `${name}: manifest mcpServers`]);
    }
    catch (error) {
        report(`${name}: mcp`, error);
    }
    for (const [document, where] of mcpDocuments) {
        try {
            Object.assign(servers, parseClaudeMcp(document, where));
        }
        catch (error) {
            report(where, error);
        }
    }
    if (Object.keys(servers).length > 0)
        out.mcp.push({ plugin: name, root, servers });
    const hookDocuments = [];
    try {
        const file = pluginFile(root, join("hooks", "hooks.json"));
        const path = file?.path;
        if (file)
            hookDocuments.push([JSON.parse(file.text), file.path]);
        for (const item of Array.isArray(manifest.hooks) ? manifest.hooks : manifest.hooks === undefined ? [] : [manifest.hooks]) {
            if (typeof item === "string") {
                const file = inside(root, item);
                if (file !== path)
                    hookDocuments.push([JSON.parse(readFileSync(file, "utf8")), file]);
            }
            else
                hookDocuments.push([isRecord(item) && "hooks" in item ? item : { hooks: item }, `${name}: manifest hooks`]);
        }
    }
    catch (error) {
        report(`${name}: hooks`, error);
    }
    for (const [document, where] of hookDocuments) {
        const parsed = parseHooks(document, name, root, where);
        out.diagnostics.push(...parsed.diagnostics);
        if (settings.hooks)
            out.hooks.push(...parsed.hooks);
        else if (parsed.hooks.length > 0)
            out.diagnostics.push({ where, message: `${parsed.hooks.length} hook(s) not run: hooks is off` });
    }
    try {
        const claudeMd = pluginFile(root, "CLAUDE.md");
        if (claudeMd && settings.instructions)
            out.instructions.push({ plugin: name, text: rewriteRoot(claudeMd.text.trim(), root) });
        else if (claudeMd)
            out.diagnostics.push({ where: claudeMd.path, message: "Plugin CLAUDE.md not included (instructions: false)" });
    }
    catch (error) {
        report(`${name}: CLAUDE.md`, error);
    }
    return out;
}
/** Read every group's sources for `project`. A plugin root or id seen before is skipped, reported. */
export async function loadBundle(project, groups, settings, resolve = sourcePath) {
    const bundle = { project, plugins: [], skills: [], agents: [], commands: [], mcp: [], hooks: [], instructions: [], diagnostics: [] };
    const roots = new Set();
    const ids = { skills: new Set(), agents: new Set(), commands: new Set(), mcp: new Set() };
    for (const group of groups) {
        const found = new Set();
        const sources = [];
        try {
            verifyProjectApproval(group, project);
        }
        catch (error) {
            bundle.diagnostics.push({ where: group.origin, message: String(error) });
            continue;
        }
        for (const source of group.sources) {
            try {
                sources.push({ source, path: await resolve(source, project) });
            }
            catch (error) {
                bundle.diagnostics.push({ where: `${group.origin}: ${JSON.stringify(source)}`, message: String(error) });
            }
        }
        // A first clone changes a URL/ref approval into a content approval. Do not even
        // parse the new plugin files, let alone register their executable capabilities.
        try {
            verifyProjectApproval(group, project);
        }
        catch (error) {
            bundle.diagnostics.push({ where: group.origin, message: String(error) });
            continue;
        }
        for (const { source, path } of sources) {
            let plugins;
            try {
                plugins = discoverPlugins(path, (where, message) => bundle.diagnostics.push({ where, message }));
            }
            catch (error) {
                bundle.diagnostics.push({ where: `${group.origin}: ${JSON.stringify(source)}`, message: String(error) });
                continue;
            }
            for (const plugin of plugins) {
                if (group.plugins && !group.plugins.includes(plugin.name))
                    continue;
                found.add(plugin.name);
                const real = realpathSync(plugin.root);
                if (roots.has(real)) {
                    bundle.diagnostics.push({ where: plugin.name, message: `Already loaded from ${real}; skipped` });
                    continue;
                }
                roots.add(real);
                bundle.plugins.push({ name: plugin.name, root: plugin.root });
                const part = loadPlugin(plugin, settings);
                bundle.diagnostics.push(...part.diagnostics);
                bundle.skills.push(...dedupe(part.skills, ids.skills, (skill) => skill.id, "skill", plugin.name, bundle.diagnostics));
                bundle.agents.push(...dedupe(part.agents, ids.agents, (agent) => agent.id, "agent", plugin.name, bundle.diagnostics));
                bundle.commands.push(...dedupe(part.commands, ids.commands, (command) => command.name, "command", plugin.name, bundle.diagnostics));
                for (const entry of part.mcp) {
                    const servers = {};
                    for (const [server, config] of Object.entries(entry.servers)) {
                        if (ids.mcp.has(server))
                            bundle.diagnostics.push({ where: plugin.name, message: `Duplicate MCP server ${server}; first one kept` });
                        else {
                            ids.mcp.add(server);
                            servers[server] = config;
                        }
                    }
                    if (Object.keys(servers).length > 0)
                        bundle.mcp.push({ ...entry, servers });
                }
                bundle.hooks.push(...part.hooks);
                bundle.instructions.push(...part.instructions);
            }
        }
        for (const name of group.plugins ?? [])
            if (!found.has(name))
                bundle.diagnostics.push({ where: `${group.origin}: ${name}`, message: "Selected plugin not found" });
    }
    return bundle;
}
function dedupe(items, seen, id, kind, plugin, diagnostics) {
    return items.filter((item) => {
        const key = id(item);
        if (seen.has(key)) {
            diagnostics.push({ where: plugin, message: `Duplicate ${kind} ${key}; first one kept` });
            return false;
        }
        seen.add(key);
        return true;
    });
}
const bundles = new Map();
/** The cache key: the project root first, so two projects never share an entry. */
export function bundleKey(project, groups, settings) {
    return JSON.stringify([project, groups, settings]);
}
/**
 * The bundle for `key`, loading it on first use. Setups of the same project and
 * configuration (several locations in one project) share it; the last release drops it,
 * so a reload reads the sources again.
 */
export async function acquireBundle(key, load) {
    let entry = bundles.get(key);
    if (!entry) {
        entry = { bundle: load(), users: 0 };
        bundles.set(key, entry);
    }
    entry.users++;
    const current = entry;
    let released = false;
    const release = () => {
        if (released)
            return;
        released = true;
        current.users--;
        if (current.users === 0 && bundles.get(key) === current)
            bundles.delete(key);
    };
    try {
        return { bundle: await current.bundle, release };
    }
    catch (error) {
        release();
        throw error;
    }
}
/** Project roots with a live cached bundle, for tests and the check tool. */
export function cachedProjects() {
    return [...bundles.keys()].map((key) => JSON.parse(key)[0]);
}
