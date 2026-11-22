import { DEPTHS } from "./lenses.ts";
export const COMMAND = "code-challenge";
export const SKILL = "code-challenge";
/**
 * Read `[auto] [quick|standard|deep] [target ...]`. The two keywords are recognised only at the
 * front, in either order; everything after them is the target, which may be empty.
 */
export function parseInvocation(args) {
    const words = args.trim().split(/\s+/).filter(Boolean);
    let autonomous = false;
    let depth;
    for (;;) {
        const word = words[0]?.toLowerCase();
        if (word === "auto" && !autonomous)
            autonomous = true;
        else if (depth === undefined && DEPTHS.includes(word))
            depth = word;
        else
            break;
        words.shift();
    }
    return { autonomous, depth, target: words.join(" ") };
}
/** The prompt `/code-challenge` submits: load the skill and pass the mode, depth and target on. */
export function challengePrompt(args) {
    const { autonomous, depth, target } = parseInvocation(args);
    return [
        `Load the \`${SKILL}\` skill with the skill tool and follow it.`,
        `Mode: ${autonomous ? "autonomous (ask only what INTAKE cannot infer; never post)" : "interactive"}.`,
        depth ? `Depth: ${depth}.` : "Depth: not given; INTAKE decides (default standard).",
        target ? `Target: ${target}` : "Target: not given; INTAKE asks or infers it from the branch diff.",
    ].join("\n\n");
}
