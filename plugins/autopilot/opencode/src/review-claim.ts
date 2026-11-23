/**
 * The once-only claim on a review. A head is reviewed by the plugin at most once, however the
 * review ends, so a verdict cannot be re-rolled by voiding or deleting a reviewer. Claims are files
 * in `<autopilot root>/review-claims/`, next to the run directories, so they outlive a run. Each is
 * created the way run state generations are: the content goes to a temporary file that is
 * hard-linked to the claim name, and `link` fails with EEXIST when the name is taken, atomically.
 * A claim is released only when the start it guarded was refused before any reviewer existed.
 */

import { randomUUID } from "node:crypto"
import { closeSync, linkSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const CLAIM_DIR = "review-claims"

/** The claim names for one start: one per PR and head, and one per head alone. */
export const claimNames = (pr: string, sha: string): string[] => [`pr-${pr}@${sha}`, `head-${sha}`]

/** A cleanup step that failed, with the original error. */
export interface CleanupFailure {
  target: string
  error: unknown
}

export type ClaimResult = { ok: true } | { ok: false; taken: string } | { ok: false; error: unknown; cleanup: readonly CleanupFailure[] }

/** The file operations the claim code uses; tests inject failures through it. */
export interface ClaimFs {
  closeSync: typeof closeSync
  linkSync: typeof linkSync
  mkdirSync: typeof mkdirSync
  openSync: typeof openSync
  rmSync: typeof rmSync
  writeFileSync: typeof writeFileSync
}

const realFs: ClaimFs = { closeSync, linkSync, mkdirSync, openSync, rmSync, writeFileSync }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** One line for a refused claim: the error and every cleanup failure. */
export function describeClaimFailure(result: { error: unknown; cleanup: readonly CleanupFailure[] }): string {
  return [messageOf(result.error), ...result.cleanup.map((failure) => `${failure.target}: ${messageOf(failure.error)}`)].join("; ")
}

/**
 * Take every claim in `names`, or none: a claim taken before a collision is released again. Never
 * throws. A temporary file is removed only when this attempt created it (a successful exclusive
 * open). When a rollback or a temporary file cannot be removed, the result is an error that keeps
 * the original errors and the start is refused, never retried; a claim that could not be released
 * stays held, so the once-only rule still holds.
 */
export function takeClaims(root: string, names: readonly string[], owner: string, fs: ClaimFs = realFs): ClaimResult {
  const dir = join(root, CLAIM_DIR)
  const held: string[] = []
  const cleanup: CleanupFailure[] = []
  const remove = (path: string, target: string): void => {
    try {
      fs.rmSync(path, { force: true })
    } catch (error) {
      cleanup.push({ target, error })
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, error, cleanup }
  }
  for (const name of names) {
    const temporary = join(dir, `.tmp-${randomUUID()}`)
    let created = false
    let failure: { error: unknown; taken?: string } | undefined
    try {
      const fd = fs.openSync(temporary, "wx")
      created = true
      try {
        fs.writeFileSync(fd, JSON.stringify({ owner, at: Date.now() }))
      } catch (error) {
        failure = { error }
      }
      try {
        fs.closeSync(fd)
      } catch (error) {
        // A close failure never replaces the primary error.
        if (failure) cleanup.push({ target: `temporary file ${temporary} not closed`, error })
        else failure = { error }
      }
      if (!failure) {
        try {
          fs.linkSync(temporary, join(dir, name))
          held.push(name)
        } catch (error) {
          failure = (error as NodeJS.ErrnoException).code === "EEXIST" ? { error, taken: name } : { error }
        }
      }
    } catch (error) {
      failure = { error }
    }
    // Only a file this attempt created is removed; an EEXIST on the exclusive open is someone else's.
    if (created) remove(temporary, `temporary file ${temporary} not removed`)
    if (failure === undefined && cleanup.length === 0) continue
    for (const claimed of held) remove(join(dir, claimed), `claim ${claimed} not released`)
    if (failure?.taken !== undefined && cleanup.length === 0) return { ok: false, taken: failure.taken }
    return { ok: false, error: failure ? failure.error : new Error("claim cleanup failed"), cleanup }
  }
  return { ok: true }
}

/** Remove claims; throws when one cannot be removed, so the caller can journal it. */
export function releaseClaims(root: string, names: readonly string[]): void {
  for (const name of names) rmSync(join(root, CLAIM_DIR, name), { force: true })
}
