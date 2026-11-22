/** Shared types and small helpers for plugin-audit: findings, the repository snapshot and version specs. */
export const CATEGORIES = ["versions", "docs", "practices", "bumps", "consistency"];
export const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };
/** Plugin label for a finding about the root package.json. */
export const ROOT = "(root)";
/** Plugin label for a finding about the whole repository. */
export const REPO = "(repo)";
export const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies"];
/** The object under `key`, or an empty object when the manifest lacks it or it is not an object. */
export function objectAt(source, key) {
    const value = source[key];
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
/**
 * The exact version a spec names: `1.2.3`, `^1.2.3`, `~1.2.3` or `=1.2.3`. Undefined for
 * anything else (workspace:*, file:, git URLs, dist-tags, compound ranges).
 */
export function plainVersion(spec) {
    if (typeof spec !== "string")
        return undefined;
    return /^[\^~=]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec.trim())?.[1];
}
/**
 * The host modules OpenCode supplies at runtime. Copied from HOST_MODULES in scripts/build.ts,
 * which cannot be imported (it runs its build when loaded). Only the four that AGENTS.md pins
 * to the latest release are listed; `effect` is left out on purpose.
 */
export const HOST_MODULES = ["@opencode/plugin", "@opencode/client", "@opentui/*", "solid-js"];
export function isHostModule(name) {
    return HOST_MODULES.some((pattern) => pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
}
