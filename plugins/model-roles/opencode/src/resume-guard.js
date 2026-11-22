/**
 * Pure guard decision for a resumed subagent. The host keeps a resumed child on the model
 * it already runs, so a model the guard has refused since the child spawned must be
 * switched away from, not just left out of the resume.
 */
import { modelText, parseCandidate } from "./resolve.ts";
/** Keep an accepted model; otherwise switch to the tier's first accepted candidate, else refuse. */
export function resumeGuard(facts) {
    if (facts.current === undefined || facts.refused === undefined)
        return { action: "keep" };
    const allowed = facts.candidates.find((c) => c.allowed);
    if (allowed !== undefined)
        return { action: "switch", model: allowed.model };
    const spent = facts.overflowed ?? [];
    if (spent.length > 0) {
        const list = spent.map((c) => `${modelText(c.model)} (${c.limit === undefined ? "unknown limit" : `${c.limit} tokens`})`).join(", ");
        const which = spent.length === 1 ? `The only allowed candidate, ${list}, already` : `The allowed candidates, ${list}, already`;
        return {
            action: "refuse",
            reason: `This resume would run on ${modelText(facts.current)}, which the guard refuses. ${which} overflowed its context; compact the session or start a new one.\n${facts.refused}`,
        };
    }
    const where = facts.tier === undefined ? "the child has no tier to switch within" : `no candidate of tier '${facts.tier}' passes the guard`;
    return { action: "refuse", reason: `This resume would run on ${modelText(facts.current)}, which the guard refuses, and ${where}.\n${facts.refused}` };
}
/** Every model a tier lists, following `@tier` links depth-first; a link back into the chain is skipped. */
export function tierModels(roles, tier) {
    const found = [];
    const walk = (role, chain) => {
        for (const entry of roles[role] ?? []) {
            const candidate = parseCandidate(entry);
            if (candidate === undefined)
                continue;
            if (candidate.kind === "model")
                found.push(candidate.ref);
            else if (!chain.includes(candidate.role) && Object.hasOwn(roles, candidate.role))
                walk(candidate.role, [...chain, candidate.role]);
        }
    };
    if (tier !== undefined && Object.hasOwn(roles, tier))
        walk(tier, [tier]);
    return found;
}
