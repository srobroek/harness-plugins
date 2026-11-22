import path from "node:path";
export const SEGMENTS = ["global-instructions", "project-instructions", "identity", "worktree"];
/** Read-only agents keep every AGENTS.md and lose the model identity and the worktree hint. */
export const DEFAULT_DROP = ["identity", "worktree"];
/** `leanDrop` names that stand for several segments. */
const ALIASES = {
    instructions: ["global-instructions", "project-instructions"],
};
/** Read-only agents shipped in this repository, the built-in explore, and ids reserved for upcoming read-only agents. */
export const DEFAULT_LEAN_AGENTS = [
    "explore",
    "pr-reviewer",
    "adversarial-challenger",
    "code-challenger",
    "refactor-challenger",
    "design-critic",
    "a11y-auditor",
    "speckit-verify",
    "seance",
    "security-reviewer",
    "code-reviewer",
    "researcher",
    "architect",
    "speckit-sync",
    "cad-mech-reviewer",
    "cad-dfm-reviewer",
    "cad-sourcing-researcher",
];
const IDENTITY = "# Your Model\n- Name: ";
const WORKTREE = "When you create a worktree outside the current working directory and intend to use it";
const DATE = "\n\nToday's date: ";
const SEPARATOR = "\n\n";
// A section header names an absolute path or a URL. "Instructions from: " followed by
// anything else, or not opening a line after a blank one, is file content.
const HEADER = /(?:^|\n\n)Instructions from: ((?:\/|[A-Za-z]:[\\/]|https?:\/\/)[^\n]*)\n/g;
/**
 * The directories OpenCode may load the global AGENTS.md from: `OPENCODE_CONFIG_DIR`,
 * `$XDG_CONFIG_HOME/opencode` and `~/.config/opencode`.
 */
export function globalConfigDirs(env, home) {
    const dirs = [env.OPENCODE_CONFIG_DIR, env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, "opencode")];
    if (home)
        dirs.push(path.join(home, ".config", "opencode"));
    return [...new Set(dirs.filter((dir) => typeof dir === "string" && dir.length > 0))];
}
/** Whether `file` sits in one of `dirs`. */
export function isUnder(file, dirs) {
    return dirs.some((dir) => {
        const root = dir.replace(/[\\/]+$/, "");
        return file.startsWith(`${root}/`) || file.startsWith(`${root}\\`);
    });
}
/**
 * Remove the AGENTS.md sections whose path `drop` selects from an instructions part. The
 * block runs from the first section header to the date section. A part without both is
 * returned unchanged, so file content is never cut by a guess.
 */
export function dropInstructions(text, drop = () => true) {
    const headers = [...text.matchAll(HEADER)].map((match) => ({
        at: match.index + (match[0].startsWith(SEPARATOR) ? SEPARATOR.length : 0),
        file: match[1],
    }));
    const first = headers[0];
    if (first === undefined)
        return text;
    const end = text.indexOf(DATE, first.at);
    if (end === -1)
        return text;
    const inside = headers.filter((header) => header.at < end);
    const sections = inside.map((header, index) => ({
        file: header.file,
        text: text.slice(header.at, index + 1 < inside.length ? inside[index + 1].at - SEPARATOR.length : end),
    }));
    const kept = sections.filter((section) => !drop(section.file));
    if (kept.length === sections.length)
        return text;
    const before = text.slice(0, first.at);
    const after = text.slice(end);
    if (kept.length > 0)
        return before + kept.map((section) => section.text).join(SEPARATOR) + after;
    return first.at === 0 ? after.slice(SEPARATOR.length) : before.slice(0, -SEPARATOR.length) + after;
}
/**
 * The system parts with the dropped segments removed. `globalDirs` tells the global AGENTS.md
 * from the project's. Same input, same output, so the prompt cache holds.
 */
export function leanSystem(system, drop, globalDirs = []) {
    const global = drop.has("global-instructions");
    const project = drop.has("project-instructions");
    const select = (file) => (isUnder(file, globalDirs) ? global : project);
    return system.flatMap((part) => {
        if (part.type !== "text")
            return [part];
        if (drop.has("identity") && part.text.startsWith(IDENTITY))
            return [];
        if (drop.has("worktree") && part.text.startsWith(WORKTREE))
            return [];
        if (global || project) {
            const text = dropInstructions(part.text, select);
            if (text !== part.text)
                return [{ ...part, text }];
        }
        return [part];
    });
}
/**
 * `leanSubagents: false` turns the trim off; a list replaces the default agents. `leanDrop`
 * picks the segments, with `instructions` standing for both AGENTS.md segments.
 */
export function parseLeanOptions(options) {
    const agents = options.leanSubagents;
    if (agents === false)
        return undefined;
    const ids = Array.isArray(agents) ? agents.filter((id) => typeof id === "string") : DEFAULT_LEAN_AGENTS;
    const drop = Array.isArray(options.leanDrop)
        ? options.leanDrop.flatMap((name) => {
            if (typeof name !== "string")
                return [];
            if (SEGMENTS.includes(name))
                return [name];
            return ALIASES[name] ?? [];
        })
        : DEFAULT_DROP;
    if (ids.length === 0 || drop.length === 0)
        return undefined;
    return { agents: new Set(ids), drop: new Set(drop) };
}
