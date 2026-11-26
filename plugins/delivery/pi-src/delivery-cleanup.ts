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
// The settings, the result form and the schema cast come from `./host.ts`, which `delivery_land`
// shares; only types and `getAgentDir` come from the host package.

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { ownershipOf, readClaim } from "@srobroek/opencode-lib/worktree-claims"
import { holdsState, type LockOptions, lockedWorktreeRead, lockedWorktreeRemoval } from "@srobroek/opencode-lib/worktree-locks"
import { ownershipDeferral } from "../opencode/src/auto-cleanup.ts"
import { type CleanupDeps, cleanupDelivery, type DeliveryCleanupParams } from "../opencode/src/cleanup.ts"
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
import { type GitRunner, repositoryContext } from "../opencode/src/landing-receipt.ts"
import { callGitlabHosts, schema, toToolResult } from "./host.ts"

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
  /** The user settings file whose `delivery` key may name GitLab hosts; a host passes none, so the default path is read. */
  settingsPath?: string
}

type SessionCoordination = Required<Pick<CleanupDeps, "proofSection" | "removalSection" | "authorize" | "coordinate">>

/**
 * The coordination of a cleanup in the session's repository at `cwd`. The proofs and the removal run
 * under the worktree's on-disk lock in the repository's git common directory; under it, before the
 * removal, the lane claim and the background-work records are read fresh. `authorize` prompts
 * nobody: it defers a worktree a lane owns to that owner. Another repository is refused.
 */
export function sessionCoordination(cwd: string, deps: Pick<PiCleanupDeps, "lock" | "observe" | "now"> = {}): SessionCoordination {
  const now = deps.now ?? Date.now
  const lock: LockOptions = { sessionID: LOCK_OWNER, now, ...deps.lock }
  // Observed on every use, like the OpenCode plugin's: a checkout can move between calls.
  const common = async (): Promise<string | null> => (await repositoryContext(cwd, deps.observe))?.commonDir ?? null
  return {
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
        remove: run,
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
  gitlabHosts: readonly string[] = [],
): Promise<CleanupToolResult> {
  try {
    const result = await cleanupDelivery(params, cwd, { ...deps.cleanup, gitlabHosts, signal, ...sessionCoordination(cwd, deps) })
    return cleanupToolResult(result)
  } catch (error) {
    if (error instanceof CleanupDeferred) return deferredToolResult(error.deferred)
    throw error
  }
}

/** OMP's approval tier for a tool (omp://approval-mode.md); pi ignores the key. */
export type CleanupTool = ToolDefinition & { approval: "exec" }

export function cleanupTool(deps: PiCleanupDeps = {}): CleanupTool {
  return {
    name: CLEANUP_ACTION,
    label: "Delivery: clean up a landed PR",
    description: DESCRIPTION,
    parameters: schema(CLEANUP_INPUT),
    outputSchema: schema(CLEANUP_OUTPUT),
    // It runs git, gh, glab and bd and removes a worktree, so OMP's approval mode governs it as exec.
    approval: "exec",
    execute: async (_id, params, signal, _onUpdate, ctx) =>
      toToolResult(await runCleanup(params as DeliveryCleanupParams, ctx.cwd, signal, deps, callGitlabHosts(ctx, deps.settingsPath))),
  }
}

export default function delivery(pi: ExtensionAPI): void {
  pi.registerTool(cleanupTool())
}
