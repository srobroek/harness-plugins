/**
 * The once-only claim on a review. A head is reviewed by the plugin at most once, however the
 * review ends, so a verdict cannot be re-rolled by voiding or deleting a reviewer. Claims are files
 * in `<autopilot root>/review-claims/`, next to the run directories, so they outlive a run. Each is
 * created the way run state generations are: the content goes to a temporary file that is
 * hard-linked to the claim name, and `link` fails with EEXIST when the name is taken, atomically.
 * A claim is released only when the start it guarded was refused before any reviewer existed.
 */

import { randomUUID } from "node:crypto"
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const CLAIM_DIR = "review-claims"

/** The claim names for one start: one per PR and head, and one per head alone. */
export const claimNames = (pr: string, sha: string): string[] => [`pr-${pr}@${sha}`, `head-${sha}`]

export type ClaimResult = { ok: true } | { ok: false; taken: string } | { ok: false; error: string }

/** The file operations the claim code uses; tests inject failures through it. */
export interface ClaimFs {
  linkSync: typeof linkSync
  mkdirSync: typeof mkdirSync
  rmSync: typeof rmSync
  writeFileSync: typeof writeFileSync
}

const realFs: ClaimFs = { linkSync, mkdirSync, rmSync, writeFileSync }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Take every claim in `names`, or none: a claim taken before a collision is released again. Never
 * throws. When a rollback or a temporary file cannot be removed, the result is an error that says so
 * and the start is refused, never retried; a claim that could not be released stays held, so the
 * once-only rule still holds.
 */
export function takeClaims(root: string, names: readonly string[], owner: string, fs: ClaimFs = realFs): ClaimResult {
  const dir = join(root, CLAIM_DIR)
  const held: string[] = []
  const rollback = (): string[] => {
    const failures: string[] = []
    for (const name of held) {
      try {
        fs.rmSync(join(dir, name), { force: true })
      } catch (error) {
        failures.push(`claim ${name} not released: ${messageOf(error)}`)
      }
    }
    return failures
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
  for (const name of names) {
    const temporary = join(dir, `.tmp-${randomUUID()}`)
    let linking = false
    let outcome: { taken: string } | { error: string } | undefined
    try {
      // `wx` creates the file, so a failure partway may leave it: the cleanup below covers the write too.
      fs.writeFileSync(temporary, JSON.stringify({ owner, at: Date.now() }), { flag: "wx" })
      linking = true
      fs.linkSync(temporary, join(dir, name))
      held.push(name)
    } catch (error) {
      outcome = linking && (error as NodeJS.ErrnoException).code === "EEXIST" ? { taken: name } : { error: messageOf(error) }
    }
    const failures: string[] = []
    try {
      fs.rmSync(temporary, { force: true })
    } catch (error) {
      failures.push(`temporary file ${temporary} not removed: ${messageOf(error)}`)
    }
    if (outcome === undefined && failures.length === 0) continue
    failures.push(...rollback())
    if (outcome && "taken" in outcome && failures.length === 0) return { ok: false, taken: outcome.taken }
    const reason = outcome ? ("error" in outcome ? outcome.error : `claim ${outcome.taken} is taken`) : "cleanup failed"
    return { ok: false, error: failures.length ? `${reason}; ${failures.join("; ")}` : reason }
  }
  return { ok: true }
}

/** Remove claims; throws when one cannot be removed, so the caller can journal it. */
export function releaseClaims(root: string, names: readonly string[]): void {
  for (const name of names) rmSync(join(root, CLAIM_DIR, name), { force: true })
}
