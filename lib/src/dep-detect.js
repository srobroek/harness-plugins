/**
 * Offline dependency detection from a project's root manifests and lockfiles.
 *
 * Shared by the dep-update and whats-new plugins. Ported from omp-plugins
 * (`dep-update/extensions/detect.ts`, byte-identical to the whats-new copy there).
 * Reads files only; never runs a package manager or touches the network.
 */
import { statSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
export const MISSING = "?";
const REQ_SPLIT = /[[<>=!~;\s]/;
export const REQ_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GEM = /^\s*gem\s+(['"])([^'"]+)\1(?:\s*,\s*(['"])([^'"]*)\3)?/;
/** PEP 503 normalized name: Python package names compare case- and separator-insensitively. */
export function canonical(name) {
    return name.replace(/[-_.]+/g, "-").toLowerCase();
}
export function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
export function isDir(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function join(root, name) {
    return root.endsWith("/") ? root + name : `${root}/${name}`;
}
export async function readText(path) {
    try {
        if (!isFile(path))
            return null;
        const buf = await Bun.file(path).arrayBuffer();
        let text = new TextDecoder("utf-8").decode(buf);
        if (text.charCodeAt(0) === 0xfeff)
            text = text.slice(1);
        return text;
    }
    catch {
        return null;
    }
}
function scalar(value) {
    if (value === null || value === undefined || typeof value === "object")
        return MISSING;
    return String(value);
}
function specVersion(spec) {
    if (spec && typeof spec === "object" && !Array.isArray(spec)) {
        return scalar(spec.version);
    }
    if (Array.isArray(spec)) {
        for (const item of spec) {
            if (item && typeof item === "object" && item.version != null) {
                return scalar(item.version);
            }
        }
        return MISSING;
    }
    return scalar(spec);
}
/**
 * A lockfile entry built from the local tree: the project itself, a workspace member,
 * or a path dependency. uv records `source = { editable | virtual | directory | path }`;
 * poetry records `[package.source] type = "directory" | "file"` or `develop = true`.
 */
function isLocalLockEntry(rec) {
    if (rec.develop === true)
        return true;
    const source = rec.source;
    if (!source || typeof source !== "object" || Array.isArray(source))
        return false;
    const s = source;
    if (s.editable !== undefined || s.virtual !== undefined || s.directory !== undefined || s.path !== undefined)
        return true;
    return s.type === "directory" || s.type === "file";
}
export function parseRequirement(raw) {
    const first = raw.split("#", 1)[0];
    if (first === undefined)
        return ["", ""];
    let line = first.trim();
    line = line.replace(/\\+$/, "").trim();
    if (!line || line.startsWith("-") || line.startsWith(".") || line.startsWith("/")) {
        return ["", ""];
    }
    const beforeSemicolon = line.split(";", 1)[0];
    if (beforeSemicolon === undefined)
        return ["", ""];
    line = beforeSemicolon.trim();
    const match = REQ_SPLIT.exec(line);
    if (!match) {
        return REQ_NAME.test(line) ? [line, MISSING] : ["", ""];
    }
    const name = line.slice(0, match.index).trim();
    if (!REQ_NAME.test(name))
        return ["", ""];
    const rest = line.slice(match.index);
    const version = rest.replace(/\[[^\]]*\]/g, "").trim();
    return [name, version || MISSING];
}
export class Detector {
    root;
    map = new Map();
    notes = [];
    constructor(root) {
        this.root = root;
    }
    get rows() {
        const out = [];
        for (const [key, versions] of this.map) {
            const tab = key.indexOf("\0");
            out.push({ ecosystem: key.slice(0, tab), name: key.slice(tab + 1), ...versions });
        }
        return out;
    }
    emit(ecosystem, name, declared, resolved = null, direct = true) {
        if (name)
            this.map.set(`${ecosystem}\0${name}`, { declared: declared || MISSING, resolved, direct });
    }
    note(msg) {
        this.notes.push(msg);
    }
    async readToml(name) {
        const body = await readText(join(this.root, name));
        if (body === null)
            return null;
        try {
            const data = parseToml(body);
            return data && typeof data === "object" ? data : null;
        }
        catch (exc) {
            this.note(`detect: ${name} is unreadable (${exc}); skipping`);
            return null;
        }
    }
    async readJson(name) {
        const body = await readText(join(this.root, name));
        if (body === null)
            return null;
        try {
            const data = JSON.parse(body);
            return data && typeof data === "object" && !Array.isArray(data) ? data : null;
        }
        catch (exc) {
            this.note(`detect: ${name} is unreadable (${exc}); skipping`);
            return null;
        }
    }
    async readLines(name) {
        const body = await readText(join(this.root, name));
        if (body === null)
            return null;
        return body.split(/\r?\n/);
    }
    async scanNode() {
        const data = await this.readJson("package.json");
        if (!data)
            return;
        const lock = await this.readJson("package-lock.json");
        const locked = new Map();
        const packages = lock?.packages;
        if (packages && typeof packages === "object" && !Array.isArray(packages)) {
            for (const [path, entry] of Object.entries(packages)) {
                if (!path.startsWith("node_modules/") || !entry || typeof entry !== "object")
                    continue;
                const version = entry.version;
                if (typeof version === "string")
                    locked.set(path.slice("node_modules/".length), version);
            }
        }
        else if (lock) {
            this.note("detect: package-lock.json has no packages map; declared Node versions remain unresolved");
        }
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
            const block = data[field];
            if (!block || typeof block !== "object" || Array.isArray(block))
                continue;
            for (const [name, spec] of Object.entries(block)) {
                this.emit("npm", name, scalar(spec), locked.get(name) ?? null);
            }
        }
    }
    /**
     * Declarations come from pyproject.toml (PEP 621 dependencies and extras, PEP 735
     * dependency groups, Poetry tables), else requirements.txt. uv.lock or poetry.lock
     * only fills `resolved`, matched by normalized name. Lock entries the project does
     * not declare are emitted as transitive (`direct: false`, declared `?`). Local
     * sources -- the project itself, workspace members, path dependencies -- are not
     * registry packages and are skipped.
     */
    async scanPython() {
        const declared = new Map();
        const declare = (name, spec) => {
            if (!name || /^@\s*file:/i.test(spec))
                return;
            const key = canonical(name);
            if (!declared.has(key))
                declared.set(key, [name, spec]);
        };
        const pyproject = await this.readToml("pyproject.toml");
        if (pyproject) {
            this.scanPep621(pyproject.project, declare);
            this.scanDependencyGroups(pyproject["dependency-groups"], declare);
            const tool = pyproject.tool;
            if (tool && typeof tool === "object") {
                this.scanPoetry(tool.poetry, declare);
            }
        }
        if (declared.size === 0) {
            for (const raw of (await this.readLines("requirements.txt")) ?? []) {
                const [name, version] = parseRequirement(raw);
                declare(name, version);
            }
        }
        const locked = new Map();
        const local = new Set();
        for (const lock of ["uv.lock", "poetry.lock"]) {
            const data = await this.readToml(lock);
            if (!data)
                continue;
            const pkgs = data.package;
            if (!Array.isArray(pkgs)) {
                this.note(`detect: ${lock} has no package array; Python versions remain unresolved`);
                continue;
            }
            for (const entry of pkgs) {
                if (!entry || typeof entry !== "object")
                    continue;
                const rec = entry;
                if (typeof rec.name !== "string" || typeof rec.version !== "string")
                    continue;
                const key = canonical(rec.name);
                if (isLocalLockEntry(rec))
                    local.add(key);
                else if (!locked.has(key))
                    locked.set(key, [rec.name, rec.version]);
            }
            break;
        }
        for (const [key, [name, spec]] of declared) {
            if (!local.has(key))
                this.emit("pypi", name, spec, locked.get(key)?.[1] ?? null);
        }
        for (const [key, [name, version]] of locked) {
            if (!declared.has(key))
                this.emit("pypi", name, MISSING, version, false);
        }
    }
    scanPep621(project, declare) {
        if (!project || typeof project !== "object")
            return;
        const p = project;
        for (const req of Array.isArray(p.dependencies) ? p.dependencies : []) {
            if (typeof req === "string")
                declare(...parseRequirement(req));
        }
        const extras = p["optional-dependencies"];
        if (extras && typeof extras === "object") {
            for (const reqs of Object.values(extras)) {
                for (const req of Array.isArray(reqs) ? reqs : []) {
                    if (typeof req === "string")
                        declare(...parseRequirement(req));
                }
            }
        }
    }
    scanDependencyGroups(groups, declare) {
        if (!groups || typeof groups !== "object")
            return;
        for (const reqs of Object.values(groups)) {
            for (const req of Array.isArray(reqs) ? reqs : []) {
                if (typeof req === "string")
                    declare(...parseRequirement(req));
            }
        }
    }
    scanPoetry(poetry, declare) {
        if (!poetry || typeof poetry !== "object")
            return;
        const p = poetry;
        const blocks = [p.dependencies, p["dev-dependencies"]];
        const groups = p.group;
        if (groups && typeof groups === "object") {
            for (const group of Object.values(groups)) {
                if (group && typeof group === "object") {
                    blocks.push(group.dependencies);
                }
            }
        }
        for (const block of blocks) {
            if (!block || typeof block !== "object" || Array.isArray(block))
                continue;
            for (const [name, spec] of Object.entries(block)) {
                if (name === "python")
                    continue;
                // `{ path = "../lib" }` is a local source, not a registry package.
                if (spec && typeof spec === "object" && !Array.isArray(spec) && "path" in spec)
                    continue;
                declare(name, specVersion(spec));
            }
        }
    }
    async scanRust() {
        const data = await this.readToml("Cargo.toml");
        if (!data)
            return;
        for (const field of ["dependencies", "dev-dependencies", "build-dependencies"]) {
            const block = data[field];
            if (!block || typeof block !== "object" || Array.isArray(block))
                continue;
            for (const [name, spec] of Object.entries(block)) {
                this.emit("cargo", name, specVersion(spec));
            }
        }
    }
    async scanGo() {
        const lines = await this.readLines("go.mod");
        if (!lines)
            return;
        let inBlock = false;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith("require (") || line === "require(") {
                inBlock = true;
                continue;
            }
            if (line.startsWith(")")) {
                inBlock = false;
                continue;
            }
            if (line.startsWith("require ")) {
                const fields = line.split(/\s+/);
                this.emit("go", fields[1] ?? "", fields[2] ?? MISSING);
                continue;
            }
            if (inBlock) {
                if (!line || line.startsWith("//"))
                    continue;
                const fields = line.split(/\s+/);
                this.emit("go", fields[0] ?? "", fields[1] ?? MISSING);
            }
        }
    }
    async scanRuby() {
        const lines = await this.readLines("Gemfile");
        if (!lines)
            return;
        for (const raw of lines) {
            const match = GEM.exec(raw);
            if (match?.[2])
                this.emit("rubygems", match[2], match[4] || MISSING);
        }
    }
    async scanPhp() {
        const data = await this.readJson("composer.json");
        if (!data)
            return;
        for (const field of ["require", "require-dev"]) {
            const block = data[field];
            if (!block || typeof block !== "object" || Array.isArray(block))
                continue;
            for (const [rawName, spec] of Object.entries(block)) {
                const name = String(rawName);
                if (name === "php" || name.startsWith("ext-") || name.startsWith("lib-") || name.includes(" ")) {
                    continue;
                }
                this.emit("packagist", name, scalar(spec));
            }
        }
    }
    async scanAll() {
        await this.scanNode();
        await this.scanPython();
        await this.scanRust();
        await this.scanGo();
        await this.scanRuby();
        await this.scanPhp();
    }
}
export async function detectProject(target) {
    if (!isDir(target))
        return { ok: false, exit: 2, rows: [], stderr: `detect: '${target}' is not a directory`, coverage: { gaps: [] } };
    const detector = new Detector(target);
    await detector.scanAll();
    const gaps = ["Cargo.lock", "go.sum", "Pipfile.lock", "Ruby/PHP lockfiles", "workspace children"];
    const hasPackageLock = isFile(join(target, "package-lock.json"));
    if (!hasPackageLock)
        gaps.unshift("Node lockfiles");
    const notes = [...detector.notes];
    notes.push(`Coverage: root declarations; resolved versions from uv.lock/poetry.lock${hasPackageLock ? " and package-lock.json" : ""}; undeclared Python lock entries listed as transitive (direct=false). Unscanned: ${gaps.join(", ")}.`);
    notes.push("");
    notes.push(`detect: ${detector.rows.length} dependency declaration(s) found in ${target}`);
    if (detector.rows.length === 0) {
        notes.push("No supported manifest found (package.json, uv.lock, poetry.lock,");
        notes.push("requirements.txt, pyproject.toml, Cargo.toml, go.mod, Gemfile,");
        notes.push("composer.json).");
    }
    return { ok: true, exit: 0, rows: detector.rows, stderr: notes.join("\n"), coverage: { gaps } };
}
