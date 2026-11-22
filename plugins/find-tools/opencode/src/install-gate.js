/**
 * The optional install guard: a `permission.hook("evaluate")` that turns an allowed
 * shell command into a prompt when it installs third-party agent code the scan
 * found. It covers the skills CLI (`npx skills add`), the Smithery CLI
 * (`smithery mcp add`, `npx @smithery/cli install`) and download-piped-to-shell
 * installers (`curl … | sh`, `bash <(curl …)`, `sh -c "$(curl …)"`).
 *
 * This reads commands statically. It never evaluates them, so an install hidden
 * behind a variable, an alias or a script file is not seen; it is a prompt, not a
 * sandbox. A configured deny is left alone.
 */
import { commandWords } from "@srobroek/opencode-lib/command-words";
import { tokenizeShell } from "@srobroek/opencode-lib/shell-tokenizer";
const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")", "$("]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const FETCHERS = new Set(["curl", "wget", "fetch", "http", "https", "xh", "aria2c"]);
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/** Package managers whose subcommand runs a package (`pnpm dlx`, `bun x`, `npm exec`). */
const RUNNER_SUBCOMMANDS = new Map([
    ["pnpm", new Set(["dlx", "exec"])],
    ["yarn", new Set(["dlx"])],
    ["bun", new Set(["x"])],
    ["npm", new Set(["exec", "x"])],
]);
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "--registry", "--cache"]);
const SKILLS_PACKAGES = new Set(["skills", "add-skill"]);
const SKILLS_VERBS = new Set(["add", "install", "i", "update", "upgrade"]);
const SMITHERY_PACKAGES = new Set(["smithery", "@smithery/cli"]);
const SMITHERY_VERBS = new Set(["add", "install"]);
const MAX_DEPTH = 4;
export const MESSAGES = {
    "skills-cli": "find-tools: this runs the skills CLI to install a skill, which downloads and runs package code. Confirm the skill was vetted and the scope (project by default, user-wide only if asked).",
    smithery: "find-tools: this runs the Smithery CLI to add an MCP server, which downloads package code and edits client configuration. Confirm the server was vetted and the scope.",
    "pipe-to-shell": "find-tools: this pipes a downloaded script into a shell, which runs unreviewed code. Confirm the script was read and its source vetted.",
};
const base = (word) => word.slice(word.lastIndexOf("/") + 1);
/** `skills@latest` → `skills`; `@smithery/cli@1.2.0` → `@smithery/cli`. */
export function packageName(spec) {
    const at = spec.indexOf("@", 1);
    return at > 0 ? spec.slice(0, at) : spec;
}
/** The package and its arguments when `words` run a package through npx-style runners. */
function runnerPackage(words) {
    const exe = base(words[0] ?? "");
    let i = 1;
    if (!RUNNERS.has(exe)) {
        const subs = RUNNER_SUBCOMMANDS.get(exe);
        if (!subs)
            return undefined;
        while (i < words.length && words[i].startsWith("-"))
            i++;
        if (!subs.has(words[i] ?? ""))
            return undefined;
        i++;
    }
    let pkg;
    for (; i < words.length; i++) {
        const word = words[i];
        if (word === "--")
            continue;
        if (RUNNER_VALUE_FLAGS.has(word)) {
            pkg ??= words[i + 1];
            i++;
            continue;
        }
        if (word.startsWith("--package=")) {
            pkg ??= word.slice("--package=".length);
            continue;
        }
        if (word.startsWith("-"))
            continue;
        return { pkg: packageName(pkg ?? word), args: words.slice(pkg ? i : i + 1) };
    }
    return undefined;
}
function positionals(args) {
    return args.filter((arg) => !arg.startsWith("-"));
}
/** The install kind of one simple command, after wrappers (`sudo`, `env`, `timeout`). */
function simpleKind(argv) {
    const words = commandWords(argv).argv;
    const exe = base(words[0] ?? "");
    if (!exe)
        return undefined;
    const run = runnerPackage(words);
    const pkg = run?.pkg ?? exe;
    const args = run?.args ?? words.slice(1);
    const verbs = positionals(args).slice(0, 2);
    if (SKILLS_PACKAGES.has(pkg) && (pkg === "add-skill" || SKILLS_VERBS.has(verbs[0] ?? "")))
        return "skills-cli";
    if (SMITHERY_PACKAGES.has(pkg) && verbs.some((verb) => SMITHERY_VERBS.has(verb)))
        return "smithery";
    return undefined;
}
function isFetcher(argv) {
    return FETCHERS.has(base(commandWords(argv).argv[0] ?? ""));
}
/** The words after a shell's options when `argv` runs a shell. */
function shellArgs(argv) {
    const words = commandWords(argv).argv;
    return SHELLS.has(base(words[0] ?? "")) ? words.slice(1) : undefined;
}
/** A shell that reads its script from stdin: no script operand, or `-s`. */
export function readsStdin(argv) {
    const args = shellArgs(argv);
    if (!args)
        return false;
    if (args.includes("-s") || args.includes("-"))
        return true;
    return !args.some((arg) => !arg.startsWith("-")) && !args.includes("-c");
}
function segments(command) {
    const out = [];
    let words = [];
    let pipe = false;
    const tokens = tokenizeShell(command, { hereDocumentSubstitutionsOnly: true });
    const flush = (next) => {
        const segment = { words, ...(next ? { next } : {}) };
        if (pipe && out.length)
            segment.pipedFrom = out[out.length - 1];
        if (words.length)
            out.push(segment);
        words = [];
    };
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token)
            continue;
        if (token.sawQuote || !SEPARATORS.has(token.value)) {
            words.push(token.value);
            continue;
        }
        if (token.value === "|" && tokens[i + 1]?.value === "|" && !tokens[i + 1]?.sawQuote) {
            flush("||");
            pipe = false;
            i++;
            continue;
        }
        flush(token.value);
        pipe = token.value === "|";
    }
    flush();
    return out;
}
/** The install kind of a whole command line, or `undefined` when it installs nothing guarded. */
export function installKind(command, depth = 0) {
    if (depth > MAX_DEPTH || !command.trim())
        return undefined;
    const parts = segments(command);
    for (const [index, part] of parts.entries()) {
        const kind = simpleKind(part.words);
        if (kind)
            return kind;
        if (part.pipedFrom && readsStdin(part.words)) {
            for (let up = part.pipedFrom; up; up = up.pipedFrom) {
                if (isFetcher(up.words))
                    return "pipe-to-shell";
            }
        }
        // `bash <(curl …)` and `sh -c $(curl …)`: the shell's words end where a substitution that fetches begins.
        const args = shellArgs(part.words);
        const substituted = part.next === "$(" || (part.next === "(" && args?.at(-1) === "<");
        if (args && substituted && isFetcher(parts[index + 1]?.words ?? []))
            return "pipe-to-shell";
        // `sh -c '…'`: read the script operand as a command line.
        const script = args && args.indexOf("-c") >= 0 ? args[args.indexOf("-c") + 1] : undefined;
        if (script !== undefined) {
            if (/^\s*(?:\$\(|`)\s*(?:\S*\/)?(?:curl|wget)\b/.test(script))
                return "pipe-to-shell";
            const inner = installKind(script, depth + 1);
            if (inner)
                return inner;
        }
    }
    for (const match of command.matchAll(/`([^`]*)`|\$\(([^()]*)\)/g)) {
        const inner = installKind(match[1] ?? match[2] ?? "", depth + 1);
        if (inner)
            return inner;
    }
    return undefined;
}
/**
 * The install kind across a shell evaluation's resources. A compound command may
 * arrive split into several resources (`curl … | sh` as `curl …` and `sh`), so a
 * fetcher in one resource and a stdin-reading shell in another also count.
 */
export function evaluationKind(resources, metadata) {
    const commands = [...resources];
    if (typeof metadata?.command === "string")
        commands.push(metadata.command);
    for (const command of commands) {
        const kind = installKind(command);
        if (kind)
            return kind;
    }
    if (resources.length > 1) {
        const parsed = resources.map((resource) => segments(resource));
        const fetches = parsed.some((parts) => parts.some((part) => isFetcher(part.words)));
        const shell = parsed.some((parts) => parts.some((part) => readsStdin(part.words)));
        if (fetches && shell)
            return "pipe-to-shell";
    }
    return undefined;
}
/** Ask before a guarded install; leave a deny alone and keep a configured prompt's own message. */
export function guardInstall(evaluation) {
    if (evaluation.action !== "shell" || evaluation.effect === "deny")
        return;
    const kind = evaluationKind(evaluation.resources, evaluation.metadata);
    if (!kind)
        return;
    if (evaluation.effect === "ask" && evaluation.message)
        return;
    evaluation.effect = "ask";
    evaluation.message = MESSAGES[kind];
}
