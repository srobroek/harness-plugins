/**
 * Agents read the user's steering files before some tasks (a push, `bd init`), and a subagent cannot
 * answer the `external_directory` prompt that read raises. This turns that ask into an allow for the
 * read-only tools inside a short list of steering directories. A deny and every other action are left alone.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { insideCanonical, pinned } from "./scratch-dirs.ts";
export const DEFAULT_STEERING_DIRS = ["~/.config/opencode/steering"];
/** The `steeringDirs` option: a list of strings; anything else gives the default. */
export function readSteeringDirs(raw) {
    if (!Array.isArray(raw))
        return [...DEFAULT_STEERING_DIRS];
    return raw.filter((entry) => typeof entry === "string" && entry !== "");
}
/**
 * The directories that exist and are trusted: `~/` expanded, symlinks resolved with realpath, and the
 * resolved path pinned (no symlink component, owned by the current user). Others are dropped.
 */
export function steeringRoots(dirs, home = homedir(), uid) {
    const roots = [];
    for (const dir of dirs) {
        const expanded = dir === "~" || dir.startsWith("~/") ? join(home, dir.slice(1)) : dir;
        if (!isAbsolute(expanded))
            continue;
        try {
            const real = realpathSync(expanded);
            if (pinned(real, uid))
                roots.push(real);
        }
        catch {
            // A missing directory has nothing to allow.
        }
    }
    return roots;
}
/** Turn an `external_directory` ask into an allow when every resource is inside one of the trusted roots. */
export function allowSteeringReads(evaluation, roots) {
    if (evaluation.action !== "external_directory" || evaluation.effect !== "ask")
        return;
    if (evaluation.resources.length === 0 || roots.length === 0)
        return;
    // `steeringRoots` returns pinned real paths; the roots are not resolved again here.
    if (evaluation.resources.every((resource) => insideCanonical(resource, roots)))
        evaluation.effect = "allow";
}
