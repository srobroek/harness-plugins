/**
 * Coordination state shared by every plugin instance that works on one repository's worktrees.
 *
 * Plugins load once per location: the parent's checkout and each lane's worktree run their own
 * instance, so an in-memory lock, generation or hold coordinates nothing between them. This state
 * lives on disk, repository-scoped, next to the lane claims:
 *
 *   <common>/opencode/locks/<sha1(dir)>.lock                   one lock per worktree
 *   <common>/opencode/holds/<sha1(dir)>/<sha1(session)>.json   running background jobs, per session
 *
 * The lock is the Beads embedded write lock's protocol (`lease-lock.ts`). Everything that reads or
 * writes this state for a worktree takes that lock around the read-decide-act or the write, so
 * readers and writers are serialised.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type LeaseOptions, withLease } from "./lease-lock.ts"
import { canonicalDirectory, type Read } from "./worktree-claims.ts"

export const HOLD_EXPIRY_MS = 24 * 3_600_000

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex")
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** The lease: a hold nobody renews expires after this. */
export const LOCK_TTL_MS = 120_000

export const lockFile = (commonDir: string, directory: string) =>
  join(commonDir, "opencode", "locks", `${sha1(canonicalDirectory(directory))}.lock`)

export class LockTimeout extends Error {
  constructor(
    readonly directory: string,
    detail = "",
  ) {
    super(`could not lock ${directory}${detail === "" ? "" : ` (${detail})`}`)
    this.name = "LockTimeout"
  }
}

export type LockOptions = {
  sessionID: string
  ttlMs?: number
  renewMs?: number
  /** How long to wait for a busy lock before it counts as held. */
  waitMs?: number
  now?: () => number
  host?: string
  alive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  seams?: LeaseOptions["seams"]
}

/**
 * Run `work` holding the worktree's on-disk lock. The protocol is the Beads embedded write lock's
 * (see `lease-lock.ts`): a lease renewed on a heartbeat, takeover of abandoned holders under a
 * steal lock. Re-entrant along one async call chain. Throws {@link LockTimeout} if it cannot be taken.
 */
