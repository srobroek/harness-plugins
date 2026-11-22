export const CONTROL_PREFIXES = new Set(["if", "then", "elif", "else", "while", "until", "do", "!"]);
export function controlWords(argv) {
    let at = 0;
    while (CONTROL_PREFIXES.has(argv[at] ?? ""))
        at++;
    return argv.slice(at);
}
function invocationSource(argv) {
    return argv.map((word) => /^[A-Za-z0-9_./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}
export function commandScripts(argv, documents = []) {
    const name = argv[0]?.split("/").pop();
    if (name === "eval")
        return [argv.slice(argv[1] === "--" ? 2 : 1).join(" ")];
    if (name === "xargs") {
        let at = 1;
        while (argv[at]?.startsWith("-")) {
            const flag = argv[at++];
            if (flag === "--")
                break;
            if (["--arg-file", "--delimiter", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"].includes(flag))
                at++;
            else if (!flag.startsWith("--")) {
                const valued = [...flag.slice(1)].findIndex((letter) => "adEILnPs".includes(letter));
                if (valued >= 0 && valued === flag.length - 2)
                    at++;
            }
        }
        return at < argv.length ? [invocationSource(argv.slice(at))] : [];
    }
    if (!["sh", "bash", "zsh", "dash", "ksh"].includes(name ?? ""))
        return [];
    let stdin = true;
    let stdinFlag = false;
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (/^-[^-]*c/.test(arg))
            return [argv[i + 1] ?? ""];
        if (/^-[^-]*[oO]$/.test(arg) || arg === "--rcfile" || arg === "--init-file") {
            i++;
            continue;
        }
        if (/^-[^-]*s/.test(arg))
            stdinFlag = true;
        if (arg === "--")
            continue;
        if (!arg.startsWith("-")) {
            stdin = stdinFlag;
            break;
        }
    }
    return stdin ? documents.map((document) => document.body) : [];
}
