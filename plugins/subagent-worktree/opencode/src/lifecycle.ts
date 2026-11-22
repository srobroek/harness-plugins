/**
 * The lane lifecycle adapter: it gathers facts from git, `gh`, `wt` and the host, hands
 * them to the pure decisions in `events.ts` and `landing.ts`, and carries out
 * the answer. Four layers share it, each covering what the others miss:
 *  - lane sync on a landing (`delivery_land` / `delivery_cleanup` results),
 *  - session execution events (failed, interrupted, succeeded, idle), debounced,
 *  - `experimental.idle` gates for a child and for a lead,
 *  - a sweep, on demand.
 * On start it finishes every removal a crash or a failed move left in `removing`.
 * Every removal is a non-force host removal; nothing here deletes a remote branch.
 */

import { existsSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { canonicalCheckout, evictSessions, type SessionApi } from "@srobroek/opencode-lib/session-eviction"
import { isSessionNotFound, type LaneSessionClient, laneSessions, MAX_LANE_DEPTH, moveSessionsHome } from "@srobroek/opencode-lib/session-lanes"
import { bumpClaim, forgetNotice, landingsFor, listLandings, readClaim, readNotices, recordNotice } from "@srobroek/opencode-lib/worktree-claims"
import { holdsState, type LockOptions, lockedWrite, setHold, withDiskLock } from "@srobroek/opencode-lib/worktree-locks"
import { OPERATION_MARKERS, operationsInProgress, stashesOnBranch } from "@srobroek/opencode-lib/worktree-state"
import {
  archivedKeptNotice,
  type BackgroundJob,
  childNudge,
  failureReason,
  gateMessage,
  idleGateAction,
  isLocationNotFound,
  type LaneAction,
  type LaneEvent,
  type LaneFacts,
  type LanePolicy,
  landedDirtyNotice,
  laneBackgroundJobs,
  laneEventAction,
  noticeStillHolds,
  outcomeNotice,
  stateToken,
} from "./events.ts"
import type { Git } from "./git.ts"
import { LANDING_TOOLS, laneForLanding } from "./landing.ts"
import { childReleasesLane, childState, isRunning, type Lane, type Options } from "./lane.ts"
import { formatSweep, orderEntries, type SweepEntry, type SweepMode } from "./sweep.ts"

/** Epoch milliseconds from a number, Date or date string; undefined otherwise. */
export function toMillis(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const PROOF_TTL_MS = 5 * 60_000
/** `--limit` of the batched pull request lists; a list this long may be cut off. */
const PR_LIST_LIMIT = 200
const EVENT_TYPES = [
  "session.execution.failed",
  "session.execution.interrupted",
  "session.execution.succeeded",
  "session.idle",
  "session.execution.started",
  "session.archived",
  "session.deleted",
] as const
const PRIORITY: Record<string, number> = { idle: 0, succeeded: 1, interrupted: 2, failed: 3, archived: 4 }

/** Event types after which a lane's child is done and its worktree may go. */
const ENDS_LANE = new Set(["succeeded", "failed", "interrupted", "archived"])

/** What `finalize` is asked to do. */
export type FinalizeOptions = {
  /** Where the lane's work is proven: a ref `HEAD` must be an ancestor of (the merge target). */
  target?: string
  /** The sequence of the accepted end event: an execution that started after it keeps the lane, even before the lock is taken. */
  seq?: number
  /** When the accepted end event was seen: a resume recorded at or after it keeps the lane. */
  since?: number
  /** The worktree was removed by someone else (delivery): skip the checks and the host removal, still move the sessions and retire. */
  gone?: boolean
  /** How the lane is retired; by default `removed` for an empty lane, `merged` for a `target` proof and `landed` otherwise. */
  retireAs?: "removed" | "merged" | "landed"
  /** The caller acts on the worktree being gone: one that exists under the lock is kept, unchecked and unremoved. */
  ifGone?: boolean
}
export type Finalized =
  | { removed: true }
  | { removed: false; kept: "retired" | "running" | "dirty" | "unmerged" | "denied" | "pending" | "present" | "error"; reason: string }

type SessionLike = { id: string; parentID?: string; projectID: string; location: { directory: string }; time?: Record<string, unknown> }

export type LifecycleDeps = {
  ctx: Context
  options: Options
  git: Git
  now: () => number
  exists: (path: string) => Promise<boolean>
  lookupMs: number
  load: (child: string) => Promise<Lane | undefined>
  save: (lane: Lane) => Promise<unknown>
  scan: () => Promise<Lane[]>
  getSession: (sessionID: string) => Promise<SessionLike | undefined>
  moveHome: (lane: Lane) => Promise<void>
  removeWorktree: (projectID: string, directory: string, force: boolean) => Promise<void>
  /** Debounce for the event pass; the brief asks for about 2 s. */
  debounceMs?: number
  /** The repository's git common directory, where claims and delivery's landing records live. */
  commonDir: (directory: string) => Promise<string | undefined>
  /** Make sure the lane's claim file exists (it is the lane's protection from every other remover). */
  ensureClaim: (lane: Lane) => Promise<void>
  /** Test seam for the on-disk lock (attempts, ttl, clock, liveness). */
  lock?: Partial<LockOptions>
}

export const canonical = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Whether `path` is `root` or below it; trailing slashes on `root` are ignored. */
export function within(path: string, root: string): boolean {
  // Scan back from the end: an unanchored /\/+$/ retries at every slash and is quadratic in a long run of them.
  let end = root.length
  while (end > 0 && root.charCodeAt(end - 1) === 47) end--
  const base = root.slice(0, end)
  return path === base || path.startsWith(`${base}/`)
}

export function createLifecycle(deps: LifecycleDeps) {
  const { ctx, options, git, now, load, save } = deps
  const policy: LanePolicy = { emptyGraceMs: options.emptyGraceMs }
  const debounceMs = deps.debounceMs ?? 2000
  const projectID = (ctx.location as { project?: { id?: string } }).project?.id

  let disposed = false
  let gatesActive = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const pending = new Map<string, { type: string; seq: number; at: number; reason?: string; id?: string; timer: ReturnType<typeof setTimeout> }>()
  const lastGate = new Map<string, number>()

  /** One chain for event passes, gates and sweeps' lane writes, so a lane is never handled twice at once. */
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next
  }
  let sweepChain: Promise<unknown> = Promise.resolve()

  // --- session status ---------------------------------------------------------------------

  const withinLookup = async <T>(work: Promise<T>): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), deps.lookupMs)
    })
    try {
      return await Promise.race([work.catch(() => undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** running / finished from `session.get`; unknown when the lookup fails or times out. */
  const statusOf = async (sessionID: string): Promise<"running" | "finished" | "unknown"> => {
    const session = await withinLookup(deps.getSession(sessionID))
    if (!session) return "unknown"
    return isRunning({ busy: toMillis(session.time?.busy), idle: toMillis(session.time?.idle) }) ? "running" : "finished"
  }

  // --- open pull requests -------------------------------------------------------------------

  type OpenPrs = { at: number; branches: Set<string> }
  const openPrCache = new Map<string, OpenPrs>()

  /**
   * Branches with an open pull request, one batched `gh` read per repository, cached a few minutes. It only
   * quiets the idle gate's "unresolved lane" nudge; it proves nothing about a landing. A failed read is empty.
   */
  const openPrBranches = async (parentDir: string): Promise<Set<string>> => {
    const cached = openPrCache.get(parentDir)
    if (cached && now() - cached.at < PROOF_TTL_MS) return cached.branches
    const branches = new Set<string>()
    const result = await git.run(["gh", "pr", "list", "--state", "open", "--json", "headRefName", "--limit", String(PR_LIST_LIMIT)], { cwd: parentDir })
    if (result.code === 0) {
      try {
        const list: unknown = JSON.parse(result.stdout)
        for (const pr of Array.isArray(list) ? list : []) {
          const name = (pr as { headRefName?: unknown }).headRefName
          if (typeof name === "string") branches.add(name)
        }
      } catch {
        // an unreadable list is an empty one
      }
    }
    openPrCache.set(parentDir, { at: now(), branches })
    return branches
  }

  /** The tree holds something git status does not show: a stash on the branch or an operation in progress. */
  const busyTreeOf = async (directory: string, branch: string | undefined): Promise<string | undefined> => {
    const dir = await git.gitDir(directory)
    if (dir !== undefined) {
      const operations = operationsInProgress(OPERATION_MARKERS.map((marker) => marker.name).filter((name) => existsSync(join(dir, name))))
      if (operations.length > 0) return `a ${operations.join(", ")} is in progress`
    }
    if (branch !== undefined) {
      const stash = await git.stashSubjects(directory)
      if (stash === undefined) return "stashes could not be read"
      if (stashesOnBranch(stash, branch).length > 0) return `a stash exists on ${branch}`
    }
    return undefined
  }

  /** What delivery's landing records say about `directory`: the heads it landed, and why it must not be removed, if so. */
  const deliveryRecords = async (directory: string, parentDir: string): Promise<{ heads: string[]; block: string | undefined }> => {
    const common = await deps.commonDir(parentDir)
    if (common === undefined) return { heads: [], block: "delivery's records cannot be located" }
    const listed = listLandings(common)
    const mine = landingsFor(listed.records, directory)
    const heads = mine.map((record) => record.headRefOid)
    if (listed.unreadable) return { heads, block: "delivery's landing records cannot be read" }
    const denied = mine.find((record) => record.denied !== undefined)
    return { heads, block: denied ? "delivery cleanup was denied; an explicit delivery_cleanup re-arms it" : undefined }
  }

  /**
   * Worktrees whose running work could not be recorded: kept across passes (not per invocation) until a
   * later hold write for them succeeds. Nothing is removed from them meanwhile.
   */
  const unsafeHolds = new Map<string, string>()

  /** Why background work (from any session's idle gate) blocks removing `directory`; read fresh from disk. */
  const holdReason = async (directory: string, parentDir: string): Promise<string | undefined> => {
    const failed = unsafeHolds.get(canonical(directory))
    if (failed !== undefined) return failed
    const common = await deps.commonDir(parentDir)
    if (common === undefined) return "the background-work records cannot be located"
    return holdsState(common, directory, now())
  }

  const dirtyToken = (porcelain: string): string => (porcelain === "" ? "clean" : String(Bun.hash(porcelain)))

  /**
   * The tip reached the base branch through work of this lane: it is an ancestor of `origin/main` and was
   * not already reachable from main when the lane was created. A lane without that record (or whose tip was
   * already in main) has no work of its own, so it is empty, never landed: it fails closed.
   */
  const reachedMain = async (lane: Lane, tip: string): Promise<boolean> => {
    if (lane.mainAtCreation === undefined) return false
    if (!(await git.isAncestor(lane.directory, tip, "origin/main"))) return false
    return !(await git.isAncestor(lane.directory, tip, lane.mainAtCreation))
  }

  const laneFacts = async (
    lane: Lane,
    sessions: { child: LaneFacts["child"]; parent: LaneFacts["parent"] },
  ): Promise<LaneFacts> => {
    const base = { child: sessions.child, parent: sessions.parent, now: now() }
    if (!(await deps.exists(lane.directory))) {
      return { ...base, exists: false, ahead: undefined, dirty: undefined, dirtyToken: "gone", busyTree: undefined, tip: undefined, landed: false, openPr: false, denied: undefined }
    }
    const [status, porcelain, tip] = await Promise.all([git.status(lane.directory, lane.base), git.porcelain(lane.directory), git.head(lane.directory)])
    const busyTree = status === undefined ? undefined : await busyTreeOf(lane.directory, lane.branch)
    const records = await deliveryRecords(lane.directory, lane.parentDir)
    let landed = false
    let openPr = false
    if (status !== undefined && tip !== undefined && status.ahead > 0) {
      // A head delivery recorded as landed counts only for the commit that is still the tip.
      landed = records.heads.includes(tip) || (await reachedMain(lane, tip))
      if (!landed) openPr = (await openPrBranches(lane.parentDir)).has(lane.branch)
    }
    return {
      ...base,
      exists: true,
      ahead: status?.ahead,
      dirty: porcelain === undefined ? undefined : porcelain !== "",
      dirtyToken: dirtyToken(porcelain ?? ""),
      busyTree,
      tip,
      landed,
      openPr,
      denied: records.block,
    }
  }

  // --- one fence for every removal ----------------------------------------------------------

  const localLocks = new Map<string, Promise<unknown>>()

  /**
   * One at a time per directory, across every plugin instance of the repository: an in-process queue
   * first (cheap, fair), then the on-disk lock. A lock that cannot be taken rejects.
   */
  const withLock = async <T>(directory: string, parentDir: string, work: () => Promise<T>): Promise<T> => {
    const key = canonical(directory)
    const common = await deps.commonDir(parentDir)
    if (common === undefined) throw new Error(`subagent-worktree: no git common directory to lock ${directory}`)
    return queueLocally(key, () => withDiskLock(common, directory, { sessionID: "subagent-worktree", now, ...deps.lock }, work))
  }

  /** In-process queue per directory, in front of the disk lock. */
  const queueLocally = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const next = (localLocks.get(key) ?? Promise.resolve()).then(run, run)
    localLocks.set(key, next.catch(() => {}))
    return next
  }

  /**
   * A `subagent` call is about to resume the child of this lane: waits for a removal in flight (in
   * any instance), then runs `inside` and bumps the generation on disk, recording when, so later
   * removals abort. `inside` runs under the same lock as every removal, so it sees the lane as the
   * last removal left it (fenced, retired, or still `removing`); if it throws, or returns false
   * because it did not admit the resume for an active lane, nothing is bumped. A stamp for a resume
   * that was not admitted would fence the very recovery that has to finish first.
   */
  const noteResume = (directory: string, parentDir: string, inside?: () => Promise<boolean>) =>
    withLock(directory, parentDir, async () => {
      if (inside !== undefined && !(await inside())) return
      const common = await deps.commonDir(parentDir)
      if (common !== undefined) bumpClaim(common, directory, now())
    })

  /**
   * A new child is about to be moved into an existing worktree: `work` runs under the same lock as every removal,
   * so it waits for a removal in flight, and it is refused when the worktree is gone or a lane's removal of it is
   * unfinished. A session moved in after a removal took the lock would point at a directory about to vanish.
   */
  const spawnInto = <T>(directory: string, parentDir: string, work: () => Promise<T>): Promise<T> =>
    withLock(directory, parentDir, async () => {
      if (!(await deps.exists(directory))) throw new Error(`the worktree ${directory} no longer exists`)
      const removing = (await deps.scan()).find((lane) => lane.state === "removing" && canonical(lane.directory) === canonical(directory))
      if (removing !== undefined) throw new Error(`the worktree ${directory} is being removed (lane of ${removing.child})`)
      return work()
    })

  /** Whether `oid` is landed: delivery recorded it as this worktree's head, or the lane's own work reached origin/main. */
  const isLanded = async (lane: Lane, oid: string): Promise<boolean> => {
    const records = await deliveryRecords(lane.directory, lane.parentDir)
    return records.heads.includes(oid) || (await reachedMain(lane, oid))
  }

  // --- actions ------------------------------------------------------------------------------

  const mark = async (child: string, key: string) => {
    const lane = await load(child)
    if (!lane) return
    await save({ ...lane, notices: [...(lane.notices ?? []), key].slice(-20) })
  }

  /**
   * Claim the right to send one notice, across every plugin instance of the repository. Under the lane's
   * lock it checks that the lane is still active with its claim (a retired lane gets no notices), that the
   * key was not sent, and that the state the notice describes still holds when read fresh; a worktree that
   * is gone is repaired instead. Only then is the key recorded on disk, next to the claim.
   */
  const reserve = async (lane: Lane, key: string): Promise<"ok" | "skip"> => {
    try {
      return await withLock(lane.directory, lane.parentDir, async () => {
        const common = await deps.commonDir(lane.parentDir)
        if (common === undefined) return "skip"
        // First give back what an earlier failed send left reserved, in the same critical section.
        releaseHeld(common, lane)
        const claim = readClaim(common, lane.directory)
        const stored = await load(lane.child)
        if (claim.kind !== "present" || claim.value.sessionID !== lane.child || stored?.state !== "active") return "skip"
        const sent = readNotices(common, lane.directory)
        if (sent.kind !== "present" || sent.value.includes(key)) return "skip"
        // A child's own nudge and a failure are about a child that just stopped; the others need it known to be finished.
        const stopped = key.startsWith("child:dirty:") || key.startsWith("parent:")
        const facts = await laneFacts(stored, { child: stopped ? "finished" : await statusOf(lane.child), parent: "unknown" })
        if (!facts.exists) {
          await deps.moveHome(stored)
          await save({ ...stored, state: "removed" })
          return "skip"
        }
        if (!noticeStillHolds(key, facts)) return "skip"
        recordNotice(common, lane.directory, key)
        return "ok"
      })
    } catch (error) {
      console.error(`subagent-worktree: notice for ${lane.directory} not sent:`, error instanceof Error ? error.message : error)
      return "skip"
    }
  }

  /**
   * Keys reserved on disk whose message was not delivered and that are not given back yet, by lane directory.
   * An entry leaves only once its keys are forgotten on disk: every later reservation for the lane retries
   * first, and shutdown makes a last attempt. It lives in memory, so a crash before the release succeeds
   * leaves that one notice (same lane, head and dirty state) suppressed until the lane changes or is retired.
   */
  const unreleased = new Map<string, { lane: Lane; keys: Set<string> }>()

  /** Forget the lane's undelivered keys on disk. The caller holds the lane's lock; a failed write throws. */
  const releaseHeld = (common: string, lane: Lane) => {
    const id = canonical(lane.directory)
    const entry = unreleased.get(id)
    if (entry === undefined) return
    for (const key of [...entry.keys]) if (forgetNotice(common, lane.directory, key)) entry.keys.delete(key)
    if (entry.keys.size === 0) unreleased.delete(id)
  }

  /** Try to give back the lane's undelivered keys now; what cannot be released stays queued for a retry. */
  const flushReleases = async (lane: Lane) => {
    try {
      await withLock(lane.directory, lane.parentDir, async () => {
        const common = await deps.commonDir(lane.parentDir)
        if (common === undefined) throw new Error("no git common directory")
        releaseHeld(common, lane)
      })
    } catch (error) {
      console.error(`subagent-worktree: notice reservation for ${lane.directory} not released yet:`, error instanceof Error ? error.message : error)
    }
  }

  /** Give reserved keys back when their message could not be delivered, so a later pass sends it. */
  const release = async (lane: Lane, keys: readonly string[]) => {
    const id = canonical(lane.directory)
    const entry = unreleased.get(id) ?? { lane, keys: new Set<string>() }
    for (const key of keys) entry.keys.add(key)
    unreleased.set(id, entry)
    await flushReleases(lane)
  }

  /** One notice, sent once: reserved on disk, then delivered; recorded on the lane too. */
  const deliver = async (lane: Lane, key: string, sessionID: string, text: string) => {
    if ((await reserve(lane, key)) !== "ok") return
    if (await send(sessionID, text)) await mark(lane.child, key)
    else await release(lane, [key])
  }

  const send = async (sessionID: string, text: string): Promise<boolean> => {
    try {
      await ctx.session.synthetic({ sessionID, text } as never)
      return true
    } catch {
      return false
    }
  }

  /** Sessions a `shutdown` interruption left pending: the host resumes the turn, so the child is still running. */
  const shutdownPending = new Set<string>()

  /**
   * The order of execution events: a counter, and the counter value of each session's latest start. An end event
   * that a later start overtook is stale; a start that lands while a removal checks aborts it.
   */
  let eventSeq = 0
  const lastStart = new Map<string, number>()

  const sessionClient: LaneSessionClient = {
    list: (query) => ctx.session.list(query as never),
    move: (input) => ctx.session.move(input as never),
  }

  const keptBecause = (kept: Extract<Finalized, { removed: false }>["kept"], reason: string): Finalized => ({ removed: false, kept, reason })

  /** Synchronous: a pending shutdown resume of, or an execution start since `seq` by, any of `sessionIDs`. */
  const startedSince = (sessionIDs: readonly string[], seq: number): Finalized | undefined => {
    for (const id of sessionIDs) {
      if (shutdownPending.has(id)) return keptBecause("running", `${id} was interrupted by a shutdown and the host resumes it`)
      if ((lastStart.get(id) ?? 0) > seq) return keptBecause("running", `${id} started a new execution`)
    }
    return undefined
  }

  /** `session.get` within the lookup time: the session, `missing` when the host says it does not exist, `unknown` otherwise. */
  const lookupSession = async (sessionID: string): Promise<SessionLike | "missing" | "unknown"> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"unknown">((done) => {
      timer = setTimeout(() => done("unknown"), deps.lookupMs)
    })
    const settled = Promise.resolve()
      .then(() => ctx.session.get({ sessionID } as never))
      .then(
        (session): SessionLike | "unknown" => (typeof session === "object" && session !== null ? (session as SessionLike) : "unknown"),
        (error): "missing" | "unknown" => (isSessionNotFound(error, sessionID) ? "missing" : "unknown"),
      )
    try {
      return await Promise.race([settled, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The lane's descendants (by parent ID) that sit in the worktree, or the reason to keep it: one of them running,
   * one that cannot be read, or a listing that may have missed some. The root is `liveRefusal`'s.
   */
  const descendantRefusal = async (lane: Lane): Promise<{ ids: string[] } | Finalized> => {
    const found = await laneSessions(sessionClient, lane.child)
    if (!found.complete) return keptBecause("running", "the lane's sessions could not all be listed")
    const worktree = canonical(lane.directory)
    const ids: string[] = []
    for (const id of found.ids) {
      if (id === lane.child) continue
      const session = await lookupSession(id)
      if (session === "missing") continue
      if (session === "unknown") return keptBecause("running", `the state of ${id} cannot be read`)
      const directory = session.location?.directory
      if (typeof directory !== "string") return keptBecause("running", `the location of ${id} cannot be read`)
      if (!within(canonical(directory), worktree)) continue
      ids.push(id)
      if (toMillis(session.time?.archived) !== undefined) continue
      if (isRunning({ busy: toMillis(session.time?.busy), idle: toMillis(session.time?.idle) })) return keptBecause("running", `${id} is running in the worktree`)
    }
    return { ids }
  }

  /** The latest resume stamp on the lane record or its claim, written under the lane's lock when a resume is admitted, before its execution starts. */
  const resumeStampOf = async (lane: Lane): Promise<{ at?: number } | Finalized> => {
    const common = await deps.commonDir(lane.parentDir)
    const claim = common === undefined ? undefined : readClaim(common, lane.directory)
    if (claim?.kind === "unreadable") return keptBecause("error", `the lane's claim cannot be read: ${claim.reason}`)
    const stamps = [lane.resumedAt, claim?.kind === "present" ? claim.value.resumedAt : undefined].filter((at): at is number => at !== undefined)
    return stamps.length === 0 ? {} : { at: Math.max(...stamps) }
  }

  /** A resume stamped at or after the removal's fence (`since`) raced it and keeps the lane. */
  const resumeRefusal = async (lane: Lane, options: FinalizeOptions): Promise<Finalized | undefined> => {
    const stamp = await resumeStampOf(lane)
    if ("removed" in stamp) return stamp
    // `>=`: a resume stamped in the same millisecond as the fence cannot be ordered against it, so it keeps the lane; a later pass retries.
    if (stamp.at !== undefined && options.since !== undefined && stamp.at >= options.since) return keptBecause("running", "the child was resumed")
    return undefined
  }

  /** Whether the child may be running, read fresh: a pending shutdown resume, a resume, a start since `seq`, a background job, or a running or unknown session. */
  const liveRefusal = async (lane: Lane, options: FinalizeOptions, seq: number): Promise<Finalized | undefined> => {
    const started = startedSince([lane.child], seq)
    if (started !== undefined) return started
    const resumed = await resumeRefusal(lane, options)
    if (resumed !== undefined) return resumed
    const held = await holdReason(lane.directory, lane.parentDir)
    if (held !== undefined) return keptBecause("running", held)
    const child = await childState(ctx.session.get({ sessionID: lane.child } as never), deps.lookupMs, lane.child)
    if (child === "running" || child === "unknown") return keptBecause("running", `the child session is ${child}`)
    return undefined
  }

  const PROOF_OF: Record<NonNullable<Lane["removal"]>["retireAs"], "empty" | "merged" | "landed"> = { removed: "empty", merged: "merged", landed: "landed" }

  /**
   * The preconditions, read fresh under the lane's lock: the proof and the commit it covers, or the reason to keep
   * the worktree. A lane whose removal an earlier call recorded keeps that proof while HEAD is still the commit proven then.
   */
  const checkFinalize = async (
    lane: Lane,
    options: FinalizeOptions,
    seq: number,
    earlier: Lane["removal"],
  ): Promise<{ proof: "empty" | "merged" | "landed"; oid: string } | Finalized> => {
    const live = await liveRefusal(lane, options, seq)
    if (live !== undefined) return live
    const records = await deliveryRecords(lane.directory, lane.parentDir)
    if (records.block !== undefined) return keptBecause("denied", records.block)
    const oid = await git.head(lane.directory)
    if (oid === undefined) return keptBecause("error", "HEAD cannot be read")
    if ((await git.porcelain(lane.directory)) !== "") return keptBecause("dirty", "the tree has uncommitted changes or cannot be read")
    const busy = await busyTreeOf(lane.directory, lane.branch)
    if (busy !== undefined) return keptBecause("dirty", busy)
    if (earlier?.head === oid) return { proof: PROOF_OF[earlier.retireAs], oid }
    if (oid === lane.base) return { proof: "empty", oid }
    if (options.target !== undefined && (await git.isAncestor(lane.directory, oid, options.target))) return { proof: "merged", oid }
    if (await isLanded(lane, oid)) return { proof: "landed", oid }
    return keptBecause("unmerged", "HEAD is neither merged nor landed")
  }

  /** Why the tree no longer matches what `checkFinalize` proved: HEAD moved, or a change, stash or operation appeared. */
  const treeDrift = async (lane: Lane, proven: string | undefined): Promise<Finalized | undefined> => {
    const oid = await git.head(lane.directory)
    if (oid === undefined || oid !== proven) return keptBecause("unmerged", "HEAD moved after the checks")
    if ((await git.porcelain(lane.directory)) !== "") return keptBecause("dirty", "the tree changed after the checks")
    const busy = await busyTreeOf(lane.directory, lane.branch)
    return busy === undefined ? undefined : keptBecause("dirty", busy)
  }

  /**
   * Move one session home unless it may be running: `refusal` (decided for the lane), a running session, or a pending
   * shutdown resume or an execution start since `seq` (read synchronously, right before the move call). `pending`
   * keeps it for a later call.
   */
  const moveIfIdle = async (id: string, session: SessionLike, destination: string, seq: number, refusal?: Finalized): Promise<"moved" | "pending"> => {
    if (refusal !== undefined) {
      console.error(`subagent-worktree: ${refusal.removed ? id : refusal.reason}; ${id} is not moved yet`)
      return "pending"
    }
    if (toMillis(session.time?.archived) === undefined && isRunning({ busy: toMillis(session.time?.busy), idle: toMillis(session.time?.idle) })) {
      console.error(`subagent-worktree: ${id} is running; it is not moved yet`)
      return "pending"
    }
    const started = startedSince([id], seq)
    if (started !== undefined) {
      console.error(`subagent-worktree: ${started.removed ? id : started.reason}; it is not moved yet`)
      return "pending"
    }
    // Nothing is awaited between the look above and the move call.
    const [result] = await moveSessionsHome(sessionClient, [id], destination)
    if (result?.status !== "error") return "moved"
    console.error(`subagent-worktree: could not move ${id} to ${destination}: ${result.reason}`)
    return "pending"
  }

  /**
   * Move the lane's sessions (the child and everything it spawned that sits in the worktree, plus any an earlier call
   * could not move) to the parent's checkout, else the repository's canonical one. A descendant elsewhere (in its own
   * lane's worktree, say) stays, and so does every session that may be running (see `moveIfIdle`): running work held
   * on the worktree keeps them all, and an admitted resume keeps the child. `pending` lists the ones that failed,
   * could not be read or may be running; `incomplete` says the listing may have missed some. Either keeps the lane
   * from retiring. Runs under the lane's lock, as a resume and a hold write do.
   */
  const moveLaneSessions = async (lane: Lane, common: string | undefined, seq: number, options: FinalizeOptions, treeWasGone: boolean, earlier: readonly string[] = []) => {
    const held = await holdReason(lane.directory, lane.parentDir)
    const holds = held === undefined ? undefined : keptBecause("running", held)
    const fenced = await resumeRefusal(lane, options)
    const stamp = await resumeStampOf(lane)
    /**
     * A resume stamped at or after the fence keeps the child. When the worktree was already gone (a recovery: no
     * liveness was proven before this move), so does any admitted resume not yet settled by the child's own evidence:
     * an archive after the stamp, or an execution that started after it and then went idle. A time in the stamp's own
     * millisecond cannot be ordered against it, so it settles nothing.
     */
    const resumeOf = (session: SessionLike): Finalized | undefined => {
      if (fenced !== undefined) return fenced
      if (!treeWasGone) return undefined
      if ("removed" in stamp) return stamp
      if (stamp.at === undefined) return undefined
      const archived = toMillis(session.time?.archived)
      if (archived !== undefined && archived > stamp.at) return undefined
      const busy = toMillis(session.time?.busy)
      const idle = toMillis(session.time?.idle)
      if (busy !== undefined && idle !== undefined && busy > stamp.at && idle > busy) return undefined
      return keptBecause("running", "a resume of the child was admitted and has not finished")
    }
    const found = await laneSessions(sessionClient, lane.child)
    if (!found.complete) console.error(`subagent-worktree: the session listing of ${lane.child} is incomplete; moving the ${found.ids.length} found`)
    const destination = (await deps.exists(lane.parentDir)) ? lane.parentDir : canonicalCheckout(common, lane.parentDir)
    const pending: string[] = []
    const worktree = canonical(lane.directory)
    for (const id of new Set([...found.ids, ...earlier])) {
      // The host keeps a moved session's old location until the move, so this reads where it sits even after the removal.
      const session = await lookupSession(id)
      if (session === "missing") continue
      const directory = session === "unknown" ? undefined : session.location?.directory
      if (session === "unknown" || typeof directory !== "string") {
        pending.push(id)
        console.error(`subagent-worktree: could not read ${id}; it is not moved yet`)
        continue
      }
      // The child always belongs to the lane; a descendant only while it sits in the worktree.
      if (id !== lane.child && !within(canonical(directory), worktree) && !within(directory, lane.directory)) continue
      if ((await moveIfIdle(id, session, destination, seq, holds ?? (id === lane.child ? resumeOf(session) : undefined))) === "pending") pending.push(id)
    }
    return { pending, incomplete: !found.complete }
  }

  /**
   * The one removal path, under the lane's disk lock. Preconditions: the child is not running (a known run,
   * a pending shutdown resume and a background job all count), the tree is clean with no stash or operation,
   * and HEAD is the lane's base, merged or landed. Then: record `removing`, read liveness once more, remove the
   * worktree without force, move the lane's sessions home, retire the lane. A refusal changes nothing. Sessions
   * that could not be moved leave the lane in `removing` with their ids; a later call retries just the moves.
   * A lane found in `removing` (a crash, or those pending moves) is finished the same way.
   */
  const finalize = async (lane: Lane, options: FinalizeOptions = {}): Promise<Finalized> => {
    // The trigger's place in the event order, taken before the lock is waited for: a start seen meanwhile counts.
    const seq = options.seq ?? eventSeq
    try {
      return await withLock(lane.directory, lane.parentDir, async (): Promise<Finalized> => {
        const common = await deps.commonDir(lane.parentDir)
        const stored = await load(lane.child)
        if (stored === undefined || canonical(stored.directory) !== canonical(lane.directory) || (stored.state !== "active" && stored.state !== "removing")) {
          return keptBecause("retired", "the lane is already retired")
        }
        const earlier = stored.state === "removing" ? stored.removal : undefined
        // One read decides both: whether `ifGone` refuses, and whether the worktree is removed. Two reads would let a
        // worktree that comes back between them pass the first and reach the host removal through the second.
        const looks = options.ifGone === true || (options.gone !== true && earlier?.pending === undefined)
        const onDisk = looks && (await deps.exists(stored.directory))
        if (options.ifGone === true && onDisk) return keptBecause("present", "the worktree exists")
        // Once the host removed the worktree, a retry only moves sessions: a directory that exists again is not this removal's.
        const present = options.gone !== true && earlier?.pending === undefined && onDisk
        let proof: "empty" | "merged" | "landed" | undefined
        let head: string | undefined
        let deleteAt: string | undefined
        if (present) {
          const checked = await checkFinalize(stored, options, seq, earlier)
          if (!("proof" in checked)) return checked
          proof = checked.proof
          head = checked.oid
          // The branch goes only when it is the one checked out and still at the proven commit.
          if ((await git.branch(stored.directory)) === stored.branch && (await git.commit(stored.parentDir, `refs/heads/${stored.branch}`)) === head) deleteAt = head
        }
        const retireAs = options.retireAs ?? (proof === "merged" ? "merged" : proof === "landed" ? "landed" : proof === "empty" ? "removed" : (earlier?.retireAs ?? "removed"))
        const removal: NonNullable<Lane["removal"]> = { retireAs, ...(head === undefined ? {} : { head }), ...(earlier?.pending === undefined ? {} : { pending: earlier.pending }) }
        await save({ ...stored, state: "removing", removal })
        if (present) {
          // Every async look comes first: liveness, then the descendants and their sessions.
          const live = await liveRefusal(stored, options, seq)
          if (live !== undefined) {
            await save(stored)
            return live
          }
          // Descendants hold no claim of their own: one running in the worktree keeps it, and so does a listing that may be short.
          const descendants = await descendantRefusal(stored)
          if (!("ids" in descendants)) {
            await save(stored)
            return descendants
          }
          // The tree proof is the last async step: a commit, a change, a stash or an operation made during any await above keeps the worktree.
          const drift = await treeDrift(stored, head)
          if (drift !== undefined) {
            await save(stored)
            return drift
          }
          // The last look, synchronous and immediately before the host call: an event delivered during the awaits above is seen here.
          const late = startedSince([stored.child, ...descendants.ids], seq)
          if (late !== undefined) {
            await save(stored)
            return late
          }
          // Every other session in the checkout, whoever started it: a running one keeps the worktree, an idle one goes
          // to the canonical checkout first. The lane's own sessions move home after the removal, below, where a failed move is retried.
          const evicted = await evictSessions(ctx.session as unknown as SessionApi, {
            projectID: stored.projectID,
            directory: stored.directory,
            destination: canonicalCheckout(common, stored.parentDir),
            exclude: new Set([stored.child, ...descendants.ids]),
            // The listing is a snapshot: a session that started after it is read again and checked against the start events before it moves.
            guard: {
              fresh: async (session) => {
                const now = await lookupSession(session.id)
                if (now === "missing") return undefined
                if (now === "unknown") return `the state of ${session.id} cannot be read`
                if (toMillis(now.time?.archived) === undefined && isRunning({ busy: toMillis(now.time?.busy), idle: toMillis(now.time?.idle) })) {
                  return `${session.id} is running in the worktree`
                }
                return undefined
              },
              started: (session) => {
                const started = startedSince([session.id], seq)
                return started === undefined || started.removed ? undefined : started.reason
              },
            },
          })
          if (!evicted.ok) {
            await save(stored)
            return keptBecause("running", evicted.reason)
          }
          // The eviction awaited listings and moves: a commit or a change, a resume or a hold that landed meanwhile keeps the worktree.
          const driftAfter = await treeDrift(stored, head)
          if (driftAfter !== undefined) {
            await save(stored)
            return driftAfter
          }
          // The last look, synchronous and immediately before the host call: a start delivered during the awaits above is seen here.
          const afterEviction = (await liveRefusal(stored, options, seq)) ?? startedSince([stored.child, ...descendants.ids], seq)
          if (afterEviction !== undefined) {
            await save(stored)
            return afterEviction
          }
          try {
            await deps.removeWorktree(stored.projectID, stored.directory, false)
          } catch (error) {
            await save(stored)
            return keptBecause("error", `the host did not remove the worktree: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        await ctx.worktree.refresh({ projectID: stored.projectID } as never).catch(() => {})
        if (deleteAt !== undefined) await git.deleteBranchAt(stored.parentDir, stored.branch, deleteAt)
        const moved = await moveLaneSessions(stored, common, seq, options, !present, earlier?.pending)
        // Update only the record this removal is about: a resume may have revived the child in a fresh worktree meanwhile.
        const latest = (await load(stored.child)) ?? stored
        if (latest.state !== "removing" || canonical(latest.directory) !== canonical(stored.directory)) return { removed: true }
        if (moved.pending.length > 0 || moved.incomplete) {
          await save({ ...latest, removal: { ...removal, pending: moved.pending, incomplete: moved.incomplete } })
          return keptBecause("pending", moved.pending.length > 0 ? `sessions not moved yet: ${moved.pending.join(", ")}` : "the session listing was incomplete")
        }
        const { removal: _finished, ...rest } = latest
        await save({ ...rest, state: retireAs })
        return { removed: true }
      })
    } catch (error) {
      // A coordination or bookkeeping error keeps the lane: logged, never thrown out of a hook.
      console.error(`subagent-worktree: removal of ${lane.directory} deferred:`, error instanceof Error ? error.message : error)
      return keptBecause("error", error instanceof Error ? error.message : String(error))
    }
  }

  /** Finish every removal a crash or a failed move left in `removing` that `match` selects. Never throws. */
  const resumeRemovals = async (match: (lane: Lane) => boolean = () => true, options: FinalizeOptions = {}) => {
    // One sequence, the caller's or taken now, for every lane: a start seen while an earlier lane is finished counts for the rest.
    const fenced = { ...options, seq: options.seq ?? eventSeq }
    try {
      for (const lane of (await deps.scan()).filter((candidate) => candidate.state === "removing" && match(candidate))) await finalize(lane, fenced)
    } catch (error) {
      console.error("subagent-worktree: resuming removals failed:", error instanceof Error ? error.message : error)
    }
  }

  /**
   * A session's execution failed because its location is gone. When it is a lane's child or below one, and that
   * lane's worktree is gone from disk, its sessions go home: an active or removing lane through `finalize` (which
   * moves the child and every descendant, then retires it), a retired lane by moving just this session, and only
   * when it is not the lane's child, which a resume moves into a fresh worktree. The error alone moves nothing. `seq`
   * is the failure's place in the event order: a start after it, even one seen before the lock, keeps that session.
   */
  const rehome = async (sessionID: string, seq: number) => {
    try {
      const byChild = new Map((await deps.scan()).map((lane) => [lane.child, lane]))
      const failed = await withinLookup(deps.getSession(sessionID))
      let session = failed
      let lane: Lane | undefined
      // The nearest ancestor (or the session itself) that is a lane's child owns it.
      for (let depth = 0; depth <= MAX_LANE_DEPTH && session !== undefined && lane === undefined; depth++) {
        lane = byChild.get(session.id)
        if (lane === undefined) session = session.parentID === undefined ? undefined : await withinLookup(deps.getSession(session.parentID))
      }
      if (failed === undefined || lane === undefined || (await deps.exists(lane.directory))) return
      if (lane.state === "active" || lane.state === "removing") {
        // Gone is read again under the lock: a worktree back by then is left as it is.
        await finalize(lane, { ifGone: true, seq })
        return
      }
      if (sessionID === lane.child) return
      const owner = lane
      await withLock(owner.directory, owner.parentDir, async () => {
        // Re-read under the lock: the worktree may be back, the lane revived elsewhere, the session moved meanwhile.
        if (await deps.exists(owner.directory)) return
        const latest = await load(owner.child)
        if (latest === undefined || latest.state === "active" || latest.state === "removing" || canonical(latest.directory) !== canonical(owner.directory)) return
        const current = await lookupSession(sessionID)
        if (current === "missing" || current === "unknown") return
        const directory = current.location?.directory
        if (typeof directory !== "string" || !within(canonical(directory), canonical(owner.directory))) return
        const common = await deps.commonDir(owner.parentDir)
        const destination = (await deps.exists(owner.parentDir)) ? owner.parentDir : canonicalCheckout(common, owner.parentDir)
        const held = await holdReason(owner.directory, owner.parentDir)
        await moveIfIdle(sessionID, current, destination, seq, held === undefined ? undefined : keptBecause("running", held))
      })
    } catch (error) {
      console.error(`subagent-worktree: moving ${sessionID} out of a removed worktree failed:`, error instanceof Error ? error.message : error)
    }
  }

  /** A successful foreground `subagent` call just returned: its empty lane goes. */
  const removeForeground = async (lane: Lane, since: number): Promise<boolean> => (await finalize(lane, { since })).removed

  /** `wt merge` just merged the lane's branch into `target` and kept the checkout (`--no-remove`). */
  const removeAfterMerge = (lane: Lane, target: string, since: number): Promise<Finalized> => finalize(lane, { target, retireAs: "merged", since })

  /** What a removal decided from earlier facts must not overrun: the accepted end event, or the moment its planning began. */
  type Fence = { seq: number; since: number }

  const act = async (lane: Lane, action: LaneAction, facts: LaneFacts, event: LaneEvent, fence: Fence) => {
    if (action.action === "remove") return finalize(lane, fence)
    if (action.action === "defer" && action.quiet) {
      const quietSince = action.quiet === "start" ? facts.now : undefined
      if (lane.quietSince !== quietSince) await save({ ...((await load(lane.child)) ?? lane), ...(quietSince === undefined ? { quietSince: undefined } : { quietSince }) })
      return
    }
    if (action.action === "notifyParent") {
      const text = action.key.startsWith("landed-dirty")
        ? landedDirtyNotice(lane)
        : outcomeNotice(lane, lane.outcome?.kind ?? (event.type === "interrupted" ? "interrupted" : "failed"), lane.outcome?.reason ?? "no reason given", facts)
      await deliver(lane, action.key, lane.parent, text)
      return
    }
    if (action.action === "notifyChild") {
      // With the idle gate registered it owns this nudge (one source); keys keep either path from repeating.
      if (gatesActive && event.type !== "idle") return
      await deliver(lane, action.key, lane.child, childNudge(lane))
    }
  }

  // --- execution events ---------------------------------------------------------------------

  const TERMINAL = new Set(["succeeded", "idle", "failed", "interrupted"])

  const pass = async (sessionID: string, type: string, reason: string | undefined, eventID: string | undefined, seq: number, at: number) => {
    // The event's own sequence: a start after it keeps what a removal of it would move, through every retry.
    await resumeRemovals((lane) => lane.child === sessionID || lane.parent === sessionID, { seq })
    const lanes = await deps.scan()
    const own = lanes.find((lane) => lane.child === sessionID && lane.state === "active")
    const led = lanes.filter((lane) => lane.parent === sessionID && lane.child !== sessionID && lane.state === "active")
    if (own === undefined && led.length === 0) return
    for (const lane of [...(own ? [own] : []), ...led]) await deps.ensureClaim(lane)
    const eventType = type as LaneEvent["type"]
    let ownLane = own
    if (ownLane && (type === "failed" || type === "interrupted")) {
      const why = reason ?? "no reason given"
      // Identity of the outcome, never its time: a replayed event keeps its key, a new failure gets a new one.
      const id = eventID ?? `h${Bun.hash(`${sessionID}:${type}:${why}`)}`
      ownLane = { ...ownLane, outcome: { kind: type, at: now(), reason: why, id }, quietSince: undefined }
      await save(ownLane)
    }
    // The child's execution ended or its session went away: the one removal path decides. What it keeps for
    // dirty or unmerged work is announced below, once, by the same notices as every other pass.
    // An end that a later execution.started overtook says nothing about the child now: it removes nothing.
    const stale = type !== "archived" && (lastStart.get(sessionID) ?? 0) > seq
    let kept: Finalized | undefined
    if (ownLane && ENDS_LANE.has(type) && !stale) {
      const done = await finalize(ownLane, { seq, since: at })
      if (done.removed) ownLane = undefined
      else kept = done
    }
    if (ownLane) {
      const event: LaneEvent = { type: eventType, subject: "child" }
      const parent = await statusOf(ownLane.parent)
      const facts = await laneFacts(ownLane, { child: "finished", parent: parent === "finished" ? "idle" : parent === "running" ? "busy" : "unknown" })
      const action = laneEventAction(ownLane, facts, event, policy)
      // A landed lane with a dirty tree has its own notice (one key, sent once by `act`): the archived notice never doubles it, on this pass or a later one.
      const noticed = facts.landed && (facts.ahead ?? 0) > 0 && facts.dirty === true
      if (type === "archived" && kept && !kept.removed && (kept.kept === "dirty" || kept.kept === "unmerged") && !noticed) {
        // Once per state: the key names the head and the dirty state, never a time.
        await deliver(ownLane, `parent:archived:${facts.tip ?? "?"}:${facts.dirtyToken}`, ownLane.parent, archivedKeptNotice(ownLane, kept.reason))
      }
      await act(ownLane, action, facts, event, { seq, since: at })
    }
    // Captured before any status is read: a resume recorded after it, or an execution started after it, keeps the lane.
    const planned: Fence = { seq: eventSeq, since: now() }
    for (const lane of led) {
      const event: LaneEvent = { type: "check", subject: "parent" }
      const child = await statusOf(lane.child)
      const fresh = (await load(lane.child)) ?? lane
      // The parent's status is read now: an event does not say it is still idle after the debounce.
      const parentStatus = await statusOf(sessionID)
      const facts = await laneFacts(fresh, { child, parent: parentStatus === "finished" ? "idle" : parentStatus === "running" ? "busy" : "unknown" })
      await act(fresh, laneEventAction(fresh, facts, event, policy), facts, event, planned)
    }
  }

  const schedule = (sessionID: string, type: string, reason?: string, id?: string) => {
    if (disposed) return
    const held = pending.get(sessionID)
    if (held) {
      held.seq = eventSeq
      held.at = now()
      // succeeded + idle for one execution are one pass; the stronger outcome wins.
      if ((PRIORITY[type] ?? 0) > (PRIORITY[held.type] ?? 0)) {
        held.type = type
        if (reason !== undefined) held.reason = reason
        if (id !== undefined) held.id = id
      }
      return
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      const entry = pending.get(sessionID)
      pending.delete(sessionID)
      if (!entry || disposed) return
      void serial(() => pass(sessionID, entry.type, entry.reason, entry.id, entry.seq, entry.at)).catch((error) => console.error("subagent-worktree: lane pass failed", error))
    }, debounceMs)
    timers.add(timer)
    pending.set(sessionID, { type, seq: eventSeq, at: now(), ...(reason === undefined ? {} : { reason }), ...(id === undefined ? {} : { id }), timer })
  }

  /** Feed one server event. Cheap: it only schedules. */
  const handleEvent = (raw: unknown) => {
    const event = raw as { id?: unknown; type?: string; data?: { sessionID?: unknown; error?: unknown; reason?: unknown } }
    const eventID = typeof event.id === "string" ? event.id : undefined
    const sessionID = event.data?.sessionID
    if (typeof sessionID !== "string") return
    // A new execution, or any end other than a shutdown, settles whether the host resumes the turn.
    if (event.type !== "session.idle") shutdownPending.delete(sessionID)
    eventSeq++
    switch (event.type) {
      case "session.execution.started":
        lastStart.set(sessionID, eventSeq)
        return
      case "session.archived":
      case "session.deleted":
        return schedule(sessionID, "archived")
      case "session.execution.failed":
        if (!disposed && isLocationNotFound(event.data?.error)) {
          const seq = eventSeq
          void serial(() => rehome(sessionID, seq))
        }
        return schedule(sessionID, "failed", failureReason(event.data?.error), eventID)
      case "session.execution.interrupted": {
        const reason = typeof event.data?.reason === "string" ? event.data.reason : "interrupted"
        // The host keeps the execution claim and resumes the turn: nothing ended, nothing to do.
        if (reason === "shutdown") {
          shutdownPending.add(sessionID)
          return
        }
        return schedule(sessionID, "interrupted", reason, eventID)
      }
      case "session.execution.succeeded":
        return schedule(sessionID, "succeeded")
      case "session.idle":
        return schedule(sessionID, "idle")
    }
  }

  // --- idle gates ---------------------------------------------------------------------------

  type IdleInput = { sessionID: string; background?: ReadonlyArray<BackgroundJob> }

  /** Whether `sessionID` descends from `ancestor`: true, false, or undefined when a lookup failed. */
  const descends = async (sessionID: string, ancestor: string): Promise<boolean | undefined> => {
    let current: string | undefined = sessionID
    for (let depth = 0; depth < 8 && current !== undefined; depth++) {
      if (current === ancestor) return depth > 0
      const session: SessionLike | undefined = await withinLookup(deps.getSession(current))
      if (!session) return undefined
      current = session.parentID
    }
    return current === undefined ? false : undefined
  }

  const onIdle = async (input: IdleInput) => {
    if (disposed) return
    // The gate's fence, taken before it queues and before any hold or status is read: an execution start or a resume
    // recorded after it keeps a lane the gate removes or finishes, even one seen while the gate waited.
    const planned: Fence = { seq: eventSeq, since: now() }
    // A hook never throws: a coordination error means a deferred outcome (logged), never a removal.
    await serial(async () => {
      const related = (lane: Lane) => lane.child === input.sessionID || lane.parent === input.sessionID
      const jobs = input.background ?? []
      // If what is running could not be recorded, running work cannot be ruled out: nothing is removed this time.
      let holdsFailed = false
      // Every kind of job counts. Any gate, child or parent, records what is running for this lane; the next gate that sees none clears it.
      const recordHolds = async (lane: Lane): Promise<string | undefined> => {
        const known = new Map<string, boolean | undefined>()
        for (const job of jobs) {
          for (const id of [job.sessionID, job.childSessionID]) {
            if (typeof id === "string" && !known.has(id)) known.set(id, id === lane.child ? true : await descends(id, lane.child))
          }
        }
        const matched = laneBackgroundJobs(lane, jobs, (id) => known.get(id))
        const common = await deps.commonDir(lane.parentDir)
        if (common !== undefined) {
          try {
            await lockedWrite(common, lane.directory, { sessionID: input.sessionID, now, ...deps.lock }, () =>
              setHold(
                common,
                lane.directory,
                input.sessionID,
                matched.map(({ job }) => ({ kind: job.kind, id: job.shellID ?? job.childSessionID ?? job.sessionID ?? "unknown" })),
                now(),
              ),
            )
            unsafeHolds.delete(canonical(lane.directory))
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error)
            holdsFailed = true
            unsafeHolds.set(canonical(lane.directory), `its running work could not be recorded (${why})`)
            console.error(`subagent-worktree: could not record holds for ${lane.directory}:`, why)
          }
        }
        return matched[0]?.why
      }
      // The running work is recorded for active and removing lanes before any recovery looks at them: a lane a crash left in `removing` may still have a shell in its checkout.
      const busyOf = new Map<string, string | undefined>()
      for (const lane of (await deps.scan()).filter((candidate) => (candidate.state === "active" || candidate.state === "removing") && related(candidate))) {
        busyOf.set(lane.child, await recordHolds(lane))
      }
      await resumeRemovals(related, planned)
      const lanes = (await deps.scan()).filter((lane) => lane.state === "active" && related(lane))
      if (lanes.length === 0) return
      for (const lane of lanes) await deps.ensureClaim(lane)
      const running = new Set<string>()
      const gateLanes = await Promise.all(
        lanes.map(async (lane) => {
          const busy = busyOf.has(lane.child) ? busyOf.get(lane.child) : await recordHolds(lane)
          if (busy !== undefined && lane.parent === input.sessionID) running.add(lane.child)
          const child = busy !== undefined ? "running" : await statusOf(lane.child)
          if (child === "running" && lane.parent === input.sessionID) running.add(lane.child)
          return { lane, facts: await laneFacts(lane, { child, parent: lane.parent === input.sessionID ? "idle" : "unknown" }) }
        }),
      )
      const gate = idleGateAction(
        { id: input.sessionID, runningChildren: running, now: now(), lastMessageAt: lastGate.get(input.sessionID) },
        gateLanes.map(({ lane, facts }) => ({ lane, facts })),
        policy,
      )
      for (const { lane } of holdsFailed ? [] : gate.remove) await finalize(lane, planned)
      if (gate.message === undefined) return
      // Each notice is reserved on disk first; the message carries only the ones this instance won.
      const won: typeof gate.marks = []
      for (const entry of gate.marks) {
        const lane = gateLanes.find(({ lane: candidate }) => candidate.child === entry.child)?.lane
        if (lane && (await reserve(lane, entry.key)) === "ok") won.push(entry)
      }
      if (won.length === 0) return
      const lines = won.flatMap((entry) => (entry.line === undefined ? [] : [entry.line]))
      if (await send(input.sessionID, lines.length > 0 ? gateMessage(lines) : gate.message)) {
        lastGate.set(input.sessionID, now())
        for (const { child, key } of won) await mark(child, key)
      } else {
        for (const entry of won) {
          const lane = gateLanes.find(({ lane: candidate }) => candidate.child === entry.child)?.lane
          if (lane) await release(lane, [entry.key])
        }
      }
    }).catch((error) => console.error("subagent-worktree: idle gate failed:", error instanceof Error ? error.message : error))
  }

  // --- landings -----------------------------------------------------------------------------

  const onLanding = async (event: { tool: string; status: string; result?: unknown }) => {
    if (!LANDING_TOOLS.includes(event.tool) || event.status !== "completed") return
    const lanes = (await deps.scan()).filter((lane) => lane.state === "active" || lane.state === "removing")
    if (lanes.length === 0) return
    const gone = (path: string) => !existsSync(path)
    const lane = laneForLanding(event.result, lanes, canonical, gone)
    // Delivery removed the worktree: the same path moves the lane's sessions home and retires the lane.
    if (lane) await finalize(lane, { gone: true, retireAs: "landed" })
  }

  // --- sweep --------------------------------------------------------------------------------

  const PROOF_TEXT = { empty: "empty: no commits of its own", merged: "merged", landed: "landed" } as const

  /** What `finalize` would do with an active lane, from its checks alone: nothing is written or removed. */
  const previewFinalize = async (lane: Lane, fence: Fence): Promise<{ removable: true; reason: string } | { removable: false; reason: string; needsPerson: boolean }> => {
    const checked = await checkFinalize(lane, fence, fence.seq, undefined)
    if ("proof" in checked) {
      const descendants = await descendantRefusal(lane)
      if (!("ids" in descendants)) return { removable: false, reason: "reason" in descendants ? descendants.reason : "removable", needsPerson: false }
      return { removable: true, reason: PROOF_TEXT[checked.proof] }
    }
    if (checked.removed) return { removable: true, reason: "removable" }
    return { removable: false, reason: checked.reason, needsPerson: needsPerson(checked) }
  }

  /** A refusal that only a person can resolve: uncommitted, unmerged or denied work. */
  const needsPerson = (refusal: Extract<Finalized, { removed: false }>): boolean => refusal.kept === "dirty" || refusal.kept === "unmerged" || refusal.kept === "denied"

  /** One lane's line of the sweep: in prune mode a removable lane goes through `finalize`, the one removal path. */
  const sweepLane = async (lane: Lane, mode: SweepMode): Promise<SweepEntry> => {
    const entry = { child: lane.child, directory: lane.directory, branch: lane.branch }
    // Captured before the first child lookup: a resume or an execution start after it keeps the lane through the preview and `finalize`.
    const fence: Fence = { seq: eventSeq, since: now() }
    // A lane still active whose directory is gone was removed outside the plugin (a removal of ours leaves the lane `removing`, which `resumeRemovals` finishes): the host cannot even
    // look up its child, so it is reported for a person and left alone.
    if (!(await deps.exists(lane.directory))) return { ...entry, verdict: "keep", reason: "its worktree directory is gone and the lane was not retired (removed outside the plugin)", needsPerson: true }
    // Only a deleted or archived subagent session releases its lane; a live one, or one that cannot be read, keeps it.
    const child = await childState(ctx.session.get({ sessionID: lane.child } as never), deps.lookupMs, lane.child)
    if (!childReleasesLane(child)) return { ...entry, verdict: "keep", reason: `its subagent session is ${child}` }
    const preview = await previewFinalize(lane, fence)
    if (!preview.removable) return { ...entry, verdict: "keep", reason: preview.reason, ...(preview.needsPerson ? { needsPerson: true as const } : {}) }
    if (mode === "report") return { ...entry, verdict: "remove", reason: preview.reason }
    const done = await finalize(lane, fence)
    if (done.removed) return { ...entry, verdict: "remove", reason: preview.reason }
    return { ...entry, verdict: "keep", reason: done.reason, ...(needsPerson(done) ? { needsPerson: true as const } : {}) }
  }

  /** The report for this project's active lanes; with mode "prune" the removable ones are removed. Never forces, never touches a remote. */
  const sweep = async (mode: SweepMode): Promise<{ plan: SweepEntry[]; text: string }> => {
    try {
      return await sweepUnsafe(mode)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      console.error("subagent-worktree: sweep failed:", why)
      return { plan: [], text: `subagent_worktree_sweep: failed (${why}); nothing was removed.` }
    }
  }

  const sweepUnsafe = async (mode: SweepMode): Promise<{ plan: SweepEntry[]; text: string }> => {
    if (projectID === undefined) return { plan: [], text: "subagent_worktree_sweep: the host reports no project." }
    // A pruning sweep also finishes removals a crash left half done; a report changes nothing.
    if (mode === "prune") await resumeRemovals()
    const lanes = (await deps.scan()).filter((lane) => lane.state === "active" && lane.projectID === projectID)
    const entries: SweepEntry[] = []
    for (const lane of lanes) entries.push(await sweepLane(lane, mode))
    const plan = orderEntries(entries)
    await ctx.storage.set("sweep/last", { at: now(), mode, plan })
    return { plan, text: formatSweep(plan, mode) }
  }

  const runSweep = (mode: SweepMode) => {
    const next = sweepChain.then(() => sweep(mode))
    sweepChain = next.catch(() => {})
    return next
  }

  /** Record an explicit keep: the gate stays quiet about this lane until its state token changes. */
  const keep = async (child: string, reason: string): Promise<Lane | undefined> => {
    const lane = await load(child)
    if (lane?.state !== "active") return undefined
    const facts = await laneFacts(lane, { child: "unknown", parent: "unknown" })
    const kept = { ...lane, kept: { reason, token: stateToken(facts) } }
    await save(kept)
    return kept
  }

  // --- registration -------------------------------------------------------------------------

  const registrations: Array<{ dispose: () => Promise<void> }> = []
  const abort = new AbortController()
  let iterator: AsyncIterator<unknown> | undefined

  const start = async () => {
    iterator = ctx.event.subscribe({ types: [...EVENT_TYPES], signal: abort.signal } as never)[Symbol.asyncIterator]()
    const events = iterator
    void (async () => {
      for (;;) {
        const next = await events.next().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) return
        try {
          handleEvent(next.value)
        } catch (error) {
          console.error("subagent-worktree: event handling failed", error)
        }
      }
    })()
    if (options.gates) {
      try {
        registrations.push(await ctx.session.hook("experimental.idle" as never, onIdle as never))
        gatesActive = true
      } catch {
        gatesActive = false
      }
    }
    // A crash or a failed move left these removals half done. In the background: setup must not wait on git and the host.
    // Every execution start this instance sees from now on keeps the lane (`seq` 0), even one seen before the lock is taken.
    void serial(() => resumeRemovals(() => true, { seq: 0 }))
  }

  const dispose = async () => {
    disposed = true
    abort.abort()
    await iterator?.return?.()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    pending.clear()
    for (const registration of registrations.reverse()) await registration.dispose()
    // A pass already running can queue a continuation behind itself: wait until both chains stop changing, as `settle` does.
    for (;;) {
      const current = chain
      const sweeping = sweepChain
      await Promise.allSettled([current, sweeping])
      if (current === chain && sweeping === sweepChain) break
    }
    // The last chance to give back a reservation whose send failed; one still held is logged.
    for (const { lane } of [...unreleased.values()]) await flushReleases(lane)
  }

  /** Wait for scheduled and running passes; for tests and shutdown. */
  /** Wait until no pass is scheduled and the serial chain is quiet, including work queued while waiting; tests await it. */
  const settle = async () => {
    for (;;) {
      while (pending.size > 0) await new Promise((done) => setTimeout(done, debounceMs + 1))
      const current = chain
      const sweeping = sweepChain
      await Promise.allSettled([current, sweeping])
      if (current === chain && sweeping === sweepChain && pending.size === 0) return
    }
  }

  return { start, dispose, handleEvent, onIdle, onLanding, keep, removeForeground, removeAfterMerge, resumeRemovals, noteResume, spawnInto, sweep: runSweep, settle }
}

export type Lifecycle = ReturnType<typeof createLifecycle>
