/**
 * Every simple command a shell call runs, read statically from the lib's `scanShell`.
 *
 * The walk descends into command and process substitutions, `sh -c` scripts, `eval`
 * bodies, `xargs` tails and here-documents fed to a shell, so a gate sees the command
 * that actually runs rather than the text around it. Quoted arguments of any other
 * command (`echo`, `grep`, `bun -e`, a commit message) stay data. Nothing is evaluated.
 */
import { commandWords, commandWrappers, scanShell } from "@srobroek/opencode-lib";
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh"]);
const RESERVED = new Set([
    "!",
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "do",
    "done",
    "while",
    "until",
    "time",
]);
const XARGS_VALUED = new Set(["-I", "-n", "-P", "-L", "-l", "-d", "-s", "-E", "-e", "-a"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_DEPTH = 8;
export function base(word) {
    if (word === undefined)
        return "";
    return word.slice(word.lastIndexOf("/") + 1);
}
/** The source text of a word, quotes included. */
export function wordText(command, at) {
    const word = command.words?.[at];
    return word === undefined ? undefined : command.source.slice(word.start, word.end);
}
/** Whether word `at` expands a parameter or substitution (`$X`, `${X}`, `$(…)`, backticks). */
export function expandsParameter(command, at) {
    const value = command.argv[at] ?? "";
    if (!/\$[{(A-Za-z_0-9@*#?!-]|`/.test(value))
        return false;
    const word = command.words?.[at];
    return word === undefined || word.expands;
}
/** Index of the shell option word that takes the script (`-c`, `-ec`, `-xc`), or -1. */
function scriptFlag(argv) {
    for (let i = 1; i < argv.length; i++) {
        const word = argv[i];
        if (word === "--" || !word.startsWith("-"))
            return -1;
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word))
            return i;
        if (word === "-o" || word === "+o")
            i++;
    }
    return -1;
}
/** The words after an `xargs` invocation's own options. */
function xargsTail(argv) {
    let i = 1;
    while (i < argv.length) {
        const word = argv[i];
        if (word === "--")
            return argv.slice(i + 1);
        if (!word.startsWith("-"))
            break;
        if (XARGS_VALUED.has(word))
            i += 2;
        else
            i += 1;
    }
    return argv.slice(i);
}
/** Walk `source` and everything it runs. */
export function walkShell(source) {
    const commands = [];
    let complete = true;
    let pipelines = 0;
    const visit = (text, context, depth) => {
        if (depth > MAX_DEPTH) {
            complete = false;
            return;
        }
        const scan = scanShell(text);
        if (!scan.complete)
            complete = false;
        let pipeline = pipelines++;
        let stage = 0;
        for (const item of scan.items) {
            if (item.kind === "operator") {
                if (item.operator === "|" || item.operator === "|&")
                    continue;
                if (["(", ")", "{", "}"].includes(item.operator))
                    continue;
                pipeline = pipelines++;
                stage = 0;
                continue;
            }
            let start = 0;
            while (start < item.words.length && !item.words[start]?.quoted && RESERVED.has(item.words[start]?.value ?? ""))
                start++;
            const words = item.words.slice(start);
            const values = words.map((word) => word.value);
            const assignments = [];
            for (const value of values) {
                if (!ASSIGNMENT.test(value))
                    break;
                assignments.push(value);
            }
            const wrappers = commandWrappers(values);
            const { argv, directories } = commandWords(values);
            const offset = values.length - argv.length;
            const aligned = argv.every((value, i) => values[offset + i] === value) ? words.slice(offset) : undefined;
            const command = {
                argv,
                words: aligned,
                source: text,
                wrappers,
                directories,
                assignments,
                redirects: item.redirects,
                hereDocuments: item.hereDocuments,
                context,
                pipeline,
                stage: stage++,
                index: commands.length,
            };
            commands.push(command);
            if (argv.length === 0)
                continue;
            const name = base(argv[0]);
            if (SHELLS.has(name)) {
                const flag = scriptFlag(argv);
                const script = flag < 0 ? undefined : argv[flag + 1];
                if (script !== undefined)
                    visit(script, "shell", depth + 1);
                else
                    for (const document of item.hereDocuments)
                        visit(document.body, "here-document", depth + 1);
            }
            else if (name === "eval" && argv.length > 1) {
                visit(argv.slice(1).join(" "), "eval", depth + 1);
            }
            else if (name === "xargs") {
                const tail = xargsTail(argv);
                if (tail.length > 0)
                    visit(tail.map(quote).join(" "), "xargs", depth + 1);
            }
        }
        for (const substitution of scan.substitutions)
            visit(substitution, "substitution", depth + 1);
    };
    visit(source, "top", 0);
    return { commands, complete };
}
/** Single-quote a word unless it carries an expansion the inner command must still see. */
function quote(word) {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) || /[$`]/.test(word))
        return word;
    return `'${word.replaceAll("'", "'\\''")}'`;
}
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const GIT_FLAGS = new Set([
    "--no-pager",
    "-P",
    "-p",
    "--paginate",
    "--no-optional-locks",
    "--no-replace-objects",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
    "--no-advice",
    "--bare",
]);
export function gitInvocation(argv) {
    const name = base(argv[0]);
    if (name !== "git" && name !== "dgit")
        return undefined;
    const chdirs = [];
    let overridden = false;
    for (let i = 1; i < argv.length; i++) {
        const word = argv[i];
        const [flag] = word.split("=", 1);
        if (GIT_VALUED.has(flag)) {
            const value = word.includes("=") ? word.slice(flag.length + 1) : argv[++i];
            if (value === undefined)
                return undefined;
            if (flag === "-C")
                chdirs.push(value);
            if (flag === "--git-dir" || flag === "--work-tree")
                overridden = true;
            continue;
        }
        if (GIT_FLAGS.has(word))
            continue;
        if (word.startsWith("-")) {
            overridden = true;
            continue;
        }
        return { subcommand: word, args: argv.slice(i + 1), offset: i + 1, chdirs, overridden };
    }
    return undefined;
}
const WT_VALUED = new Set(["-C", "--config", "--config-set", "--format"]);
/** `wt`'s subcommand and its arguments, after the global options. */
export function wtInvocation(argv) {
    const name = base(argv[0]);
    if (name !== "wt" && name !== "worktrunk")
        return undefined;
    const chdirs = [];
    for (let i = 1; i < argv.length; i++) {
        const word = argv[i];
        const [flag] = word.split("=", 1);
        if (WT_VALUED.has(flag)) {
            const value = word.includes("=") ? word.slice(flag.length + 1) : argv[++i];
            if (flag === "-C" && value !== undefined)
                chdirs.push(value);
            continue;
        }
        if (word.startsWith("-"))
            continue;
        return { subcommand: word, args: argv.slice(i + 1), chdirs };
    }
    return undefined;
}
/** Whether a short-option cluster (`-uf`) or a long option names `letter`/`long`. */
export function hasFlag(args, letter, long) {
    for (const arg of args) {
        if (arg === "--")
            return false;
        if (arg.startsWith("--")) {
            if (long.includes(arg.split("=", 1)[0]))
                return true;
            continue;
        }
        if (letter !== undefined && /^-[A-Za-z0-9]+$/.test(arg) && arg.includes(letter))
            return true;
    }
    return false;
}
/** Arguments that are not options, stopping option parsing at `--`. Options in `valued` take the next word. */
export function positionals(args, valued = new Set()) {
    const found = [];
    let options = true;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (options && arg === "--") {
            options = false;
            continue;
        }
        if (options && arg.startsWith("-") && arg !== "-") {
            if (valued.has(arg))
                i++;
            continue;
        }
        found.push(arg);
    }
    return found;
}
