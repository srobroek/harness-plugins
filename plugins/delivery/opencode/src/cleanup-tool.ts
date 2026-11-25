/**
 * The `delivery_cleanup` tool contract every harness registers: its input and output schemas, the
 * deferral of a lane-owned worktree, and the result a call returns. The OpenCode plugin
 * (`index.ts`) and the pi extension (`pi-src/delivery-cleanup.ts`) both build their tool from here,
 * over the same `cleanupDelivery`, so an explicit call takes the same input and returns the same
 * text in either.
 */
import type { Ownership } from "@srobroek/opencode-lib/worktree-claims"
import { ownershipDeferral } from "./auto-cleanup.ts"
import type { CleanupResult } from "./cleanup.ts"

export const CLEANUP_ACTION = "delivery_cleanup"

export const CLEANUP_INPUT = {
  type: "object",
  properties: {
    receipt: {
      type: "string",
      minLength: 1,
      description: "Path to a canonical landing receipt; omit to select the newest for this repository",
    },
    pr: { type: "integer", minimum: 1, description: "PR number, which must equal the selected receipt" },
    branch: { type: "string", minLength: 1, description: "Branch, which must equal the selected receipt" },
    worktree: { type: "string", minLength: 1, description: "Worktree path, which must equal the selected receipt" },
    remote: { type: "string", minLength: 1, description: "Remote name, which must equal the selected receipt" },
    repo: { type: "string", minLength: 1, description: '"<owner>/<name>", which must equal the selected receipt\'s repo; another repository needs repoPath or worktree' },
    repoPath: { type: "string", minLength: 1, description: "Checkout of repo on this machine; cleanup then runs in that clone" },
  },
  additionalProperties: false,
} as const

export const CLEANUP_OUTPUT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    receiptPath: { type: "string" },
    branch: { type: "string" },
    worktree: { type: "string" },
    remoteBranchAbsence: { type: "string", enum: ["absent", "present", "unknown"] },
    alreadyCleaned: { type: "boolean" },
    removed: { type: "array", items: { type: "string" } },
    skipped: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
    deferred: { type: "string" },
    receipt: { type: "object" },
  },
  required: ["ok"],
} as const

/** An explicit `delivery_cleanup` was authorized but its target belongs to a lane: nothing is removed here. */
export class CleanupDeferred extends Error {
  constructor(readonly deferred: string) {
    super(deferred)
    this.name = "CleanupDeferred"
  }
}

/** The text for a worktree an owner removes later, or undefined when delivery may remove it. Pure. */
export function explicitDeferral(ownership: Ownership): string | undefined {
  const why = ownershipDeferral(ownership)
  if (why === undefined) return undefined
  return ownership.owner === "lane" ? `${why}; removed by its owner once finished` : `${why}; not removed until it can be read`
}

/** What a call returns, in the host-neutral form: the structured output, the text and the persisted metadata. */
export type CleanupToolResult = { output: Record<string, unknown>; content: string; metadata: Record<string, unknown> }

/** The persisted metadata: the output without the full receipt, which lives on disk. */
export function metadataOf(output: Record<string, unknown>): Record<string, unknown> {
  const { receipt: _receipt, ...rest } = output
  return rest
}

function cleanupOutput(result: CleanupResult): Record<string, unknown> {
  if (!result.ok) return { ok: false, reason: result.reason }
  return {
    ok: true,
    receiptPath: result.path,
    branch: result.receipt.branch.name,
    worktree: result.receipt.worktree.path ?? "",
    remoteBranchAbsence: result.remoteBranchAbsence,
    alreadyCleaned: result.alreadyCleaned,
    removed: result.report.removed,
    skipped: result.report.skipped,
    receipt: result.receipt as Record<string, unknown>,
  }
}

function cleanupText(result: CleanupResult): string {
  if (!result.ok) return `delivery_cleanup refused: ${result.reason}`
  if (result.alreadyCleaned) return `delivery_cleanup: nothing to remove. ${result.report.skipped.join("; ")}.\nreceipt: ${result.path}`
  const removed = result.report.removed.length === 0 ? "nothing" : result.report.removed.join(", ")
  const skipped = result.report.skipped.length > 0 ? `; skipped: ${result.report.skipped.join("; ")}` : ""
  return `delivery_cleanup removed ${removed}${skipped}; remote branch ${result.remoteBranchAbsence}.\nreceipt: ${result.path}`
}

/** The result of a call `cleanupDelivery` answered. Pure. */
export function cleanupToolResult(result: CleanupResult): CleanupToolResult {
  const output = cleanupOutput(result)
  return { output, content: cleanupText(result), metadata: metadataOf(output) }
}

/** The result of a call deferred to the worktree's lane owner: nothing removed, the owner does it. Pure. */
export function deferredToolResult(deferred: string): CleanupToolResult {
  const output = { ok: true, deferred }
  return { output, content: `delivery_cleanup deferred: ${deferred}`, metadata: metadataOf(output) }
}
