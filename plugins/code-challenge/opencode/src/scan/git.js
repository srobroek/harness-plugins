import { lstatSync } from "node:fs";
import { join } from "node:path";
import { contained, parseListing } from "./files.ts";
/**
 * Options for every git call. The target is a repository we have not yet been allowed to run
 * anything from, so no configured fsmonitor command and no hooks directory may run.
 */
export const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
const LIST_TIMEOUT_MS = 30_000;
function hasDotGit(root) {
    return lstatSync(join(root, ".git"), { throwIfNoEntry: false }) !== undefined;
}
export async function gitState(root, exec, which, signal) {
    const git = which("git");
    // Without a git binary a repository cannot be told apart from a plain directory, except by its .git entry.
    if (!git)
        return hasDotGit(root) ? { kind: "error", reason: "git is not installed" } : { kind: "none" };
    const run = await exec([git, ...GIT_SAFE, "rev-parse", "--absolute-git-dir"], { cwd: root, timeoutMs: 10_000, signal });
    if (run.kind !== "exited")
        return { kind: "error", reason: `git rev-parse ${run.kind === "timeout" ? "timed out" : "did not finish"}` };
    if (run.exitCode === 0) {
        const dir = run.stdout.trim();
        return dir === "" ? { kind: "error", reason: "git rev-parse printed no git directory" } : { kind: "repo", dir };
    }
    // 128 is git's fatal status; only this exact complaint means "not a repository".
    return run.exitCode === 128 && /not a git repository/i.test(run.stderr)
        ? { kind: "none" }
        : { kind: "error", reason: `git rev-parse exited ${run.exitCode}` };
}
async function list(git, root, exec, args, signal) {
    const run = await exec([git, ...GIT_SAFE, "ls-files", "-z", ...args], { cwd: root, timeoutMs: LIST_TIMEOUT_MS, signal });
    if (run.kind !== "exited")
        return `git ls-files ${run.kind === "timeout" ? "timed out" : run.kind === "overflow" ? "output was too large" : "did not finish"}`;
    if (run.exitCode !== 0)
        return `git ls-files exited ${run.exitCode}`;
    return parseListing(run.stdout);
}
/**
 * The files git does not ignore: tracked and untracked, minus tracked files that an ignore rule
 * matches. Every path is checked against the root (no symlinks, no escapes). A failure is an
 * `error`, never an empty listing, because callers use the listing to enforce ignores.
 */
export async function gitListing(root, state, exec, which, signal) {
    if (state.kind === "none")
        return { kind: "none" };
    if (state.kind === "error")
        return state;
    const git = which("git");
    if (!git)
        return { kind: "error", reason: "git is not installed" };
    const known = await list(git, root, exec, ["--cached", "--others", "--exclude-standard"], signal);
    if (typeof known === "string")
        return { kind: "error", reason: known };
    const ignored = await list(git, root, exec, ["--cached", "--ignored", "--exclude-standard"], signal);
    if (typeof ignored === "string")
        return { kind: "error", reason: ignored };
    const drop = new Set(ignored);
    return { kind: "files", files: contained(root, [...new Set(known)].filter((f) => !drop.has(f))) };
}