export async function withDiskLock<T>(commonDir: string, directory: string, options: LockOptions, work: () => Promise<T>): Promise<T> {
  const path = lockFile(commonDir, directory)
  mkdirSync(join(path, ".."), { recursive: true })
  const result = await withLease(path, {
    owner: options.sessionID,
    leaseMs: options.ttlMs ?? LOCK_TTL_MS,
    waitMs: options.waitMs ?? 30_000,
    ...(options.renewMs === undefined ? {} : { renewMs: options.renewMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.alive === undefined ? {} : { alive: options.alive }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.seams === undefined ? {} : { seams: options.seams }),
  }, work)
  if (result.kind === "done") return result.value
  throw new LockTimeout(directory, result.reason)
}

// --- holds: running background work, written by every idle gate ------------------------------

export type HoldJob = { kind: string; id: string }
export type SessionHold = { sessionID: string; directory: string; jobs: readonly HoldJob[]; updatedAt: number }

export function parseHold(value: unknown): SessionHold | undefined {
  if (!isObject(value)) return undefined
  const { sessionID, directory, jobs, updatedAt } = value
  if (typeof sessionID !== "string" || typeof directory !== "string" || typeof updatedAt !== "number" || !Array.isArray(jobs)) return undefined
  const parsed: HoldJob[] = []
  for (const job of jobs) {
    if (!isObject(job) || typeof job.kind !== "string" || typeof job.id !== "string") return undefined
    parsed.push({ kind: job.kind, id: job.id })
  }
  return { sessionID, directory, jobs: parsed, updatedAt }
}

const holdsDir = (commonDir: string, directory: string) => join(commonDir, "opencode", "holds", sha1(canonicalDirectory(directory)))
const holdFile = (commonDir: string, directory: string, sessionID: string) => join(holdsDir(commonDir, directory), `${sha1(sessionID)}.json`)

/**
 * Record (or, with no jobs, clear) what `sessionID` has running in `directory`. One file per
 * session, replaced atomically, so no two writers ever read-modify-write the same file.
 */
export function setHold(commonDir: string, directory: string, sessionID: string, jobs: readonly HoldJob[], now: number) {
  const path = holdFile(commonDir, directory, sessionID)
  if (jobs.length === 0) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(holdsDir(commonDir, directory), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify({ sessionID, directory, jobs, updatedAt: now } satisfies SessionHold))
  renameSync(temp, path)
}

const PENDING_SUFFIX = ".pending.json"

/** A hold written before its lock is taken: see {@link recordHold}. Its name ends in `.json`, so {@link readHolds} reads it as a hold. */
const pendingHoldFile = (commonDir: string, directory: string, sessionID: string) =>
  join(holdsDir(commonDir, directory), `${sha1(sessionID)}${PENDING_SUFFIX}`)

/**
 * Record (or, with no jobs, clear) what `sessionID` has running in `directory`: the way every idle gate
 * writes its hold. A remover holds the worktree's lock through its proofs and its removal, which can
 * outlast a writer's wait, and a writer that gives up must not leave running work unrecorded. So the
 * jobs are first written outside the lock as a pending hold, which every remover's {@link holdsState}
 * reads like any other hold; then the hold is written under the lock, and that write drops the
 * session's pending hold unless a later report replaced it. A writer that cannot take the lock still
 * throws, but its pending hold stays, so every remover, in every plugin instance, keeps the worktree
 * until a later write of the session succeeds or the hold expires.
 */
export async function recordHold(
  commonDir: string,
  directory: string,
  sessionID: string,
  jobs: readonly HoldJob[],
  at: number,
  lock: LockOptions,
): Promise<void> {
  const pending = pendingHoldFile(commonDir, directory, sessionID)
  if (jobs.length > 0) {
    mkdirSync(holdsDir(commonDir, directory), { recursive: true })
    const temp = `${pending}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify({ sessionID, directory, jobs, updatedAt: at } satisfies SessionHold))
    renameSync(temp, pending)
  }
  await lockedWrite(commonDir, directory, lock, () => {
    setHold(commonDir, directory, sessionID, jobs, at)
    let left: SessionHold | undefined
    try {
      left = parseHold(JSON.parse(readFileSync(pending, "utf8")))
    } catch {
      left = undefined
    }
    // A pending hold newer than this write belongs to a later report that is still waiting for the lock.
    if (left === undefined || left.updatedAt <= at) rmSync(pending, { force: true })
  })
}

/** A hold as read from disk. `pendingFile` is set for a hold written before its lock was taken ({@link recordHold}): the file to look at. */
export type ReadHold = SessionHold & { pendingFile?: string }

/** Every session's hold for `directory`. `unreadable` when the directory or any entry could not be read. */
export function readHolds(commonDir: string, directory: string): { holds: ReadHold[]; unreadable: boolean; missing?: boolean } {
  const dir = holdsDir(commonDir, directory)
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT"
    return { holds: [], unreadable: !absent, ...(absent ? { missing: true } : {}) }
  }
  const holds: ReadHold[] = []
  let unreadable = false
  for (const name of names) {
    try {
      const hold = parseHold(JSON.parse(readFileSync(join(dir, name), "utf8")))
      if (hold === undefined) unreadable = true
      else holds.push(name.endsWith(PENDING_SUFFIX) ? { ...hold, pendingFile: join(dir, name) } : hold)
    } catch {
      unreadable = true
    }
  }
  return { holds, unreadable }
}

/** A duration for a person: seconds, minutes, or hours and minutes. Pure. */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/**
 * Why background work blocks a removal, or undefined. Entries older than the expiry (a crashed host) are
 * ignored. A pending hold says so, with its age, when it is ignored and its file, because a stale one
 * (a session that ended before a later write took the lock) looks like running work otherwise. It also
 * says when deleting that file is safe: it is the only record of those jobs, and the session writes
 * the same file again when it next reports. Pure.
 */
export function holdBlock(read: { holds: readonly ReadHold[]; unreadable: boolean }, now: number, expiryMs: number = HOLD_EXPIRY_MS): string | undefined {
  if (read.unreadable) return "the background-work records cannot be read"
  const live = read.holds.find((hold) => hold.jobs.length > 0 && now - hold.updatedAt < expiryMs)
  if (live === undefined) return undefined
  const first = live.jobs[0]
  const running = `session ${live.sessionID} has ${live.jobs.length} background job(s) running (${first?.kind} ${first?.id})`
  if (live.pendingFile === undefined) return running
  const ignoredAfter = new Date(live.updatedAt + expiryMs).toISOString()
  const jobs = live.jobs.map((job) => `${job.kind} ${job.id}`).join(", ")
  return (
    `${running}; recorded before its lock was taken, ${elapsed(now - live.updatedAt)} ago; ignored after ${ignoredAfter}; ${live.pendingFile}; ` +
    `delete it only after session ${live.sessionID}'s ${live.jobs.length} job(s) (${jobs}) have finished and that session has ended`
  )
}

export type { Read }

/** Whether a session's hold for `directory` can be written right now (a real probe write, in the holds directory when it exists). */
export function holdsWritable(commonDir: string, directory: string): boolean {
  // The exact directory holds are written to, created if need be: a probe anywhere else (the
  // coordination root, say) proves nothing when `holds/` itself is read-only. Any error is unsafe.
  const dir = holdsDir(commonDir, directory)
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.probe.${randomUUID()}`)
    writeFileSync(probe, "")
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Why background work or an unusable coordination store blocks a removal of `directory`, or
 * undefined. Run before every removal, under the lock. The holds store must be writable whether or
 * not it has entries: if it is not, the gates that would record running work could not have, so
 * "no live entries" proves nothing. Expired entries are ignored; unreadable ones block.
 */
export function holdsState(commonDir: string, directory: string, now: number, expiryMs: number = HOLD_EXPIRY_MS): string | undefined {
  const read = readHolds(commonDir, directory)
  const blocked = holdBlock(read, now, expiryMs)
  if (blocked !== undefined) return blocked
  if (!holdsWritable(commonDir, directory)) return "the coordination store is not writable, so running work cannot be ruled out"
  return undefined
}

/**
 * Run `read` under the worktree's on-disk lock, the one every remover takes, so it never sees a
 * removal part-way: under the lock another remover has either not started or finished. A lock
 * that cannot be taken is a refusal, not an error; a failure inside `read` is not ours to mask.
 */
export async function lockedWorktreeRead<T>(
  commonDir: string,
  directory: string,
  lock: LockOptions,
  read: () => Promise<T>,
): Promise<{ locked: false; reason: string } | { locked: true; value: T }> {
  let entered = false
  try {
    return await withDiskLock(commonDir, directory, lock, async () => {
      entered = true
      return { locked: true as const, value: await read() }
    })
  } catch (error) {
    if (entered) throw error
    const message = error instanceof LockTimeout ? `the worktree is locked by another remover (${error.message})` : `the lock could not be taken (${error instanceof Error ? error.message : String(error)})`
    return { locked: false, reason: message }
  }
}

/**
 * The one removal boundary. Under the worktree's on-disk lock: `recheck` (claim, holds, landing
 * records and denials, the final cleanup proofs: whatever the caller must confirm last) and, only
 * if it returns no refusal, `remove` (the worktree removal and the compare-and-delete of its ref).
 * Every remover, in every plugin, goes through here, so they exclude each other on one lock name.
 * A lock that cannot be taken is a refusal, not an error.
 */
export async function lockedWorktreeRemoval<T>(
  commonDir: string,
  directory: string,
  lock: LockOptions,
  steps: { recheck: () => Promise<string | undefined>; remove: () => Promise<T> },
): Promise<{ removed: false; reason: string } | { removed: true; value: T }> {
  const outcome = await lockedWorktreeRead(commonDir, directory, lock, async () => {
    const reason = await steps.recheck()
    if (reason !== undefined) return { removed: false as const, reason }
    return { removed: true as const, value: await steps.remove() }
  })
  return outcome.locked ? outcome.value : { removed: false, reason: outcome.reason }
}

/**
 * A short write to coordination state (a hold, a landing record, a denial, a claim, a resume bump)
 * under the worktree's lock, so it cannot land between a remover's last look and its removal.
 * Re-entrant: inside a removal's own critical section it just runs.
 */
export function lockedWrite<T>(commonDir: string, directory: string, options: LockOptions, write: () => T): Promise<T> {
  return withDiskLock(commonDir, directory, { waitMs: 10_000, ...options }, async () => write())
}
