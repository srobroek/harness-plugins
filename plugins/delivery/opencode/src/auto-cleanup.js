/** Why a lane keeps the worktree, or undefined when nobody does. Pure. */
export function ownershipDeferral(ownership) {
    if (ownership.owner === "lane")
        return "owned by subagent-worktree lane";
    if (ownership.owner === "unknown")
        return `lane claim unreadable (${ownership.reason})`;
    return undefined;
}
/** Whether landing may run cleanup now. Pure. */
export function inlineCleanupDecision(receipt, enabled, ownership = { owner: "none" }) {
    if (!enabled)
        return { run: false, reason: "autoCleanup is off" };
    const deferred = ownershipDeferral(ownership);
    if (deferred !== undefined)
        return { run: false, reason: deferred, deferred };
    if (receipt.beads.ledgerActive) {
        return {
            run: false,
            reason: "the Beads ledger is active: close the beads in next first, then delivery_cleanup can prove the closeout",
        };
    }
    return { run: true };
}
/** The clean-check refusals of `cleanup.ts`: tracked/untracked changes, an operation in progress, a stash. */
const DIRTY_GATE = /^worktree\.(?:status|operation|stash):/;
/** Fold a cleanup result into the report a land result carries. Pure. */
export function reportFromCleanup(result) {
    if (!result.ok)
        return { ok: false, reason: DIRTY_GATE.test(result.reason) ? `dirty: ${result.reason}` : result.reason };
    // The facts come from what cleanupDelivery did: nothing was removed when the worktree was already
    // gone, and the local ref survives when it was absent or had moved off the reviewed head.
    return {
        ok: true,
        ...(result.alreadyCleaned ? {} : { removed: result.receipt.worktree.path ?? "" }),
        localRefDeleted: result.localRefDeleted,
        alreadyCleaned: result.alreadyCleaned,
        kept: result.report.skipped,
    };
}
/** Run cleanup, turning any throw (a denied prompt, a host fault) into a failed report. */
export async function runInlineCleanup(run) {
    try {
        return reportFromCleanup(await run());
    }
    catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}
/** `next` after landing: the cleanup step stays only while cleanup has not finished. */
export function nextAfterCleanup(next, report) {
    return report?.ok === true ? next.filter((step) => step !== "delivery_cleanup") : [...next];
}
const NEXT_CLEANUP_LINE = "next: run delivery_cleanup to remove the worktree and the local branch.";
/**
 * The land text with the cleanup outcome. A finished cleanup replaces the "run
 * delivery_cleanup" line; a refusal appends why; a skipped run leaves the text as is.
 */
export function textAfterCleanup(text, report) {
    if (report.skipped)
        return text;
    if (report.deferred !== undefined) {
        return [...text.split("\n"), `cleanup: deferred (${report.deferred}); its owner removes it once the lane is finished and landed, or call delivery_cleanup.`].join("\n");
    }
    const lines = text.split("\n");
    if (report.ok) {
        const at = lines.indexOf(NEXT_CLEANUP_LINE);
        const kept = at >= 0 ? lines.slice(0, at) : lines;
        if (report.alreadyCleaned === true) {
            return [...kept, `cleanup: nothing to remove (${(report.kept ?? []).join("; ")}).`].join("\n");
        }
        const branch = report.localRefDeleted === false ? "" : " and its local branch";
        const left = report.kept !== undefined && report.kept.length > 0 ? `; kept: ${report.kept.join("; ")}` : "";
        const tail = left === "" ? "; nothing left to run" : "";
        return [...kept, `cleanup: removed ${report.removed}${branch}${left}${tail}.`].join("\n");
    }
    return [...lines, `cleanup: not finished (${report.reason}); the landing stands. Fix that and call delivery_cleanup.`].join("\n");
}
