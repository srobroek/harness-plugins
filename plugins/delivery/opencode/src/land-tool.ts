/**
 * The `delivery_land` tool contract every harness registers: its input and output schemas, the
 * description they share and the output a call returns. The OpenCode plugin (`index.ts`) and the pi
 * extension (`pi-src/delivery-land.ts`) both build their tool from here, over the same
 * `landPullRequest`, so a call takes the same input and returns the same result in either.
 */
import { type CleanupReport, nextAfterCleanup } from "./auto-cleanup.ts"
import { MERGE_METHODS } from "./forge-adapter.ts"
import type { LandOutcome } from "./land.ts"

export const LAND_ACTION = "delivery_land"

export const LAND_INPUT = {
  type: "object",
  properties: {
    pr: { type: ["integer", "string"], description: "PR or MR number" },
    merge_method: { type: "string", enum: [...MERGE_METHODS], description: "default squash" },
    repo: { type: "string", description: '"<owner>/<name>"; defaults to the remote URL path' },
    remote: { type: "string", description: 'Forge remote; default "origin"' },
    expectHeadSha: {
      type: "string",
      description: "The reviewed head; required to merge, optional when proving an already MERGED PR",
    },
    requireApproval: {
      type: "boolean",
      description: "Require an APPROVED review or a 'VERDICT: APPROVE' author comment for the exact head",
    },
    requireGreenChecks: { type: "boolean", description: "Require every check on the head to pass" },
    queueWaitSeconds: { type: "integer", description: "Merge queue: seconds to wait for the merge, 0-3600; default 600" },
    setupAutoDelete: { type: "boolean", description: "Enable deletion-on-merge after the landing is proved" },
    worktree: { type: "string", description: "Landed worktree for cleanup (HEAD = PR head); inferred if omitted" },
    repoPath: { type: "string", description: "Checkout of repo on this machine; needed when repo is not the session's" },
    beadId: {
      type: "string",
      description: "Bead this closes when the branch is not <omp|opencode>/agent/<bead-id>; required then on a ledger",
    },
  },
  required: ["pr"],
  additionalProperties: false,
} as const

export const LAND_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    receiptPath: { type: "string" },
    mergeSha: { type: "string" },
    pr: { type: "integer" },
    repo: { type: "string" },
    next: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
    mergeIssued: { type: "boolean" },
    queued: { type: "boolean" },
    receipt: { type: "object" },
    cleanup: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        reason: { type: "string" },
        removed: { type: "string" },
        partlyRemoved: { type: "string" },
        localRefDeleted: { type: "boolean" },
        skipped: { type: "boolean" },
        deferred: { type: "string" },
        denied: { type: "boolean" },
      },
      required: ["ok"],
    },
  },
  required: ["ok"],
} as const

/** What every harness's description says first: the refusals, the merge and its proof. */
const LAND_CONTRACT =
  "Merge a reviewed pull request at most once, prove it landed, and write one landing receipt.\n" +
  "Refuses unless expectHeadSha names the PR head (required whenever the call would merge) " +
  "and, when worktree is given, it is a worktree of the repository landed whose HEAD is that head. A repo other than the session's needs worktree or repoPath, a local clone whose remote names it. With requireApproval/requireGreenChecks it also requires an approval artifact on the PR for that exact head " +
  "and green checks before merging. Merges at most once (an already MERGED request is proved, not re-merged) with merge_method (squash by default, PR title as subject), " +
  "binds the merge to the head, re-reads it, fetches the landed commits and checks the method's commit shape, observes the remote branch, then writes the receipt. " +
  "Writes no Beads ledger: when beads.ledgerActive, run the returned next steps child-before-parent, then delivery_cleanup. "

/** What every harness's description says last: the merge queue and the safe re-run. */
const LAND_RERUNS =
  "A base branch with a GitHub merge queue is landed by enqueuing the head (never --auto): queued true means still queued, call again. " +
  "A refusal with mergeIssued true means the PR is merged: re-run with the same pr and expectHeadSha to write the receipt."

/** The tool description: the shared contract, then the host's own sentences (who is asked, how cleanup follows), then the re-run rules. */
export function landDescription(host: string): string {
  return `${LAND_CONTRACT}${host} ${LAND_RERUNS}`
}

/** The structured output of a land, with the cleanup the host ran after it, if any. */
export function landOutput(outcome: LandOutcome, cleanup?: CleanupReport) {
  if (!outcome.ok) {
    return {
      ok: false as const,
      reason: outcome.reason,
      ...(outcome.mergeIssued === true ? { mergeIssued: true } : {}),
      ...(outcome.queued === true ? { queued: true } : {}),
    }
  }
  return {
    ok: true as const,
    receiptPath: outcome.receiptPath,
    mergeSha: outcome.receipt.pr.mergeCommitOid ?? "",
    pr: outcome.receipt.pr.number,
    repo: outcome.receipt.repo.nameWithOwner,
    next: nextAfterCleanup(outcome.next, cleanup),
    ...(cleanup === undefined ? {} : { cleanup }),
    receipt: outcome.receipt as Record<string, unknown>,
  }
}
