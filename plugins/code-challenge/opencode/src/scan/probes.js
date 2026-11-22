import { dirname, join } from "node:path";
import { MAX_MARKER_BYTES } from "./files.ts";
import { readText } from "./read.ts";
const UNKNOWN = () => null;
/** The config file ruff would pick for `file`: the nearest ruff.toml, .ruff.toml or pyproject.toml with [tool.ruff]. */
export function nearestRuffConfig(root, file) {
    let dir = dirname(join(root, file));
    for (;;) {
        for (const name of [".ruff.toml", "ruff.toml", "pyproject.toml"]) {
            const path = join(dir, name);
            const read = readText(path, MAX_MARKER_BYTES);
            if (read.kind !== "text")
                continue;
            if (name !== "pyproject.toml" || read.text.includes("[tool.ruff"))
                return path;
        }
        if (dir === root || dirname(dir) === dir)
            return "";
        dir = dirname(dir);
    }
}
/** One `ruff check --show-settings` per distinct config; null when the answer is not usable. */
async function ruffSettings(env, file) {
    const run = await env.exec([...env.prefix, "check", "--show-settings", join(env.root, file)], {
        cwd: env.root,
        timeoutMs: env.timeoutMs,
        signal: env.signal,
    });
    if (run.kind !== "exited" || run.exitCode !== 0)
        return null;
    const start = run.stdout.indexOf("linter.rules.enabled = [");
    if (start < 0)
        return null;
    const end = run.stdout.indexOf("\n]", start);
    const block = run.stdout.slice(start, end < 0 ? undefined : end);
    return new Set([...block.matchAll(/\(([A-Z]+[0-9]+)\)/g)].map((m) => m[1] ?? ""));
}
async function golangciEnabled(env) {
    const run = await env.exec([...env.prefix, "linters", "--json"], { cwd: env.root, timeoutMs: env.timeoutMs, signal: env.signal });
    if (run.kind !== "exited" || run.exitCode !== 0)
        return null;
    try {
        const parsed = JSON.parse(run.stdout);
        if (!Array.isArray(parsed.Enabled))
            return null;
        return new Set(parsed.Enabled.flatMap((l) => (l.name ? [l.name] : [])));
    }
    catch {
        return null;
    }
}
/** The probe for a recipe, or null when the tool has no cheap answer (those hits report null). */
export function probeFor(recipe, env) {
    if (recipe.tool === "ruff") {
        return async (hits) => {
            const byConfig = new Map();
            const keyOf = new Map();
            for (const hit of hits) {
                if (hit.file === null)
                    continue;
                const key = nearestRuffConfig(env.root, hit.file);
                keyOf.set(hit, key);
                if (!byConfig.has(key))
                    byConfig.set(key, hit.file);
            }
            const settings = new Map();
            for (const [key, file] of byConfig)
                settings.set(key, await ruffSettings(env, file));
            return (hit) => {
                const key = keyOf.get(hit);
                const enabled = key === undefined ? null : settings.get(key);
                return enabled ? enabled.has(hit.rule) : null;
            };
        };
    }
    if (recipe.tool === "golangci-lint") {
        return async () => {
            const enabled = await golangciEnabled(env);
            return enabled ? (hit) => enabled.has(hit.rule) : UNKNOWN;
        };
    }
    return null;
}
