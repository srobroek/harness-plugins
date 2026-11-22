/**
 * Pure rules for releasing a dead writer's hold on a worktree, so a new writer can take it over.
 *
 * The single-writer guard refuses a second writer while a writer child's latest execution looks
 * running. A child whose server died mid-turn keeps looking running (`time.busy` after `time.idle`)
 * until it runs again, so it blocks the worktree for good. Its parent may release it explicitly:
 * the plugin records the release, stops the old run, and from then on the guard ignores that child
 * in that worktree and refuses every resume of it. The next writer spawned into the worktree takes
 * the child's lane, when it had one.
 */

import type { ChildState } from "./lane.ts"

export const RELEASE_PREFIX = "release/"

export function releaseKey(child: string): string {
  return `${RELEASE_PREFIX}${child}`
}

/** How long a child that may still be running must have been quiet before it can be released. */
export const RELEASE_QUIET_MS = 10 * 60_000

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
  /** The release interrupted a run that still looked live. */
  interrupted: boolean
  /** The writer the worktree was handed to, once one was spawned into it. */
  to?: string
}

export function parseRelease(value: unknown): Release | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  for (const key of ["child", "directory", "by", "head"]) {
    if (typeof record[key] !== "string" || record[key] === "") return undefined
  }
  if (typeof record.at !== "number" || typeof record.reason !== "string" || typeof record.interrupted !== "boolean") return undefined
  if (record.to !== undefined && typeof record.to !== "string") return undefined
  return value as Release
}

/**
 * Whether a `session.context` transcript has a tool call that has not ended (streaming or running);
 * undefined when the transcript is not a list.
 */
export function hasOpenToolCall(messages: unknown): boolean | undefined {
  if (!Array.isArray(messages)) return undefined
  return messages.some((message: { type?: unknown; content?: unknown } | null) => {
    if (message?.type !== "assistant" || !Array.isArray(message.content)) return false
    return message.content.some((part: { type?: unknown; state?: { status?: unknown } } | null) => {
      const status = part?.type === "tool" ? part.state?.status : undefined
      return status === "streaming" || status === "running"
    })
  })
}

export type ReleaseFacts = {
  caller: string
  child: {
    state: ChildState
    /** The child's parent: its session's `parentID`, or its lane's parent when the session is deleted. */
    owner?: string
    busy?: number
    idle?: number
    updated?: number
  }
  /** The child's transcript has a tool call that has not ended; undefined when it cannot be read. */
  openTool: boolean | undefined
  /** The worktree's state: uncommitted changes, and commits its upstream lacks (undefined without an upstream). */
  tree: { dirty: boolean; unpushed: number | undefined } | undefined
  now: number
  quietMs: number
}

export type ReleaseDecision = { release: true; interrupt: boolean } | { release: false; reason: string }

/**
 * Whether a writer child may be released from its worktree. All of these must hold:
 * - the caller spawned it;
 * - it is gone (deleted or archived) or idle with no open tool call, or it may still be running
 *   (its last run never ended, or a tool call is open) but nothing about it changed for `quietMs`:
 *   then the release interrupts it first, so a run still live in this server cannot write again;
 * - the worktree has no uncommitted or untracked changes, and an upstream that has every commit.
 */
export function decideRelease(facts: ReleaseFacts): ReleaseDecision {
  const { child } = facts
  if (child.state === "unknown") return { release: false, reason: "cannot read session state; try again" }
  if (child.owner !== facts.caller) return { release: false, reason: "only the session that spawned the writer can release it" }
  let interrupt = false
  if (child.state !== "deleted" && child.state !== "archived") {
    if (facts.openTool === undefined) return { release: false, reason: "cannot read the tool calls of the writer; try again" }
    if (child.state === "running" || facts.openTool) {
      const last = Math.max(child.busy ?? 0, child.idle ?? 0, child.updated ?? 0)
      const quiet = facts.now - last
      if (quiet < facts.quietMs) {
        return {
          release: false,
          reason: `the writer may be still running (last activity ${Math.round(quiet / 1000)}s ago; a release needs ${Math.round(facts.quietMs / 60_000)} quiet minutes). Send it a follow-up or wait`,
        }
      }
      interrupt = true
    }
  }
  const { tree } = facts
  if (tree === undefined) return { release: false, reason: "cannot read the worktree" }
  if (tree.dirty) return { release: false, reason: "the worktree has uncommitted changes; commit and push them, or discard them, first" }
  if (tree.unpushed === undefined) return { release: false, reason: "the worktree's branch has no upstream; push it (git push -u) first" }
  if (tree.unpushed > 0) {
    return { release: false, reason: `the worktree has ${tree.unpushed} commit${tree.unpushed === 1 ? "" : "s"} not pushed to its upstream; push first` }
  }
  return { release: true, interrupt }
}
