import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { commandWords } from "./command-words.ts";
import { tokenizeShell } from "./shell-tokenizer.ts";
/**
 * The files a shell command writes, read statically. Ported from omp-plugins
 * (`chezmoi/extensions/chezmoi-guard.ts`).
 *
 * Coverage is literal and static, never a shell sandbox: `>`/`>>`/`>|` redirects,
 * `tee`, `cp`/`mv` destinations, `sed -i`/`gsed -i` and `perl -i`, behind the
 * wrappers and assignment prefixes `command-words.ts` drops. Relative paths resolve
 * against a literal `cd DIR` earlier in the same command, and a wrapped command's own
 * paths against its `env -C DIR` / `sudo -D DIR`; after a non-literal directory they
 * are skipped. Here-document bodies are data; only substitutions in an unquoted body
 * count as commands.
 */
/** Separator tokens from `tokenizeShell`; `&&`/`||` arrive as two tokens each. */
const SEPARATORS = {
    ";": true,
    "&": true,
    "|": true,
    "\n": true,
    "(": true,
    ")": true,
    "$(": true,
};
/** Absolute form of `target` against `cwd`, with `~` expanded and `.`/`..` folded, without touching the filesystem. */
export function lexicalAbs(target, cwd) {
    let expanded = target.startsWith("~") ? homedir() + target.slice(1) : target;
    if (!isAbsolute(expanded))
        expanded = resolve(cwd, expanded);
    const parts = [];
    for (const segment of expanded.split(/[/\\]/)) {
        if (segment === "" || segment === ".")
            continue;
        if (segment === "..") {
            parts.pop();
            continue;
        }
        parts.push(segment);
    }
    return `/${parts.join("/")}`;
}
/** Whether `child` is `parent` or lies inside it. */
export function under(child, parent) {
    if (!parent)
        return false;
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function teePaths(args) {
    const at = args.indexOf("--");
    const options = at === -1 ? args : args.slice(0, at);
    const rest = at === -1 ? [] : args.slice(at + 1);
    return [...options.filter((arg) => !arg.startsWith("-") || arg === "-"), ...rest].filter((arg) => arg !== "-");
}
function copyTargets(args) {
    const positional = [];
    let targetDir;
    let noTargetDir = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") {
            positional.push(...args.slice(i + 1));
            break;
        }
        if (arg === "-t" || arg === "--target-directory")
            targetDir = args[++i];
        else if (arg.startsWith("--target-directory="))
            targetDir = arg.slice("--target-directory=".length);
        else if (/^-t./.test(arg))
            targetDir = arg.slice(2);
        else if (arg === "-T" || arg === "--no-target-directory")
            noTargetDir = true;
        else if (arg === "-S")
            i++;
        else if (!arg.startsWith("-") || arg === "-")
            positional.push(arg);
    }
    if (targetDir)
        return [{ path: targetDir, sources: positional, intoDir: true }];
    if (positional.length < 2)
        return [];
    const dest = positional[positional.length - 1];
    return [noTargetDir ? { path: dest } : { path: dest, sources: positional.slice(0, -1) }];
}
function sedPaths(args) {
    let inplace = false;
    let script = false;
    const paths = [];
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token === "--") {
            paths.push(...args.slice(i + 1 + (script ? 0 : 1)));
            break;
        }
        if (token === "-e" || token === "-f" || token === "--expression" || token === "--file") {
            script = true;
            i++;
        }
        else if (/^--(?:expression|file)=/.test(token) || /^-[ef].+/.test(token)) {
            script = true;
        }
        else if (/^--in-place(?:=|$)/.test(token) || /^-[a-zA-Z]*i/.test(token)) {
            inplace = true;
            if (token === "-i" && args[i + 1] === "")
                i++;
        }
        else if (!token.startsWith("-")) {
            // BSD `-i .bak` reads its suffix as a word; counting it as the script makes
            // the real script a candidate path, which only over-includes.
            if (!script)
                script = true;
            else
                paths.push(token);
        }
    }
    return inplace ? paths : [];
}
function perlPaths(args) {
    let inplace = false;
    let script = false;
    let positional = false;
    const files = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!positional && arg === "--") {
            positional = true;
            continue;
        }
        if (!positional && arg.startsWith("-") && arg.length > 1) {
            for (let j = 1; j < arg.length; j++) {
                const flag = arg[j];
                if (flag === "e" || flag === "E") {
                    script = true;
                    if (j === arg.length - 1)
                        i++;
                    break;
                }
                if (flag === "i") {
                    inplace = true;
                    break;
                }
                // These take the rest of the bundle as their argument.
                if ("MmIdDxlo0C".includes(flag))
                    break;
            }
            continue;
        }
        positional = true;
        if (!script)
            script = true;
        else
            files.push(arg);
    }
    return inplace ? files : [];
}
/** Redirect targets plus the write destinations of one simple command. */
function simpleCommandTargets(words, normalizeWords) {
    const redirects = [];
    const args = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const value = word.value;
        if (word.startsQuoted) {
            args.push(value);
            continue;
        }
        if (value.startsWith("<")) {
            // Input redirect or here-string: the next word is read, not written.
            if (value === "<" || value === "<<<")
                i++;
            continue;
        }
        const at = value.indexOf(">");
        if (at === -1) {
            args.push(value);
            continue;
        }
        const before = value.slice(0, at);
        if (before && !/^\d+$/.test(before))
            args.push(before);
        let target = value.slice(at + 1);
        if (target.startsWith(">") || target.startsWith("|"))
            target = target.slice(1);
        if (!target)
            target = words[++i]?.value ?? "";
        if (target)
            redirects.push({ path: target });
    }
    const { argv, directories } = commandWords(normalizeWords?.(args) ?? args);
    const name = basename(argv[0] ?? "");
    const rest = argv.slice(1);
    const writes = [];
    if (name === "tee")
        writes.push(...teePaths(rest).map((path) => ({ path })));
    else if (name === "cp" || name === "mv")
        writes.push(...copyTargets(rest));
    else if (name === "sed" || name === "gsed")
        writes.push(...sedPaths(rest).map((path) => ({ path })));
    else if (name === "perl")
        writes.push(...perlPaths(rest).map((path) => ({ path })));
    return { argv, directories, redirects, writes };
}
/** `$HOME`/`~` expand; any other expansion is unknowable statically. */
function literalPath(raw, cwd) {
    const path = raw.replace(/^\$\{?HOME\}?(?=\/|$)/, homedir());
    if (/[$`]/.test(path))
        return undefined;
    if (path.startsWith("~") || isAbsolute(path))
        return lexicalAbs(path, "/");
    return cwd === null ? undefined : lexicalAbs(path, cwd);
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/** The directory a `cd` word list leaves the shell in, or `null` when not literal. */
function cdTarget(args, cwd) {
    const dirs = args.filter((arg) => !/^-[LPe@]+$/.test(arg));
    if (dirs.length === 0)
        return homedir();
    const dir = dirs[0];
    if (dir === "-")
        return null;
    return literalPath(dir, cwd) ?? null;
}
/**
 * Absolute paths a shell command would write, by static reading of literal words.
 * `cd` inside `( … )` or `$( … )` applies only until the group closes.
 * `additionalWrites` adds command destinations using the effective wrapper directory.
 * `normalizeWords` removes caller-specific control prefixes before directory tracking.
 */
export function shellWriteTargets(command, cwd, additionalWrites, normalizeWords) {
    const out = [];
    let dir = cwd;
    const saved = [];
    let words = [];
    const resolveInto = (targets, from) => {
        for (const target of targets) {
            const abs = literalPath(target.path, from);
            if (abs === undefined)
                continue;
            const intoDir = target.intoDir || (target.sources && (target.path.endsWith("/") || isDirectory(abs)));
            if (intoDir && target.sources) {
                for (const source of target.sources)
                    out.push(join(abs, basename(source)));
            }
            else {
                out.push(abs);
            }
        }
    };
    const finish = () => {
        const segment = words;
        words = [];
        if (segment.length === 0)
            return;
        const { argv, directories, redirects, writes } = simpleCommandTargets(segment, normalizeWords);
        resolveInto(redirects, dir);
        if (argv[0] === "cd") {
            dir = cdTarget(argv.slice(1), dir);
            return;
        }
        let commandDir = dir;
        for (const directory of directories)
            commandDir = literalPath(directory, commandDir) ?? null;
        writes.push(...(additionalWrites?.(argv, commandDir) ?? []).map((path) => ({ path })));
        resolveInto(writes, commandDir);
    };
    for (const token of tokenizeShell(command, { hereDocumentSubstitutionsOnly: true })) {
        if (token.sawQuote || !Object.hasOwn(SEPARATORS, token.value)) {
            words.push(token);
            continue;
        }
        finish();
        if (token.value === "(" || token.value === "$(")
            saved.push(dir);
        else if (token.value === ")" && saved.length > 0)
            dir = saved.pop() ?? null;
    }
    finish();
    return [...new Set(out)];
}
