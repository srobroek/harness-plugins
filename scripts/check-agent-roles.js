#!/usr/bin/env bun
/**
 * Fail when a shipped agent (`plugins/<name>/common/agents/*.md`) does not declare a model-roles
 * tier in its `x-opencode-model-role` request header, declares a value that is neither a
 * tier nor an accepted old role name, or pins a model in a plugin that does not treat it as a fallback. A plugin's
 * `common/agents/roles.json` fragment, when present, must match the headers. Every agent must
 * declare a positive integer `steps` limit.
 *
 *   bun scripts/check-agent-roles.ts           check plugins/*
 *   bun scripts/check-agent-roles.ts <files>   check the named agent files
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isModelRole, MODEL_ROLE_HEADER, MODEL_TIERS } from "../lib/src/model-roles.ts";
/** Plugins whose agent `model` is a fallback, applied only when model-roles is absent. */
const FALLBACK_MODEL_PLUGINS = ["delivery"];
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** The role an agent file declares, or a finding. */
export function checkAgent(file, text, allowModel) {
    const match = FRONTMATTER.exec(text.replace(/^\uFEFF/, ""));
    if (!match)
        return { findings: [{ file, reason: "no frontmatter" }] };
    let data;
    try {
        const parsed = Bun.YAML.parse(match[1] ?? "");
        data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch (error) {
        return { findings: [{ file, reason: `frontmatter does not parse: ${error.message}` }] };
    }
    const findings = [];
    const headers = data.request?.headers;
    const role = headers?.[MODEL_ROLE_HEADER];
    if (role === undefined)
        findings.push({ file, reason: `no request.headers.${MODEL_ROLE_HEADER}` });
    else if (!isModelRole(role))
        findings.push({ file, reason: `unknown model tier ${JSON.stringify(role)}; use one of ${MODEL_TIERS.join(", ")}` });
    if (data.model !== undefined && !allowModel)
        findings.push({ file, reason: "pins a model; declare a tier and let the agent inherit without model-roles" });
    if (typeof data.steps !== "number" || !Number.isInteger(data.steps) || data.steps <= 0)
        findings.push({ file, reason: "steps must be a positive integer" });
    return { ...(isModelRole(role) ? { role } : {}), findings };
}
/** Compare a plugin's `common/agents/roles.json` fragment with the roles its agent files declare. */
export function checkFragment(file, text, roles) {
    const fragment = JSON.parse(text).agents ?? {};
    const findings = [];
    for (const id of new Set([...Object.keys(fragment), ...Object.keys(roles)])) {
        if (fragment[id] !== roles[id])
            findings.push({ file, reason: `${id}: fragment says ${fragment[id] ?? "nothing"}, agent header says ${roles[id] ?? "nothing"}` });
    }
    return findings;
}
function pluginOf(file) {
    const parts = path.resolve(file).split(path.sep);
    const at = parts.lastIndexOf("agents");
    return at > 1 ? (parts[at - 2] ?? "") : "";
}
export function checkFiles(root, files) {
    const findings = [];
    const byPlugin = new Map();
    for (const file of files) {
        const name = path.relative(root, path.resolve(file));
        const plugin = pluginOf(file);
        const result = checkAgent(name, readFileSync(file, "utf8"), FALLBACK_MODEL_PLUGINS.includes(plugin));
        findings.push(...result.findings);
        const roles = byPlugin.get(plugin) ?? {};
        if (result.role)
            roles[path.basename(file).replace(/(\.opencode)?\.md$/, "")] = result.role;
        byPlugin.set(plugin, roles);
    }
    for (const [plugin, roles] of byPlugin) {
        const fragment = path.join(root, "plugins", plugin, "common", "agents", "roles.json");
        const text = readIfPresent(fragment);
        if (text !== undefined)
            findings.push(...checkFragment(path.relative(root, fragment), text, roles));
    }
    return findings;
}
// One call per path instead of an existence check first: each file system call is an
// endpoint-scanned round trip on developer machines.
function readIfPresent(file) {
    try {
        return readFileSync(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function entriesIfPresent(dir) {
    try {
        return readdirSync(dir);
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ENOTDIR")
            return [];
        throw error;
    }
}
/** Every OpenCode agent file in `plugins/<name>/common/agents/`, sorted. The translated `*.claude.md` files have no model tier. */
export function shippedAgents(pluginsDir) {
    const files = [];
    for (const plugin of readdirSync(pluginsDir).sort()) {
        const dir = path.join(pluginsDir, plugin, "common", "agents");
        for (const entry of entriesIfPresent(dir).sort())
            if (entry.endsWith(".md") && !entry.endsWith(".claude.md"))
                files.push(path.join(dir, entry));
    }
    return files;
}
function main(argv) {
    const root = path.resolve(import.meta.dir, "..");
    const files = argv.length > 0 ? argv : shippedAgents(path.join(root, "plugins"));
    const findings = checkFiles(root, files);
    for (const finding of findings)
        console.error(`${finding.file}: ${finding.reason}`);
    if (findings.length > 0) {
        console.error(`check-agent-roles: ${findings.length} finding(s)`);
        return 1;
    }
    console.log(`check-agent-roles: ${files.length} agent(s) declare a model tier and positive integer steps`);
    return 0;
}
if (import.meta.main)
    process.exit(main(process.argv.slice(2)));
