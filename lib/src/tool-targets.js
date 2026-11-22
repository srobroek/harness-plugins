/**
 * The files and commands an OpenCode V2 built-in tool call names, read statically
 * from its input. Ported from omp-plugins (`chezmoi/extensions/tool-targets.ts`),
 * with the Oh My Pi hashline and `ast_edit` shapes dropped.
 *
 * Built-in input shapes:
 * - `edit`  `{ path, oldString, newString }`
 * - `write` `{ path, content }`
 * - `patch` `{ patchText }` with `*** Add File:` / `*** Update File:` /
 *   `*** Delete File:` / `*** Move to:` headers
 * - `read`  `{ path }`
 * - `shell` `{ command, workdir?, timeout?, background? }`
 */
import { lexicalAbs, shellWriteTargets } from "./shell-write-targets.ts";
/** Built-in tools whose input names the files the call writes. */
export const WRITE_TOOLS = new Set(["edit", "write", "patch"]);
/** Built-in tools whose input names the files the call reads. */
export const READ_TOOLS = new Set(["read"]);
export const SHELL_TOOL = "shell";
/**
 * Names models call `shell` by although no such tool exists. The agent-efficiency
 * plugin routes them to `shell` in `execute.before`; guards treat them as `shell` so
 * they hold whichever plugin's hook runs first.
 */
export const SHELL_ALIASES = new Set(["bash", "Bash"]);
/** Whether a tool call runs a shell command: `shell` or one of its aliases. */
export function isShellTool(tool) {
    return tool === SHELL_TOOL || SHELL_ALIASES.has(tool);
}
const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
function quoteWord(word) {
    return SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
/** A command given as a string or an argv array, as one command string. */
function commandText(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value) || value.length === 0 || !value.every((word) => typeof word === "string"))
        return undefined;
    const argv = value;
    const executable = argv[0]?.split("/").pop() ?? "";
    if (argv.length === 3 && SHELL_EXECUTABLES.has(executable) && /^-l?c$/.test(argv[1] ?? ""))
        return argv[2];
    return argv.map(quoteWord).join(" ");
}
function flag(value) {
    if (typeof value === "boolean")
        return value;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return undefined;
}
function milliseconds(value) {
    const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
/**
 * A shell-alias call's input in the `shell` tool's shape. Reads the Claude Code and
 * Codex spellings too: `cmd`, an argv array, `cwd`/`working_directory`,
 * `run_in_background`, `timeout_ms`. Drops every other field. Input without a
 * command string is returned unchanged so `shell` reports the error.
 */
export function shellAliasInput(input) {
    let raw = input;
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw);
        }
        catch {
            return input;
        }
    }
    const value = fields(raw);
    const command = commandText(value.command ?? value.cmd);
    if (command === undefined)
        return input;
    const out = { command };
    const workdir = [value.workdir, value.cwd, value.working_directory].find((dir) => typeof dir === "string" && dir !== "");
    if (workdir !== undefined)
        out.workdir = workdir;
    const timeout = milliseconds(value.timeout ?? value.timeout_ms);
    if (timeout !== undefined)
        out.timeout = timeout;
    const background = flag(value.background ?? value.run_in_background);
    if (background !== undefined)
        out.background = background;
    return out;
}
const PATCH_HEADER = /^\*\*\* (?:(?<verb>Add|Update|Delete) File|(?<move>Move to)):\s*(?<path>.+?)\s*$/;
function unquote(path) {
    const first = path[0];
    if (path.length > 1 && (first === '"' || first === "'") && path.endsWith(first))
        return path.slice(1, -1);
    return path;
}
function fields(input) {
    return input !== null && typeof input === "object" ? input : {};
}
/** Every file header of a patch, in order: what it does and to which path. */
export function patchTargets(patchText) {
    const out = [];
    for (const raw of patchText.split("\n")) {
        const match = PATCH_HEADER.exec(raw.replace(/\r$/, ""));
        const path = match?.groups?.path;
        if (match === null || path === undefined)
            continue;
        const operation = match.groups?.move ? "move" : match.groups?.verb?.toLowerCase();
        const target = unquote(path);
        if (target.length > 0)
            out.push({ operation, path: target });
    }
    return out;
}
/** The paths a patch adds, updates, deletes or moves to, each once. */
export function patchPaths(patchText) {
    return [...new Set(patchTargets(patchText).map((target) => target.path))];
}
/** The paths a write tool call names, as written in its input. */
export function writeTargets(tool, input) {
    const value = fields(input);
    if (tool === "edit" || tool === "write")
        return typeof value.path === "string" && value.path ? [value.path] : [];
    if (tool === "patch")
        return typeof value.patchText === "string" ? patchPaths(value.patchText) : [];
    return [];
}
/** The paths a read tool call names, as written in its input. */
export function readTargets(tool, input) {
    const value = fields(input);
    if (READ_TOOLS.has(tool))
        return typeof value.path === "string" && value.path ? [value.path] : [];
    return [];
}
/**
 * The `shell` tool call's input, or `undefined` for any other tool or a call without a
 * command. A shell-alias call reads as the `shell` call it is routed to.
 */
export function shellCall(tool, input) {
    if (!isShellTool(tool))
        return undefined;
    const value = fields(tool === SHELL_TOOL ? input : shellAliasInput(input));
    if (typeof value.command !== "string")
        return undefined;
    const call = { command: value.command };
    if (typeof value.workdir === "string" && value.workdir)
        call.workdir = value.workdir;
    if (typeof value.timeout === "number")
        call.timeout = value.timeout;
    if (typeof value.background === "boolean")
        call.background = value.background;
    return call;
}
/** The command a `shell` tool call runs, or `undefined` for any other tool. */
export function shellCommand(tool, input) {
    return shellCall(tool, input)?.command;
}
/**
 * Absolute paths a tool call would write: the targets of `edit`/`write`/`patch`, and
 * the static write targets of a `shell` command resolved against its `workdir`.
 * Relative paths resolve against `cwd`.
 */
export function writtenPaths(tool, input, cwd) {
    const shell = shellCall(tool, input);
    if (shell !== undefined)
        return shellWriteTargets(shell.command, shell.workdir ? lexicalAbs(shell.workdir, cwd) : cwd);
    return [...new Set(writeTargets(tool, input).map((path) => lexicalAbs(path, cwd)))];
}
