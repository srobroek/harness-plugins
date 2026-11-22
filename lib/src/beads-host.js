/**
 * The OpenCode side of the beads plugin: settings, refusal text, actor identity and
 * shell-call input. Everything else in this package is harness-neutral and imports
 * from here rather than from `@opencode/plugin`.
 */
import { isAbsolute, resolve } from "node:path";
/** Gates the plugin options can switch off: `{ gates: { "<gate>": { enabled: false } } }` or `{ gates: { "<gate>": false } }`. */
export const GATES = [
    "beads-gate-admission",
    "bead-agent-routing",
    "binary-git-hooks",
    "bd-update-close-gate",
    "bd-close-gate",
    "bd-unclaim-gate",
    "bd-actor-gate",
    "pr-bead-link-gate",
    "bd-embedded-write-lock",
    "bd-editor-gate",
    "beads-dir-pin",
    "beads-prime",
    "beads-claim-tracking",
    "beads-stop-nudge",
    "beads-claim-release",
    "bd-lease-heartbeat",
    "beads-session-advisories",
    "beads-skills",
];
/** Whether a gate is on. Every gate defaults to on; only an explicit `false` turns one off. */
export function gateEnabled(options, gate) {
    const gates = options?.gates;
    if (gates === null || typeof gates !== "object")
        return true;
    const value = gates[gate];
    if (value === false)
        return false;
    if (value !== null && typeof value === "object")
        return value.enabled !== false;
    return true;
}
/** One refusal string: the cause, what to do, and how to switch the gate off. */
export function blockReason(input) {
    return `${input.cause}; ${input.resolution}. Disable: set the srobroek.beads plugin option gates.${input.gate}.enabled=false`;
}
/** A gate refusal. Thrown from `execute.before`, so the model sees it as the tool error. */
export class GateRefusal extends Error {
    gate;
    constructor(gate, cause, resolution = "inspect the command and retry") {
        super(blockReason({ gate, cause, resolution }));
        this.name = "GateRefusal";
        this.gate = gate;
    }
}
/**
 * The run-scoped actor a subagent writes under: `opencode/<rootSessionID>/<agent>/<sessionID>`.
 * Claim tooling should match on the final session segment. A main session has none; it writes
 * under the actor its own environment or command chooses.
 */
export function agentActor(chain) {
    if (chain === undefined || chain.parentID === undefined || chain.parentID === "")
        return undefined;
    const agent = chain.agent !== undefined && chain.agent !== "" ? chain.agent : "subagent";
    return `opencode/${chain.rootID}/${agent}/${chain.sessionID}`;
}
/** Walk `parentID` to the root session. A lookup failure stops the walk where it is. */
export async function sessionChain(sessionID, agent, lookup, maxDepth = 16) {
    let parentID;
    let rootID = sessionID;
    let current = sessionID;
    for (let depth = 0; depth < maxDepth; depth++) {
        let parent;
        try {
            parent = (await lookup(current))?.parentID;
        }
        catch {
            break;
        }
        if (parent === undefined || parent === "")
            break;
        if (depth === 0)
            parentID = parent;
        rootID = parent;
        current = parent;
    }
    return { sessionID, parentID, rootID, agent };
}
/** Command and resolved working directory of a `shell` call; `workdir` is relative to the location. */
export function shellInput(input, directory) {
    if (input === null || typeof input !== "object")
        return undefined;
    const record = input;
    if (typeof record.command !== "string")
        return undefined;
    const workdir = typeof record.workdir === "string" && record.workdir !== "" ? record.workdir : undefined;
    const cwd = workdir === undefined ? directory : isAbsolute(workdir) ? workdir : resolve(directory, workdir);
    return { command: record.command, cwd };
}
