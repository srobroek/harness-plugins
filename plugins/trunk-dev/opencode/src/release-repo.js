import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const GIT_TIMEOUT_MS = 2_000;
/** `git <args>` in `cwd`: its stdout on success, `null` on any failure. */
export function runGit(args, cwd) {
    try {
        const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS });
        return result.exitCode === 0 ? result.stdout.toString() : null;
    }
    catch {
        return null;
    }
}
export function readText(path) {
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return null;
    }
}
function diskExists(path) {
    try {
        return existsSync(path);
    }
    catch {
        return false;
    }
}
const RELEASE_MARKERS = [
    ".releaserc",
    ".releaserc.json",
    ".releaserc.yml",
    ".releaserc.yaml",
    ".releaserc.js",
    ".releaserc.cjs",
    ".releaserc.mjs",
    "release.config.js",
    "release.config.cjs",
    "release.config.mjs",
    "release-please-config.json",
    ".release-please-manifest.json",
];
const COMMITLINT = /^(?:\.commitlintrc.*|commitlint\.config\..+)$/;
/** True only when a release-from-commits marker exists at the repository root. */
export function isReleaseRepository(cwd, options) {
    try {
        const rootText = options.git(["rev-parse", "--show-toplevel"], cwd)?.trim();
        if (!rootText)
            return false;
        const root = resolve(rootText);
        const exists = options.exists ?? diskExists;
        const read = options.readFile ?? readText;
        for (const marker of RELEASE_MARKERS)
            if (exists(resolve(root, marker)))
                return true;
        const packageJson = resolve(root, "package.json");
        if (exists(packageJson)) {
            const parsed = JSON.parse(read(packageJson) ?? "");
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "release" in parsed)
                return true;
        }
        const list = options.list ?? ((path) => readdirSync(path));
        return list(root).some((name) => COMMITLINT.test(name) && exists(resolve(root, name)));
    }
    catch {
        return false;
    }
}
