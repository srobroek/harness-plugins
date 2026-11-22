/** The three modes this plugin ships and the options that select them. */
import { basename } from "node:path";
import { defineMode } from "@srobroek/opencode-lib/mode-reminders";
export const AGENT_IDS = ["debug", "refactor", "concept"];
export const MODES = {
    debug: defineMode({
        id: "debug",
        name: "Debug",
        purpose: "you diagnose a failure to a confirmed root cause and never fix the user's checkout. Experiments run in a scratch git worktree.",
        allowed: "the scratch worktree under `~/.local/share/opencode/worktree/` and `~/.opencode/debug/`",
        redirect: "switch to `build` to apply the fix",
    }),
    refactor: defineMode({
        id: "refactor",
        name: "Refactor",
        purpose: "you restructure code in small verified steps without changing behaviour. Tests, fixtures and snapshots are frozen.",
        allowed: "source files; never test, fixture or snapshot files",
        redirect: "switch to `build` for features, bug fixes or test changes",
    }),
    concept: defineMode({
        id: "concept",
        name: "Concept",
        purpose: "you frame problems, explore options and record a decision. You do not implement.",
        allowed: "`docs/design/`, `docs/adr/`, `docs/decisions/` and `~/.opencode/concept/`",
        redirect: "switch to `spec` or `plan`, then `build`",
    }),
};
export function parseOptions(raw) {
    const agents = (raw?.agents ?? {});
    return {
        agents: Object.fromEntries(AGENT_IDS.map((id) => [id, agents[id] !== false])),
        reminders: raw?.reminders !== false,
    };
}
/** The agent files to register for these options. */
export function selectAgents(paths, options) {
    return paths.filter((path) => options.agents[basename(path, ".md")] === true);
}
/** The modes whose agents are registered. */
export function enabledModes(options) {
    return AGENT_IDS.filter((id) => options.agents[id]).map((id) => MODES[id]);
}
