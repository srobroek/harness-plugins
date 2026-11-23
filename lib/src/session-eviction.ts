/**
 * Helpers for moving sessions out of a worktree that is about to go: whether a session is running,
 * and the repository's canonical checkout that idle sessions move to.
 *
 * The name is historical: the project-wide eviction (list every session, move the idle ones, refuse
 * on a running one) is gone. A remover now protects only the lane's own child and its descendants.
 */

import { basename, dirname } from "node:path"

const toMillis = (value: unknown): number | undefined => {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/** Whether the session's latest execution started and has not ended. An archived session is idle by definition. */
export function sessionRunning(session: { time?: { busy?: unknown; idle?: unknown; archived?: unknown } }): boolean {
  if (session.time?.archived !== undefined && session.time.archived !== null) return false
  const busy = toMillis(session.time?.busy)
  const idle = toMillis(session.time?.idle)
  return busy !== undefined && (idle === undefined || busy > idle)
}

/** The repository's canonical main checkout from its git common directory, or `fallback`. Pure. */
export function canonicalCheckout(commonDir: string | undefined, fallback: string): string {
  if (commonDir !== undefined && basename(commonDir) === ".git") return dirname(commonDir)
  return fallback
}
