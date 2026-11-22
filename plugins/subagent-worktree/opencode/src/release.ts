/**
 * Pure rules for releasing a dead writer's hold on a worktree, so a new writer can take it over.
 *
 * A writer child whose server died mid-turn keeps looking running (`time.busy` after `time.idle`)
 * and keeps its lane and its claim on the worktree. Its parent may release it explicitly, but only on
 * positive evidence from the host that nothing of it can write again: its session is deleted. While
 * the session exists, a run, a shell or other background work it started may still be running, in
 * this server or another one, and the plugin cannot see all of them. The release then refuses and
 * asks the user to stop the session and delete it. A released child's lane and claim go to the next
 * writer spawned into the worktree, and the child is never resumed.
 */

import type { ChildState, Lane } from "./lane.ts"

export const RELEASE_PREFIX = "release/"

export function releaseKey(child: string): string {
  return `${RELEASE_PREFIX}${child}`
}

/** A released writer, stored under `release/<child>`. */
export type Release = {
  child: string
  /** The worktree it was released from (its root, canonical). */
  directory: string
  /** The session that released it: the child's parent. */
  by: string
  at: number
  /** The worktree's HEAD when it was released. */
  head: string
  reason: string
  /** The writer the worktree was handed to, once one was spawned into it. */
  to?: string
  /** The session that spawned `to`: the parent of the lane `to` takes over. Written with `to`, so a restart can finish the handover. */
  toParent?: string
}

export function parseRelease(value: unknown): Release | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  for (const key of ["child", "directory", "by", "head"]) {
    if (typeof record[key] !== "string" || record[key] === "") return undefined
  }
  if (typeof record.at !== "number" || typeof record.reason !== "string") return undefined
  if (record.to !== undefined && typeof record.to !== "string") return undefined
  if (record.toParent !== undefined && typeof record.toParent !== "string") return undefined
  return value as Release
}

/**
 * What to do with `old`, a lane whose writer was released, given its release record and the lane of the
 * writer the record names (`successor`, undefined when none is stored). A handover writes the record's `to`
 * first, then the successor's claim and lane, then deletes the old lane, so a restart can stop between any
 * two of these writes:
 * - `none`: the record names no successor; the lane is the old writer's still.
 * - `complete`: the successor has no lane yet; store `lane` for it, then delete the old lane.
 * - `drop-old`: the successor has its lane; delete the old one.
 * - `hold`: the old lane was being removed, and finishing that would remove the successor's worktree; leave it to a person.
 * Every outcome but `none` fences the old lane: nothing may remove or evict through it.
 */
export type HandoverRepair = { kind: "none" } | { kind: "complete"; lane: Lane } | { kind: "drop-old" } | { kind: "hold" }

export function repairHandover(old: Lane, record: Release | undefined, successor: Lane | undefined, now: number): HandoverRepair {
  if (record?.to === undefined || record.child !== old.child) return { kind: "none" }
  if (successor !== undefined) return { kind: "drop-old" }
  if (old.state !== "active") return { kind: "hold" }
  return { kind: "complete", lane: { ...old, child: record.to, parent: record.toParent ?? old.parent, handedOver: { from: old.child, at: now } } }
}

export type ReleaseFacts = {
  caller: string
  child: {
    state: ChildState
    /** The child's parent: its session's `parentID`, or its lane's parent when the session is deleted. */
    owner?: string
  }
  /** Work recorded as holding the worktree (for example a merge in progress), or undefined when none is. */
  holds: string | undefined
  /** The worktree's state: uncommitted changes, and commits its upstream lacks (undefined without an upstream). */
  tree: { dirty: boolean; unpushed: number | undefined } | undefined
}

export type ReleaseDecision = { release: true } | { release: false; reason: string }

/**
 * Whether a writer child may be released from its worktree. All of these must hold:
 * - the host says the child's session is deleted: an archived, idle or running session may still have
 *   a run, a shell or other background work that writes;
 * - the caller spawned it (its lane names the caller);
 * - no work is recorded as holding the worktree;
 * - the worktree has no uncommitted or untracked changes, and an upstream that has every commit.
 */
export function decideRelease(facts: ReleaseFacts): ReleaseDecision {
  const { child } = facts
  if (child.state === "unknown") return { release: false, reason: "cannot read session state; try again" }
  if (child.state !== "deleted") {
    return {
      release: false,
      reason:
        "the writer's session still exists, so a run, shell or background job of it may still write to the worktree. " +
        "Close any terminal it opened, stop it and delete its session, then release again. " +
        "Deleting a session stops its run, shell commands, background jobs and subagents in the OpenCode server that runs them",
    }
  }
  if (child.owner !== facts.caller) return { release: false, reason: "only the session that spawned the writer can release it" }
  if (facts.holds !== undefined) return { release: false, reason: `work is still running on the worktree: ${facts.holds}. Stop it or wait for it to finish` }
  const { tree } = facts
  if (tree === undefined) return { release: false, reason: "cannot read the worktree" }
  if (tree.dirty) return { release: false, reason: "the worktree has uncommitted changes; commit and push them, or discard them, first" }
  if (tree.unpushed === undefined) return { release: false, reason: "the worktree's branch has no upstream; push it (git push -u) first" }
  if (tree.unpushed > 0) {
    return { release: false, reason: `the worktree has ${tree.unpushed} commit${tree.unpushed === 1 ? "" : "s"} not pushed to its upstream; push first` }
  }
  return { release: true }
}
