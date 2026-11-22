/**
 * The backstop sweep's decisions. It covers what events and idle gates cannot see: a hard
 * crash or restart, a PR merged on the forge after its lead went idle, and worktrees from
 * before lanes existed. Pure: `lifecycle.ts` gathers the facts and acts on the plan.
 */
export function classifyWorktree(facts, options) {
    const result = classifyBase(facts, options);
    return facts.freeBuild === true && result.verdict !== "prune" && result.verdict !== "prune-registry" ? { ...result, freeBuild: true } : result;
}
function classifyBase(facts, options) {
    if (!facts.agentPath)
        return { verdict: "keep", reason: "not an agent worktree" };
    if (!facts.exists)
        return { verdict: "prune-registry", reason: "directory is gone" };
    if (facts.owner === "yes")
        return { verdict: "keep", reason: "a live session owns it" };
    if (facts.owner === "unknown")
        return { verdict: "keep", reason: "owner unknown" };
    if (facts.childAlive)
        return { verdict: "keep", reason: "its subagent session still exists" };
    if (facts.ageMs === undefined || facts.ageMs < options.minAgeMs)
        return { verdict: "keep", reason: "too young" };
    if (facts.dirty === undefined || facts.ahead === undefined)
        return { verdict: "keep", reason: "state unreadable" };
    if (!facts.landed) {
        if (facts.closed === true && !facts.dirty && facts.ahead > 0) {
            return { verdict: "prune", reason: "its pull request was closed without merging; the branch is kept", closedUnmerged: true };
        }
        if (facts.dirty)
            return { verdict: "quarantine", reason: "uncommitted work, not landed" };
        if (facts.unpushed)
            return { verdict: "quarantine", reason: "unpushed commits, not landed" };
        return { verdict: "keep", reason: facts.ahead > 0 ? `${facts.ahead} commits, not landed` : "no work to land" };
    }
    if (facts.dirty)
        return { verdict: "quarantine", reason: "landed but dirty" };
    return { verdict: "prune", reason: "landed and clean", deleteBranch: facts.branch !== undefined };
}
/** One entry per path, sorted, so a second run over the same facts gives the same plan. */
export function planSweep(list, options) {
    const seen = new Set();
    const plan = [];
    for (const facts of list) {
        if (seen.has(facts.path))
            continue;
        seen.add(facts.path);
        plan.push({ path: facts.path, ...(facts.branch ? { branch: facts.branch } : {}), ...classifyWorktree(facts, options) });
    }
    return plan.sort((a, b) => a.path.localeCompare(b.path));
}
export function formatPlan(plan, mode) {
    if (plan.length === 0)
        return "subagent_worktree_sweep: no worktrees to consider.";
    const lines = plan.map((entry) => `${entry.verdict.padEnd(14)} ${entry.path}${entry.branch ? ` (${entry.branch})` : ""}: ${entry.reason}${entry.freeBuild ? "; its ignored build directories can be freed" : ""}`);
    const quarantined = plan.filter((entry) => entry.verdict === "quarantine").length;
    return [`subagent_worktree_sweep (${mode}):`, ...lines, quarantined > 0 ? `${quarantined} quarantined: kept, needs a person.` : ""].filter(Boolean).join("\n");
}
