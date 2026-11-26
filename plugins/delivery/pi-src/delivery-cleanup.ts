// The pi extension of delivery: one tool, `delivery_cleanup`, for an explicit call in the session's
// own repository. It runs the OpenCode plugin's `cleanupDelivery` (`opencode/src/cleanup.ts`) with
// its proofs, removal and continuation receipt, under the on-disk worktree lock every delivery
// remover and `subagent-worktree` take (`@srobroek/opencode-lib/worktree-locks`). The input
// contract and the result text come from `opencode/src/cleanup-tool.ts`, which the OpenCode tool
// uses too.
//
// There is no retry, no background or post-land cleanup and no clone registry: a receipt or
// worktree of another repository is refused. Nothing here prompts, so a session without a UI (a
// subagent) runs it the same way; OMP's approval mode decides whether to ask before the call.
//
// Only types come from the host package, so the bundle imports nothing from pi or OMP at runtime.
// OMP loads the bundle unchanged.

import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { withLease } from "@srobroek/opencode-lib/lease-lock"
import { blockWithoutSessionLookup, runningLeaseFile } from "@srobroek/opencode-lib/running-reports"
import { processAlive } from "@srobroek/opencode-lib/subprocess"
import { canonicalDirectory, ownershipOf, readClaim } from "@srobroek/opencode-lib/worktree-claims"
import { holdsState, type LockOptions, lockedWorktreeRead, lockedWorktreeRemoval } from "@srobroek/opencode-lib/worktree-locks"
import type { TSchema } from "typebox"
import { ownershipDeferral } from "../opencode/src/auto-cleanup.ts"
import { type CleanupDeps, type CleanupFailure, cleanupDelivery, type DeliveryCleanupParams, type RemovalFacts } from "../opencode/src/cleanup.ts"
import {
  CLEANUP_ACTION,
  CLEANUP_INPUT,
  CLEANUP_OUTPUT,
  CleanupDeferred,
  type CleanupToolResult,
  cleanupToolResult,
  deferredToolResult,
  explicitDeferral,
} from "../opencode/src/cleanup-tool.ts"
import { type GitRunner, receiptDirectory, repositoryContext } from "../opencode/src/landing-receipt.ts"

/** The lease owner written into the lock record. Diagnostic only: the lock is the same one every remover takes. */
const LOCK_OWNER = "delivery (pi)"

export const UNRESOLVED_COMMON =
  "worktree.held: observed the git common directory could not be resolved, expected a coordination store; nothing was removed"

/** Why a cleanup of another repository's checkout is refused. */
export function otherRepositoryReason(root: string): string {
  return `repo: observed ${JSON.stringify(root)}, a checkout of a repository other than this session's; the pi delivery_cleanup removes only worktrees of the session's own repository, so run it from a session in that repository; nothing was removed`
}

export const DESCRIPTION =
  "Remove a landed PR's worktree and local branch in this repository after proving its landing receipt.\n" +
  "Explicit calls only: no retry and no background cleanup. Recomputes the ledger classification at the canonical root, " +
  "proves the PR merged at the recorded head from the receipt's own remote, checks every receipt bead is closed with metadata.merge_sha equal to the merge (read-only bd show), " +
  "and refuses the worktree it runs from, a dirty tree or unpushed commits, a worktree a lane claims or background work holds, and a receipt or worktree of another repository. " +
  "Under the worktree lock every delivery remover takes, it then removes the worktree (git worktree remove, no force), runs git branch -d, verifies four absences and writes a continuation receipt. It asks nothing."

/**
 * Why `worktree` may not be removed right now, or undefined: a lane claims it (or its claim cannot
 * be read), or background work recorded for it is running (or its records cannot be read or
 * written). Read under the worktree lock, which every writer of these records takes too.
 */
export function removalBlock(common: string, worktree: string, now: number): string | undefined {
  return ownershipDeferral(ownershipOf(readClaim(common, worktree))) ?? holdsState(common, worktree, now)
}

/** Test seams; a host passes none. */
export type PiCleanupDeps = {
  /** Further deps for `cleanupDelivery` (a runner, a clock, bounds, the environment); never the coordination or the signal. */
  cleanup?: Omit<CleanupDeps, "signal" | "proofSection" | "removalSection" | "authorize" | "coordinate">
  /** Lock options over the defaults (for example a shorter wait). */
  lock?: Partial<LockOptions>
  /** The Git reader behind the session repository's common directory. */
  observe?: GitRunner
  now?: () => number
}

type SessionCoordination = Required<Pick<CleanupDeps, "proofSection" | "removalSection" | "finalCheck" | "authorize" | "coordinate">>

/**
 * The coordination of a cleanup in the session's repository at `cwd`. The proofs and the removal run
 * under the worktree's on-disk lock in the repository's git common directory; under it, before the
 * removal, the lane claim and the background-work records are read fresh. `authorize` prompts
 * nobody: it defers a worktree a lane owns to that owner. Another repository is refused.
 */
