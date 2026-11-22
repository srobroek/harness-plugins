import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parse, parsedInvocations, scanShell } from "@srobroek/opencode-lib/beads-shell";
const BINARY_MAGICS = [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
    [0xca, 0xfe, 0xba, 0xbf],
    [0xbf, 0xba, 0xfe, 0xca],
    [0x7f, 0x45, 0x4c, 0x46],
];
const SAMPLE_BYTES = 4096;
const GLOBAL_VALUE_FLAGS = new Set([
    "--actor",
    "--database",
    "--db",
    "-C",
    "--directory",
    "--dolt-auto-commit",
    "--mem-profile",
]);
/**
 * A probe that times out reads as "no binary hooks", which lets `bd init` rewrite them,
 * so the bound only has to stop a hung git: a loaded machine can take over a second to
 * start one.
 */
const GIT_PROBE_TIMEOUT_MS = 5_000;
function runGit(cwd, args) {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_PROBE_TIMEOUT_MS });
    if (result.error)
        throw result.error;
    return { status: result.status, stdout: result.stdout.trim() };
}
function hooksDirectory(cwd, git) {
    const result = git(cwd, ["rev-parse", "--git-path", "hooks"]);
    if (result.status === 0 && result.stdout !== "")
        return isAbsolute(result.stdout) ? result.stdout : resolve(cwd, result.stdout);
    // `bd init` can run before Git has initialised the checkout. In that case the
    // inherited system/global hooksPath is still the hook directory bd preserves.
    const configured = git(cwd, ["config", "--path", "--get", "core.hooksPath"]);
    if (configured.status === 0 && configured.stdout !== "") {
        return isAbsolute(configured.stdout) ? configured.stdout : resolve(cwd, configured.stdout);
    }
    const conventional = join(cwd, ".git", "hooks");
    return existsSync(conventional) ? conventional : undefined;
}
function fileHasMarker(path, magicsOnly = false) {
    const fd = openSync(path, "r");
    try {
        const bytes = Buffer.alloc(SAMPLE_BYTES);
        const count = readSync(fd, bytes, 0, bytes.length, 0);
        const sample = bytes.subarray(0, count);
        if (!magicsOnly && sample.includes(0))
            return true;
        return BINARY_MAGICS.some((magic) => sample.length >= magic.length && magic.every((byte, index) => sample[index] === byte));
    }
    finally {
        closeSync(fd);
    }
}
/** True when Git's effective hook directory contains a regular non-text executable. */
export function hasBinaryHooks(cwd, git = runGit) {
    try {
        const directory = hooksDirectory(cwd, git);
        if (directory === undefined)
            return false;
        for (const entry of readdirSync(directory)) {
            const path = join(directory, entry);
            if (statSync(path).isFile() && fileHasMarker(path))
                return true;
        }
        return false;
    }
    catch {
        // This preventive gate is advisory on probe failures; never break unrelated bd use.
        return false;
    }
}
function initVerbIndex(words) {
    let index = words.findIndex((word) => (word.value.split("/").pop() ?? word.value) === "bd");
    if (index < 0)
        return undefined;
    index++;
    while (index < words.length) {
        const flag = words[index]?.value ?? "";
        if (!flag.startsWith("-"))
            return flag === "init" ? index : undefined;
        if (flag === "--")
            return undefined;
        if (GLOBAL_VALUE_FLAGS.has(flag) && !flag.includes("="))
            index++;
        index++;
    }
    return undefined;
}
/** Add --skip-hooks to direct `bd init` calls while preserving all original shell text. */
function rewriteInitCalls(command) {
    const scan = scanShell(command);
    // An unterminated quote or here-document: the offsets cannot be trusted, so the caller blocks.
    if (!scan.complete)
        return undefined;
    const insertions = [];
    for (const item of scan.items) {
        if (item.kind !== "command")
            continue;
        const first = item.words[0];
        const last = item.words.at(-1);
        if (first === undefined || last === undefined)
            continue;
        const parsed = parse(command.slice(first.start, last.end));
        if (parsed.unknown || parsed.commands.length !== 1)
            continue;
        const invocation = parsedInvocations(parsed).find((candidate) => candidate.verb === "init");
        if (invocation === undefined || invocation.args.includes("--skip-hooks"))
            continue;
        const verb = item.words[initVerbIndex(item.words) ?? -1];
        if (verb !== undefined)
            insertions.push(verb.end);
    }
    if (insertions.length === 0)
        return undefined;
    let rewritten = command;
    for (const offset of insertions.sort((left, right) => right - left))
        rewritten = `${rewritten.slice(0, offset)} --skip-hooks${rewritten.slice(offset)}`;
    // Every init must be guarded now; one the scan could not place (inside a substitution) means block.
    // A rewritten command the parser refuses (for example past its size limit) cannot be checked.
    const checked = parse(rewritten);
    if (checked.unknown)
        return undefined;
    const unguarded = parsedInvocations(checked).some((invocation) => invocation.verb === "init" && !invocation.args.includes("--skip-hooks"));
    return unguarded ? undefined : rewritten;
}
/** Protect `bd init` and `bd hooks install` before the embedded-write runner rewrites them. */
export function protectBinaryHookCommands(input, command, cwd, git = runGit) {
    try {
        const invocations = parsedInvocations(parse(command));
        const inits = invocations.filter((invocation) => invocation.verb === "init");
        const installs = invocations.filter((invocation) => invocation.verb === "hooks" && invocation.args[1] === "install");
        const needsInitGuard = inits.some((invocation) => !invocation.args.includes("--skip-hooks"));
        if (!needsInitGuard && installs.length === 0)
            return undefined;
        if (!hasBinaryHooks(cwd, git))
            return undefined;
        if (installs.length > 0) {
            return {
                kind: "block",
                reason: "`bd hooks install` was blocked because an existing Git hook is a binary executable that this installer could corrupt; it was blocked to keep the existing (binary) hooks intact.",
            };
        }
        if (!needsInitGuard)
            return undefined;
        const rewritten = rewriteInitCalls(command);
        if (rewritten === undefined) {
            return {
                kind: "block",
                reason: "`bd init` was blocked because binary Git hooks exist and the command could not be safely rewritten to add `--skip-hooks`; this keeps the existing (binary) hooks intact.",
            };
        }
        const record = input !== null && typeof input === "object" ? input : undefined;
        const key = typeof record?.command === "string" ? "command" : typeof record?.cmd === "string" ? "cmd" : undefined;
        if (record === undefined || key === undefined)
            return undefined;
        return { kind: "rewrite", input: { ...record, [key]: rewritten } };
    }
    catch {
        return undefined;
    }
}
function localHookDirectory(cwd, git) {
    const configured = git(cwd, ["config", "--local", "--get", "core.hooksPath"]);
    if (configured.status !== 0 || configured.stdout === "")
        return undefined;
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (root.status !== 0 || root.stdout === "")
        return undefined;
    return isAbsolute(configured.stdout) ? configured.stdout : resolve(root.stdout, configured.stdout);
}
/** Containment on resolved real paths: `/tmp` and `/var` are symlinks on macOS, and git reports the real form. */
function realPath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return resolve(path);
    }
}
function isInside(path, directory) {
    const target = realPath(path);
    const base = realPath(directory);
    return target === base || target.startsWith(`${base}${sep}`);
}
/** Return repair guidance only when Beads has modified a binary hook backup. */
export function binaryHooksRepairAdvisory(cwd, git = runGit) {
    try {
        const directory = localHookDirectory(cwd, git);
        if (directory === undefined)
            return undefined;
        const root = git(cwd, ["rev-parse", "--show-toplevel"]);
        if (root.status !== 0 || root.stdout === "")
            return undefined;
        const beadsHooks = join(root.stdout, ".beads", "hooks");
        if (!isInside(directory, beadsHooks))
            return undefined;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".backup"))
                continue;
            const backupPath = join(directory, entry.name);
            const hookPath = join(directory, entry.name.slice(0, -".backup".length));
            try {
                if (!statSync(hookPath).isFile() || !fileHasMarker(backupPath, true))
                    continue;
                if (!readFileSync(backupPath).equals(readFileSync(hookPath))) {
                    return "Beads appears to have modified a binary Git hook. Repair it manually with `git config --local --unset core.hooksPath` to restore the system/global hooks; then delete the copied bundle with `rm -r .beads/hooks` and add `.beads/hooks/` to `.gitignore`. Optionally run `bd hooks uninstall` first to remove the Beads-managed hooks. No repair was run automatically.";
                }
            }
            catch {
                // A missing/unreadable backup is not enough evidence for an advisory.
            }
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
