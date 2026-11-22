/**
 * Refuses writes to a chezmoi-managed live target: the next `chezmoi apply`
 * overwrites the target from source, so the edit is lost. The refusal names the
 * source path to edit instead. Ported from omp-plugins (`chezmoi/extensions/chezmoi-guard.ts`).
 *
 * A seed-once target (source basename with a `create_` attribute) is the exception:
 * chezmoi writes it only when it is missing, so the app owns it and the write is allowed.
 *
 * Coverage is literal and static, never a shell sandbox. The write targets come from
 * `writtenPaths` in the shared lib: `edit`/`write` paths, `patch` file headers, and
 * the redirects, `tee`, `cp`/`mv`, `sed -i` and `perl -i` targets of a `shell` call.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { under } from "@srobroek/opencode-lib/shell-write-targets";
import { supervise } from "@srobroek/opencode-lib/subprocess";
import { shellCall, writtenPaths } from "@srobroek/opencode-lib/tool-targets";
export const SUBPROCESS_TIMEOUT_MS = 2000;
/** `chezmoi add`/`forget` from another terminal change the managed set without any call the guard sees. */
export const MANAGED_TTL_MS = 5000;
/**
 * Source-name attribute prefixes that can precede a type prefix such as `create_`.
 * `literal_` and `dot_` end the attribute run, so they are not listed.
 */
const ATTRIBUTE_PREFIXES = new Set([
    "encrypted", "private", "readonly", "empty", "executable", "exact", "external",
    "create", "modify", "remove", "symlink", "run", "once", "onchange", "before", "after",
]);
/** Whether a source file is seed-once: its attribute run includes `create_` in any order. */
function isSeedOnceSource(source) {
    let name = basename(source);
    for (;;) {
        const cut = name.indexOf("_");
        if (cut <= 0 || !ATTRIBUTE_PREFIXES.has(name.slice(0, cut)))
            return false;
        if (name.slice(0, cut) === "create")
            return true;
        name = name.slice(cut + 1);
    }
}
/** `chezmoi` as a command word: its subcommands (`add`, `forget`, …) change the managed set. */
const CHEZMOI_RUN = /(?:^|[\s;&|(/])chezmoi(?:\s|$)/;
export const spawnChezmoi = async (args) => {
    try {
        const proc = Bun.spawn(["chezmoi", ...args], { stdout: "pipe", stderr: "ignore" });
        const run = await supervise(proc, { timeoutMs: SUBPROCESS_TIMEOUT_MS });
        return run.kind === "exited" && run.exitCode === 0 ? run.stdout : null;
    }
    catch {
        return null;
    }
};
function normalized(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
export function refusal(target, source) {
    const hint = source ? `'${source}'` : `the path \`chezmoi source-path ${target}\` prints`;
    return (`'${target}' is a chezmoi-managed target, not the source; the next chezmoi apply overwrites it. ` +
        `Edit the source at ${hint}, then run chezmoi apply. Do not write the live home-directory copy.`);
}
export function createGuard(options = {}) {
    const spawn = options.spawn ?? spawnChezmoi;
    const now = options.now ?? Date.now;
    const home = options.home ?? homedir();
    const ttl = options.ttlMs ?? MANAGED_TTL_MS;
    let managed = null;
    /** Real path to managed path, built on the first miss after each load. */
    let aliases = null;
    let managedAt = 0;
    let sourceDir;
    const invalidate = () => {
        managed = null;
        aliases = null;
    };
    const loadSourceDir = async () => {
        if (sourceDir !== undefined)
            return sourceDir;
        const out = await spawn(["source-path"]);
        sourceDir = out?.trim() || null;
        return sourceDir;
    };
    const loadManaged = async () => {
        if (managed && now() - managedAt < ttl)
            return managed;
        const out = await spawn(["managed", "--path-style=absolute"]);
        if (out === null)
            return null;
        managed = new Set(out
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean));
        aliases = null;
        managedAt = now();
        return managed;
    };
    const managedTarget = (set, abs) => {
        if (set.has(abs))
            return abs;
        aliases ??= new Map([...set].map((path) => [normalized(path), path]));
        return aliases.get(normalized(abs));
    };
    const considerPath = async (abs) => {
        if (!under(abs, home) && !under(normalized(abs), normalized(home)))
            return undefined;
        const source = await loadSourceDir();
        if (source && (under(abs, source) || under(normalized(abs), normalized(source)))) {
            // A source edit changes what `chezmoi managed` lists after the next apply.
            invalidate();
            return undefined;
        }
        const set = await loadManaged();
        if (!set)
            return undefined;
        const target = managedTarget(set, abs);
        if (!target)
            return undefined;
        const targetSource = (await spawn(["source-path", target]))?.trim() || undefined;
        if (targetSource && isSeedOnceSource(targetSource))
            return undefined;
        return refusal(abs, targetSource);
    };
    return {
        invalidate,
        decide: async (tool, input, cwd) => {
            const shell = shellCall(tool, input);
            if (shell && CHEZMOI_RUN.test(shell.command))
                invalidate();
            for (const abs of writtenPaths(tool, input, cwd)) {
                const reason = await considerPath(abs);
                if (reason)
                    return reason;
            }
            return undefined;
        },
    };
}