export function sessionCoordination(cwd: string, deps: Pick<PiCleanupDeps, "lock" | "observe" | "now" | "cleanup"> = {}): SessionCoordination {
  const now = deps.now ?? Date.now
  const lock: LockOptions = { sessionID: LOCK_OWNER, now, ...deps.lock }
  // Observed on every use, like the OpenCode plugin's: a checkout can move between calls.
  const common = async (): Promise<string | null> => (await repositoryContext(cwd, deps.observe))?.commonDir ?? null
  // The other verified spellings of the worktree (the receipt's own), handed over by the final check.
  let spellings: readonly string[] = []
  const receiptsRoot = () => receiptDirectory(deps.cleanup?.env ?? process.env)
  /**
   * What the OpenCode servers' running reports say about `worktree`, or undefined. Pi has no session
   * lookup: a job whose location cannot be established holds, and a report is live by its pid on this host.
   */
  const runningBlock = (worktree: string): string | undefined => {
    const forms = [...new Set([worktree, canonicalDirectory(worktree), ...spellings, ...spellings.map(canonicalDirectory)])]
    return blockWithoutSessionLookup(receiptsRoot(), forms, { now: now(), host: hostname(), alive: processAlive }, canonicalDirectory)
  }
  return {
    finalCheck: async (_worktree, others = []) => {
      spellings = others
      return undefined
    },
    proofSection: async (worktree, read) => {
      const dir = await common()
      if (dir === null) return { ok: false, reason: UNRESOLVED_COMMON }
      const outcome = await lockedWorktreeRead(dir, worktree, lock, read)
      if (outcome.locked) return outcome.value
      return { ok: false, reason: `worktree.held: observed ${outcome.reason}, expected no competing remover; nothing was removed` }
    },
    removalSection: async (worktree, run) => {
      const dir = await common()
      if (dir === null) return { ok: false, reason: UNRESOLVED_COMMON }
      const outcome = await lockedWorktreeRemoval(dir, worktree, lock, {
        recheck: async () => removalBlock(dir, worktree, now()),
        // Under the worktree lock, the store's lease from the last read of the reports to the end of the removal:
        // a report an OpenCode server writes meanwhile waits for it (the order is always worktree lock, then lease).
        remove: async (): Promise<CleanupFailure | RemovalFacts> => {
          mkdirSync(receiptsRoot(), { recursive: true })
          const held = await withLease(runningLeaseFile(receiptsRoot()), { owner: LOCK_OWNER, now, ...(deps.lock?.waitMs === undefined ? {} : { waitMs: deps.lock.waitMs }) }, async () => {
            const blocked = runningBlock(worktree)
            return blocked === undefined ? run() : ({ ok: false, reason: `worktree.held: observed ${blocked}, expected no running work; nothing was removed` } satisfies CleanupFailure)
          })
          if (held.kind === "failed") return { ok: false, reason: `the running-work store lease could not be taken (${held.reason}), so running work cannot be ruled out` }
          return held.value
        },
      })
      if (outcome.removed) return outcome.value
      return { ok: false, reason: `worktree.held: observed ${outcome.reason}, expected no owner, hold or competing remover; nothing was removed` }
    },
    authorize: async ({ worktree }) => {
      // An unresolved common directory is refused by the removal section that follows.
      const dir = await common()
      const deferred = dir === null ? undefined : explicitDeferral(ownershipOf(readClaim(dir, worktree)))
      if (deferred !== undefined) throw new CleanupDeferred(deferred)
    },
    coordinate: async ({ root }) => ({ ok: false, reason: otherRepositoryReason(root) }),
  }
}

/** One explicit cleanup in the session's repository at `cwd`, in the host-neutral result form. */
export async function runCleanup(
  params: DeliveryCleanupParams,
  cwd: string,
  signal: AbortSignal | undefined,
  deps: PiCleanupDeps = {},
): Promise<CleanupToolResult> {
  try {
    const result = await cleanupDelivery(params, cwd, { ...deps.cleanup, signal, ...sessionCoordination(cwd, deps) })
    return cleanupToolResult(result)
  } catch (error) {
    if (error instanceof CleanupDeferred) return deferredToolResult(error.deferred)
    throw error
  }
}

/** The host form of a result: the text as one block, the metadata as `details`, the output as `structuredContent`. */
export function toToolResult(result: CleanupToolResult): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: result.content }],
    details: result.metadata,
    structuredContent: result.output as AgentToolResult["structuredContent"],
  }
}

/** OMP's approval tier for a tool (omp://approval-mode.md); pi ignores the key. */
export type CleanupTool = ToolDefinition & { approval: "exec" }

// The schemas are the OpenCode tool's JSON Schemas; pi and OMP both take a plain JSON Schema object.
const schema = (value: object) => value as unknown as TSchema

export function cleanupTool(deps: PiCleanupDeps = {}): CleanupTool {
  return {
    name: CLEANUP_ACTION,
    label: "Delivery: clean up a landed PR",
    description: DESCRIPTION,
    parameters: schema(CLEANUP_INPUT),
    outputSchema: schema(CLEANUP_OUTPUT),
    // It runs git, gh, glab and bd and removes a worktree, so OMP's approval mode governs it as exec.
    approval: "exec",
    execute: async (_id, params, signal, _onUpdate, ctx) => toToolResult(await runCleanup(params as DeliveryCleanupParams, ctx.cwd, signal, deps)),
  }
}

export default function delivery(pi: ExtensionAPI): void {
  pi.registerTool(cleanupTool())
}
