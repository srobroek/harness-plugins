/**
 * The command a simple command runs once its leading wrappers are dropped.
 *
 * Shared by the gates in this repository that read shell commands. Ported from
 * omp-plugins (`chezmoi/extensions/command-words.ts`).
 *
 * This is a static reading of literal words, never a shell evaluator: a wrapper
 * reached through a variable, an alias, or a function is not recognised.
 */
import { tokenizeShell } from "./shell-tokenizer.ts";
const NONE = new Set();
/** Words that run the words after their own options as the command. */
const WRAPPERS = new Map([
    [
        "sudo",
        {
            valued: new Set([
                "-C",
                "-D",
                "-g",
                "-h",
                "-p",
                "-R",
                "-r",
                "-T",
                "-t",
                "-U",
                "-u",
                "--chdir",
                "--chroot",
                "--close-from",
                "--command-timeout",
                "--group",
                "--host",
                "--other-user",
                "--prompt",
                "--role",
                "--type",
                "--user",
            ]),
            chdir: new Set(["-D", "--chdir"]),
        },
    ],
    ["doas", { valued: new Set(["-C", "-u"]) }],
    [
        "env",
        {
            valued: new Set(["-C", "-L", "-P", "-S", "-U", "-u", "--chdir", "--split-string", "--unset"]),
            chdir: new Set(["-C", "--chdir"]),
            split: new Set(["-S", "--split-string"]),
            assignments: true,
        },
    ],
    ["nice", { valued: new Set(["-n", "--adjustment"]) }],
    ["timeout", { valued: new Set(["-k", "-s", "--kill-after", "--signal"]), operands: 1 }],
    ["stdbuf", { valued: new Set(["-e", "-i", "-o", "--error", "--input", "--output"]) }],
    ["exec", { valued: new Set(["-a"]) }],
    ["command", { valued: NONE, lookup: new Set(["-V", "-v"]) }],
    ["time", { valued: new Set(["-f", "-o", "--format", "--output"]) }],
    ["nohup", { valued: NONE }],
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The valued option a word starts, `null` for a flag, or `"lookup"` for a lookup option. */
function readOption(words, at, wrapper) {
    const word = words[at];
    if (word.startsWith("--")) {
        const eq = word.indexOf("=");
        const name = eq === -1 ? word : word.slice(0, eq);
        if (!wrapper.valued.has(name))
            return null;
        return eq === -1 ? { name, value: words[at + 1], span: 2 } : { name, value: word.slice(eq + 1), span: 1 };
    }
    // A short cluster, read the way getopt does: flags until the first valued option,
    // whose value is the rest of the word or else the next word.
    for (let j = 1; j < word.length; j++) {
        const name = `-${word[j]}`;
        if (wrapper.lookup?.has(name))
            return "lookup";
        if (!wrapper.valued.has(name))
            continue;
        const attached = word.slice(j + 1);
        return attached ? { name, value: attached, span: 1 } : { name, value: words[at + 1], span: 2 };
    }
    return null;
}
/**
 * Drop the wrappers (`sudo`, `doas`, `env`, `nice`, `timeout`, `stdbuf`, `exec`,
 * `command`, `time`, `nohup`, a bare `--`) and assignment prefixes that run the
 * following words as the command, together with each wrapper's own options and
 * operands. Wrappers are matched by basename, so `/usr/bin/sudo` is one.
 */
export function commandWords(input) {
    const { argv, directories } = stripWrappers(input);
    return { argv, directories };
}
/** Basenames of the wrappers `commandWords` drops from `input`, outermost first. */
export function commandWrappers(input) {
    return stripWrappers(input).wrappers;
}
function stripWrappers(input) {
    const words = [...input];
    const directories = [];
    const wrappers = [];
    let i = 0;
    while (i < words.length) {
        const word = words[i];
        if (ASSIGNMENT.test(word) || word === "--") {
            i++;
            continue;
        }
        const wrapper = WRAPPERS.get(word.slice(word.lastIndexOf("/") + 1));
        if (wrapper === undefined)
            break;
        wrappers.push(word.slice(word.lastIndexOf("/") + 1));
        i++;
        while (i < words.length) {
            const option = words[i];
            if (option === "--") {
                i++;
                break;
            }
            if (wrapper.assignments && ASSIGNMENT.test(option)) {
                i++;
                continue;
            }
            if (!option.startsWith("-"))
                break;
            const read = readOption(words, i, wrapper);
            if (read === "lookup")
                return { argv: [], directories, wrappers };
            if (read === null) {
                i++;
                continue;
            }
            if (read.value === undefined)
                return { argv: [], directories, wrappers };
            if (wrapper.split?.has(read.name)) {
                words.splice(i, read.span, ...tokenizeShell(read.value).map((token) => token.value));
                continue;
            }
            if (wrapper.chdir?.has(read.name))
                directories.push(read.value);
            i += read.span;
        }
        i += Math.min(wrapper.operands ?? 0, words.length - i);
    }
    return { argv: words.slice(i), directories, wrappers };
}
