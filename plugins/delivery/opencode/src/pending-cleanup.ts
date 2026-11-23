/**
 * Cleanup that did not finish inside `delivery_land` is retried by delivery itself, for
 * worktrees nothing else owns.
 *
 * With an active Beads ledger the beads close only after the land, so inline cleanup is
 * always skipped there; relying on the agent to call `delivery_cleanup` afterwards is the
 * original leak. A receipt whose worktree is still there is pending. Delivery retries it
 * when a session finishes a turn (`session.execution.*`, `session.idle`, and the
 * `experimental.idle` hook), with the same proofs `delivery_cleanup` applies, and nudges the
 * session that landed it once while its beads are still open.
 *
 * One remover per worktree. A lane's worktree is owned by `subagent-worktree`, which writes a
 * claim file under the git common directory. While a claim exists (or cannot be read) delivery
 * never removes the worktree: it records the landing, and any denial, in a landing record on
 * disk next to the claim, and the owner reads that record before it acts. For a worktree no one
 * claims, ownership (the claim file and every page of the sessions in the directory) is checked
 * again immediately before the removal, after all proofs.
 *
 * A landing in another repository (`delivery_land` with `repo` and a clone) is coordinated in that
 * repository: its landing record, claims, holds, denials and removal lock are the ones under its own
 * git common directory, its sessions are listed for every project, and its worktree is removed
 * through OpenCode's registry only once the sessions there name exactly one project. The session's
 * repository remembers the clone (`clone-registry.ts`), so the retry finds the receipt there.
 *
 * `pendingCleanupAction` is the pure decision; `createPendingCleanup` gathers the facts and
 * carries it out.
 */

import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { type EventWatchDeps, watchEvents } from "@srobroek/opencode-lib/event-watch"
import { canonicalCheckout } from "@srobroek/opencode-lib/session-eviction"
import {
  canonicalDirectory,
  type LandingRecord,
  landingsFor,
  listLandings,
  type Ownership,
  ownershipOf,
  readClaim,
  readLanding,
  removeLanding,
  writeLanding,
} from "@srobroek/opencode-lib/worktree-claims"
import { holdsState, type LockOptions, lockedWorktreeRemoval, lockedWrite, setHold } from "@srobroek/opencode-lib/worktree-locks"
import { ownershipDeferral } from "./auto-cleanup.ts"
import {
  CLEANUP_BOUNDS,
  type CleanupDeps,
  type CleanupFailure,
  type CleanupResult,
  type Coordination,
  cleanupDelivery,
  type HostWorktrees,
  ledgerState,
  type RemovalFacts,
  type RepositoryIdentity,
} from "./cleanup.ts"
import { addClone, type CloneEntry, mergeClone, readClones, settleReceipts, withoutReceipts } from "./clone-registry.ts"
import { inClone } from "./land.ts"
import {
  closeoutCommands,
  type GitRunner,
  type LandingReceipt,
  listReceipts,
  markedRepository,
  readReceipt,
  receiptDirectory,
  repoKey,
  repoKeyOf,
  repositoryContext,
} from "./landing-receipt.ts"
import { type LaneClient, laneSessionsIn, moveLaneHome } from "./lane-move.ts"

/** A receipt file's name: `<epoch>-<merge oid prefix>.json` (see `receiptId`). */
const RECEIPT_FILE = /^\d+-(?:[0-9a-f]{12}|nomerge)\.json$/

/** The same receipt is not retried within this window: an event and the idle hook fire for one turn end. */
export const RETRY_WINDOW_MS = 5_000
export const DEBOUNCE_MS = 2_000
const MAX_PER_PASS = 20
const MAX_SESSION_PAGES = 20

export type PendingAction = "retry" | "nudge" | "done" | "hold" | "skip"

export type PendingFacts = {
  /** The receipt's worktree is already gone. */
  worktreeGone: boolean
  /** Cleanup already succeeded for this receipt in this process. */
  done: boolean
  /** Why an owner or a running session keeps the worktree; undefined when nothing does. */
  hold: string | undefined
  /** `open`: a bead is not closed yet. `closed`: all are, or the ledger is inactive. */
  beads: "open" | "closed" | "unknown"
  /** Retried within {@link RETRY_WINDOW_MS}. */
  recentlyTried: boolean
  /** This turn end belongs to the session that ran `delivery_land`. */
  landingSession: boolean
  /** The trigger is an idle: the session has stopped. Nudges are sent only then. */
  idle: boolean
  /** The nudge for this receipt was already sent. */
  nudged: boolean
  /** The cleanup was denied; only an authorized explicit `delivery_cleanup` call re-arms it. */
  denied: boolean
}

export function pendingCleanupAction(
  receipt: Pick<LandingReceipt, "worktree">,
  facts: PendingFacts,
): { action: PendingAction; reason: string } {
  if (facts.done) return { action: "skip", reason: "already cleaned" }
  if (facts.denied) return { action: "skip", reason: "cleanup was denied; call delivery_cleanup to re-arm it" }
  if (receipt.worktree.path === null || receipt.worktree.removed) return { action: "skip", reason: "nothing to remove" }
  if (facts.worktreeGone) return { action: "done", reason: "the worktree is already gone" }
  if (facts.hold !== undefined) return { action: "hold", reason: facts.hold }
  if (facts.recentlyTried) return { action: "skip", reason: "tried a moment ago" }
  if (facts.beads === "open") {
    if (facts.nudged) return { action: "skip", reason: "beads open; nudge already sent" }
    if (!facts.landingSession || !facts.idle) return { action: "skip", reason: "beads open; waiting for the landing session to go idle" }
    return { action: "nudge", reason: "beads still open when the landing session went idle" }
  }
  return { action: "retry", reason: facts.beads === "closed" ? "beads closed" : "ledger state unknown; the proofs decide" }
}

/**
 * The nudge text: which beads to close, with the commands. For another repository's landing,
 * `clone` is its checkout, and each command runs there without the session's ledger pin.
 */
export function nudgeText(receipt: LandingReceipt, receiptPath: string, clone?: string): string {
  const sha = receipt.pr.mergeCommitOid ?? "missing"
  const commands = receipt.beads.ids.flatMap((id) => {
    const { update, close } = closeoutCommands(id, receipt.pr.number, sha, receiptPath)
    return clone === undefined ? [update, close] : [inClone(clone, update), inClone(clone, close)]
  })
  return `<system-reminder>Landed PR #${receipt.pr.number}: close beads ${receipt.beads.ids.join(", ")} (commands: ${commands.join("; ")}) so its worktree can be cleaned up.</system-reminder>`
}

/** Pending receipts: not cleaned, not superseded by a later receipt. Pure. */
export function pendingReceipts(receipts: readonly LandingReceipt[]): LandingReceipt[] {
  const superseded = new Set(receipts.flatMap((receipt) => (receipt.supersedes === null ? [] : [receipt.supersedes])))
  return receipts.filter(
    (receipt) =>
      receipt.outcome === "landed" &&
      receipt.worktree.path !== null &&
      !receipt.worktree.removed &&
      !superseded.has(receipt.receiptId),
  )
}

/**
 * Which receipts one pass looks at. Receipts that need no attempt (denied, or owned by a lane)
 * do not take a slot, and the rest are ordered by when they were last looked at, so a few that
 * stay held cannot starve the others. Pure.
 */
export function selectWindow<T extends { receiptId: string }>(
  candidates: readonly T[],
  options: { skip: (candidate: T) => boolean; lastAttempt: (candidate: T) => number | undefined; limit: number },
): T[] {
  return candidates
    .filter((candidate) => !options.skip(candidate))
    .map((candidate, index) => ({ candidate, index, at: options.lastAttempt(candidate) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? -1 : 1))
    .slice(0, options.limit)
    .map((entry) => entry.candidate)
}

/**
 * Positive evidence that a receipt needs no more cleanup: it is readable and cleaned, or a readable
 * later receipt supersedes it. A missing directory or an unreadable receipt is never evidence.
 */
export function receiptSettled(directory: string, receiptId: string): boolean {
  try {
    const own = readReceipt(resolve(directory, `${receiptId}.json`))
    if (!own.ok) return false
    if (own.receipt.outcome === "cleaned" || own.receipt.worktree.removed) return true
    return listReceipts(directory).some((receipt) => receipt.supersedes === receiptId)
  } catch {
    return false
  }
}

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

/**
 * `authorize` for an explicit `delivery_cleanup` call. A refused call is a new denial, whatever
 * came before. Once authorized, an earlier denial is cleared (so the owner may proceed) and, if a
 * lane owns the worktree, delivery stops there with {@link CleanupDeferred}: one remover per worktree.
 */
/** What `cleanupDelivery` hands `authorize`. */
export type ExplicitRequest = { worktree: string; branch?: string; pr?: number }

export async function authorizeExplicit(
  pending:
    | {
        deny: (worktree: string, sessionID: string) => Promise<void>
        arm: (worktree: string) => Promise<void>
        ownership: (worktree: string) => Promise<Ownership>
      }
    | undefined,
  ask: (request: ExplicitRequest) => Promise<void>,
  sessionID: string,
  request: ExplicitRequest,
): Promise<void> {
  try {
    await ask(request)
  } catch (error) {
    await pending?.deny(request.worktree, sessionID).catch(() => {})
    throw error
  }
  await pending?.arm(request.worktree).catch(() => {})
  const deferred = pending === undefined ? undefined : explicitDeferral(await pending.ownership(request.worktree))
  if (deferred !== undefined) throw new CleanupDeferred(deferred)
}

/** One entry of the idle hook's `background` list. */
export type BackgroundJob = { kind: string; sessionID?: string; childSessionID?: string; shellID?: string; command?: string }

export type PendingDeps = {
  ctx: Context
  cwd: string
  env: NodeJS.ProcessEnv
  host: () => HostWorktrees | undefined
  /**
   * OpenCode's worktree registry for a given project, when the host has one. Another repository's
   * worktree is removed through it once that repository's project is known; absent, it is removed
   * with git, as when the host has no registry at all.
   */
  hostFor?: () => ((projectID: string) => HostWorktrees) | undefined
  now?: () => number
  debounceMs?: number
  /** Receipts looked at per pass, in each repository. */
  maxPerPass?: number
  /** Test seam: the runner, bounds and clock the cleanup proofs use. */
  cleanup?: Pick<CleanupDeps, "run" | "bounds" | "now">
  /** Test seam: the git runner the repository observations use. */
  observe?: GitRunner
  /** Test seam: the on-disk lock (attempts, ttl, clock, liveness). */
  lock?: Partial<LockOptions>
  /** How long the idle hook waits for one session's location; a lookup that takes longer may match any worktree. */
  sessionLookupMs?: number
  /** Test seam: the backoff clock of the event watch. */
  watch?: Pick<EventWatchDeps, "delaysMs" | "sleep">
}

/** A session location the host did not report within {@link SESSION_LOOKUP_MS}. */
const UNRESOLVED: unique symbol = Symbol("unresolved")
type Location = string | undefined | typeof UNRESOLVED

/** The default bound on one session lookup in the idle hook. */
export const SESSION_LOOKUP_MS = 5_000

export function createPendingCleanup(deps: PendingDeps) {
  const { ctx, cwd, env } = deps
  const now = deps.now ?? Date.now
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS
  const limit = deps.maxPerPass ?? MAX_PER_PASS
  // The same ref-read bound `delivery_cleanup` uses (injectable through `cleanup.bounds`), not a fixed 5 s.
  const observationMs = deps.cleanup?.bounds?.refReadMs ?? CLEANUP_BOUNDS.refReadMs
  const sessionLookupMs = deps.sessionLookupMs ?? SESSION_LOOKUP_MS
  // The veto state below is keyed by canonical worktree path, so it is shared by every repository
  // this instance coordinates: a veto is published here, before any wait, whichever one it is in.
  /** Worktrees whose hold could not be recorded: nothing is removed from them until a later write succeeds. */
  const unsafe = new Map<string, string>()
  /** Denials that could not be written to disk, until an authorized re-arm; keyed by {@link deniedKey}, valued by canonical worktree. */
  const deniedInMemory = new Map<string, string>()
  const deniedKey = (receipt: Pick<LandingReceipt, "receiptId" | "repo">) => `${receipt.repo.key}/${receipt.receiptId}`
  /** Worktrees an explicit `delivery_cleanup` was refused for, published before any wait; cleared only by `arm`. */
  const deniedWorktrees = new Set<string>()
  /** Idle-hook reports of running work whose holds are not written yet; any one keeps every worktree. */
  let holdReportsInFlight = 0
  // Receipt ids are unique only within one repository, so these are keyed by `<repo key>/<receipt id>`.
  const doneIds = new Set<string>()
  const retriedAt = new Map<string, number>()
  const attemptedAt = new Map<string, number>()
  /** Clones registered by this instance, kept here too: a registry write that fails still leaves them found. */
  const registered = new Map<string, CloneEntry>()
  /** Why the clone registry could not be listed at the last read; while set, no other repository's worktree is removed. */
  let discoveryFailure: string | undefined
  /** Repositories (by canonical checkout) whose running work could not be recorded at the last report: nothing is removed there. */
  const holdsUnknown = new Map<string, string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingIdle = new Set<string>()
  let disposed = false
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next
  }

  /**
   * The session's repository, from its last successful observation: the common directory and the
   * receipt key, always as one pair from the same read. A veto (a denial, a landing record, running
   * work) is written with it, so it reaches disk, where other instances and the lane owner read it,
   * without first waiting on git. `prime` fills it at setup; every later observation refreshes it.
   * Removals never use it: they observe the repository fresh.
   */
  type VetoLocation = { commonDir: string; key: string }
  let known: VetoLocation | undefined

  /** The session's repository as one git read sees it now; null if it cannot be resolved. */
  const observeLocation = async (): Promise<VetoLocation | null> => {
    const context = await repositoryContext(cwd, deps.observe, observationMs)
    if (context === null) return null
    known = { commonDir: context.commonDir, key: context.key }
    return known
  }

  /**
   * One repository this instance coordinates: where its claims, landing records, holds and removal
   * lock live, and how to observe it. The session's own is observed from `cwd`. Another one is
   * observed from its canonical root, and only while that root still resolves to the common
   * directory it was identified by; otherwise it does not resolve and everything there holds.
   */
  type Repository = {
    /** The checkout its git reads and its cleanup run from. */
    cwd: string
    /** The repository as one git read sees it now; null if it cannot be resolved. */
    observe: () => Promise<VetoLocation | null>
    /** Its receipt key, read now; null if it cannot be resolved. */
    key: () => Promise<string | null>
    /** Where a veto is written without a git wait, or null; the caller then observes with git. */
    veto: () => VetoLocation | null
    /** The project a session listing is limited to; undefined lists the sessions of every project. */
    project: () => string | undefined
    /** True for a repository other than the session's. */
    foreign: boolean
  }

  const own: Repository = {
    cwd,
    observe: observeLocation,
    key: () => repoKey(cwd, deps.observe, observationMs),
    veto: () => known ?? markedRepository(cwd),
    project: () => (ctx.location as { project?: { id?: string } }).project?.id,
    foreign: false,
  }

  /** Another repository, identified by its common directory and canonical checkout. */
  const repositoryAt = ({ common, root }: RepositoryIdentity): Repository => {
    const location: VetoLocation = { commonDir: common, key: repoKeyOf(common) }
    const observe = async (): Promise<VetoLocation | null> => {
      const context = await repositoryContext(root, deps.observe, observationMs)
      return context !== null && context.commonDir === common ? location : null
    }
    return {
      cwd: root,
      observe,
      key: async () => (await observe())?.key ?? null,
      veto: () => location,
      // The session's project is not this repository's, and a listing by directory alone covers every
      // project, so a session running there is never missed.
      project: () => undefined,
      foreign: true,
    }
  }

  /** The common directory where `repo` keeps its coordination state, observed now; null if it cannot be resolved. */
  const commonOf = async (repo: Repository): Promise<string | null> => (await repo.observe())?.commonDir ?? null

  /** Observe the session's repository so that later vetoes are written without a git wait. */
  const prime = async (): Promise<void> => {
    await observeLocation()
  }

  /** Observe again in the background while the session's repository is still unknown. */
  const warm = () => {
    if (known === undefined) void prime().catch(() => {})
  }

  /**
   * The repository a receipt belongs to, by its key: the session's, or the clone at the receipt's
   * canonical root. The clone's own `.git` entry is read first, without a git wait, so a veto for it
   * still reaches disk at once. Null when neither resolves to the receipt's key.
   */
  const repositoryOf = async (receipt: Pick<LandingReceipt, "repo">): Promise<Repository | null> => {
    const mine = own.veto() ?? (await own.observe())
    if (mine !== null && mine.key === receipt.repo.key) return own
    const root = receipt.repo.canonicalRoot
    const marked = markedRepository(root)
    if (marked !== null && marked.key === receipt.repo.key) return repositoryAt({ common: marked.commonDir, root })
    const context = await repositoryContext(root, deps.observe, observationMs)
    return context !== null && context.key === receipt.repo.key ? repositoryAt({ common: context.commonDir, root }) : null
  }

  /**
   * Whether `key`'s receipt directory may still hold a pending receipt: an absent directory has none;
   * one that cannot be read, or a receipt file in it that does not parse, may.
   */
  const mayHavePending = (key: string): boolean => {
    const directory = resolve(receiptDirectory(env, key))
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT"
    }
    const receipts: LandingReceipt[] = []
    for (const name of names) {
      if (!RECEIPT_FILE.test(name)) continue
      try {
        const read = readReceipt(join(directory, name))
        if (!read.ok) return true
        receipts.push(read.receipt)
      } catch {
        return true
      }
    }
    return pendingReceipts(receipts).length > 0
  }

  /** The registry's entries, tracking whether the registry could be read ({@link discoveryFailure}). Throws when it cannot. */
  const registryEntries = (sessionKey: string): CloneEntry[] => {
    try {
      const listed = readClones(env, sessionKey)
      discoveryFailure = undefined
      return listed
    } catch (error) {
      discoveryFailure = `the clones this session landed in could not be listed (${error instanceof Error ? error.message : String(error)}); the clone registry is unreadable`
      throw error
    }
  }

  /** The registry entry for `receipt`'s landing: where the clone is, and which receipt the session landed there. */
  const cloneEntryFor = (receipt: LandingReceipt, commonDir: string): CloneEntry => ({
    key: receipt.repo.key,
    root: receipt.repo.canonicalRoot,
    commonDir,
    repo: receipt.repo.nameWithOwner,
    receiptIds: [receipt.receiptId],
    addedAt: now(),
  })

  /** Persist `entry` in the registry file; a failure is logged, and the in-memory entry still holds. */
  const persistClone = async (entry: CloneEntry) => {
    const mine = own.veto() ?? (await own.observe())
    if (mine === null) return
    try {
      await addClone(env, mine.key, entry, (known) => mayHavePending(known.key))
    } catch (error) {
      console.error(`delivery: could not record the clone ${entry.root}: ${error instanceof Error ? error.message : String(error)}`, error)
    }
  }

  /**
   * The clones the session's repository landed into that may have pending receipts, read from the
   * registry file and from this instance's own registrations, which win for the same key. No git runs.
   * A registry that cannot be read throws; until a later read succeeds {@link discoveryFailure} holds
   * every other repository's worktrees, so nothing is cleaned on an incomplete list.
   */
  const cloneEntries = (sessionKey: string): CloneEntry[] => {
    const entries = new Map(registryEntries(sessionKey).map((entry) => [entry.key, entry]))
    for (const [key, entry] of registered) entries.set(key, mergeClone(entries.get(key), entry))
    return [...entries.values()].filter((entry) => entry.key !== sessionKey && mayHavePending(entry.key))
  }

  /** The repository a clone entry names, if its root still resolves to the recorded key. */
  const cloneAt = async (entry: CloneEntry): Promise<Repository | null> => {
    const repo = await repositoryOf({ repo: { key: entry.key, canonicalRoot: entry.root } } as Pick<LandingReceipt, "repo">)
    return repo?.foreign === true ? repo : null
  }

  /** {@link cloneEntries} resolved, each on its own, so a stale one delays no other. Throws when the registry cannot be read. */
  const clones = async (): Promise<Repository[]> => {
    const mine = own.veto() ?? (await own.observe())
    if (mine === null) return []
    const found = await Promise.all(cloneEntries(mine.key).map(cloneAt))
    return found.filter((repo): repo is Repository => repo !== null)
  }

  /**
   * The project id the sessions in `directories` carry: exactly one, or a throw, so the removal that
   * needs it refuses. Every page is read; a listing that fails, is incomplete or names no project throws.
   */
  const projectOf = async (root: string, directories: readonly string[]): Promise<string> => {
    const ids = new Set<string>()
    for (const directory of directories) {
      let query: Record<string, unknown> = { directory, limit: 100 }
      let complete = false
      for (let pages = 0; pages < MAX_SESSION_PAGES && !complete; pages++) {
        const page = (await ctx.session.list(query as never)) as { data?: unknown; cursor?: { next?: string } }
        if (!Array.isArray(page?.data)) throw new Error(`the sessions in ${directory} could not be listed`)
        for (const raw of page.data as Array<{ id?: unknown; projectID?: unknown }>) {
          if (typeof raw.projectID !== "string" || raw.projectID === "") throw new Error(`session ${String(raw.id)} in ${directory} names no project`)
          ids.add(raw.projectID)
        }
        const next = page.cursor?.next
        if (next) query = { cursor: next }
        else complete = true
      }
      if (!complete) throw new Error(`the sessions in ${directory} span more pages than are read`)
    }
    const found = [...ids].sort()
    if (found.length === 1) return found[0] as string
    throw new Error(
      `the sessions name ${found.length === 0 ? "no project" : found.join(", ")}, expected exactly one OpenCode project for ${root}; looked in ${directories.join(", ")}`,
    )
  }

  /**
   * OpenCode's worktree registry for another repository. Its project is the one the sessions in the
   * repository's checkout and in the worktree carry, resolved when the registry is first read for
   * that worktree; when they do not name exactly one, the read throws and nothing is removed.
   */
  const projectHost = (root: string): HostWorktrees | undefined => {
    const forProject = deps.hostFor?.()
    if (forProject === undefined) return undefined
    let chosen: string | undefined
    const directories = (target: string | undefined) => [...new Set(target === undefined ? [root] : [root, target])]
    return {
      list: async (target) => {
        chosen = await projectOf(root, directories(target))
        return forProject(chosen).list(target)
      },
      remove: async (directory) => forProject(chosen ?? (await projectOf(root, directories(directory)))).remove(directory),
    }
  }

  /** Who may remove `path`: a lane's claim means its owner only; an unreadable claim means no one. */
  const ownershipAt = (common: string | null, path: string): Ownership => {
    if (common === null) return { owner: "unknown", reason: "the git common directory could not be resolved" }
    return ownershipOf(readClaim(common, path))
  }

  /** {@link ownershipAt}, with `repo`'s common directory observed now. */
  const ownership = async (path: string, repo: Repository = own): Promise<Ownership> => ownershipAt(await commonOf(repo), path)

  /** Who may remove `receipt`'s worktree, read in the receipt's own repository. */
  const ownershipFor = async (receipt: LandingReceipt): Promise<Ownership> => {
    const path = receipt.worktree.path
    if (path === null) return { owner: "none" }
    const repo = await repositoryOf(receipt)
    return repo === null ? { owner: "unknown", reason: `the repository at ${receipt.repo.canonicalRoot} could not be resolved` } : ownership(path, repo)
  }

  /** Landing records by receipt id; `unreadable` when any record could not be read. */
  const landings = async (repo: Repository): Promise<{ byReceipt: Map<string, LandingRecord>; unreadable: boolean; common: string | null }> => {
    const common = await commonOf(repo)
    if (common === null) return { byReceipt: new Map(), unreadable: true, common }
    const listed = listLandings(common)
    return { byReceipt: new Map(listed.records.map((record) => [record.receiptId, record])), unreadable: listed.unreadable, common }
  }

  /** A short write to coordination state for `worktree` in `common`, under the same lock every remover takes. */
  const lockedAt = <T>(common: string, worktree: string, write: () => T): Promise<T> =>
    lockedWrite(common, worktree, { sessionID: "delivery", now, ...deps.lock }, write)

  /** {@link lockedAt}, with `repo`'s common directory observed now. */
  const locked = <T>(repo: Repository, worktree: string, write: () => T): Promise<T> =>
    commonOf(repo).then((common) => {
      if (common === null) throw new Error("the git common directory could not be resolved")
      return lockedAt(common, worktree, write)
    })

  /**
   * Update a landing record. The read, the decision and the write all happen inside the lock, from the
   * record as it is NOW: a writer queued behind another cannot overwrite what the first one wrote. An
   * existing denial survives every update; only an authorized re-arm (`clearDenial`) removes it.
   */
  const writeAt = async (
    common: string,
    receiptId: string,
    worktree: string,
    update: (current: LandingRecord | undefined) => LandingRecord | undefined,
    options: { clearDenial?: boolean } = {},
  ) => {
    await lockedAt(common, worktree, () => {
      const read = readLanding(common, receiptId)
      if (read.kind === "unreadable") throw new Error(`the landing record ${receiptId} cannot be read`)
      const current = read.kind === "present" ? read.value : undefined
      let next = update(current)
      if (next !== undefined && current?.denied !== undefined && next.denied === undefined && options.clearDenial !== true) {
        next = { ...next, denied: current.denied }
      }
      if (next === undefined) removeLanding(common, receiptId)
      else writeLanding(common, next)
    })
  }

  /** {@link writeAt}, with `repo`'s common directory observed now. */
  const write = async (
    repo: Repository,
    receiptId: string,
    worktree: string,
    update: (current: LandingRecord | undefined) => LandingRecord | undefined,
    options: { clearDenial?: boolean } = {},
  ) => {
    const common = await commonOf(repo)
    if (common === null) return
    await writeAt(common, receiptId, worktree, update, options)
  }

  /** Mark the beads reminder as sent. */
  const markNudged = (receiptId: string, worktree: string, repo: Repository = own) =>
    write(repo, receiptId, worktree, (current) => (current ? { ...current, nudged: true } : current))

  /**
   * Whether a record may be dropped, from the receipts as they are now: its own receipt is readable
   * and is cleaned or superseded by a readable later one.
   */
  const dropEvidence = async (repo: Repository, receiptId: string): Promise<boolean> => {
    const key = await repo.key()
    if (key === null) return false
    return receiptSettled(resolve(receiptDirectory(env, key)), receiptId)
  }

  /** Delete a landing record under its worktree's lock, only if it is still not denied and the evidence still holds. */
  const dropLanding = async (repo: Repository, common: string, record: { receiptId: string; worktree: string }, needsEvidence = true) =>
    locked(repo, record.worktree, async () => {
      const current = readLanding(common, record.receiptId)
      if (current.kind !== "present" || current.value.denied !== undefined) return
      if (needsEvidence && !(await dropEvidence(repo, record.receiptId))) return
      removeLanding(common, record.receiptId)
    })

  /** Write the landing record for `receipt` in `repo`, where the repository was last observed. */
  const recordIn = async (repo: Repository, receipt: LandingReceipt, sessionID: string, outcome: { denied?: boolean } = {}) => {
    const path = receipt.worktree.path
    if (path === null) return
    // If the denial cannot be written to disk (the lock is busy, the store is unwritable), it is still
    // remembered here: the retry must never remove what was denied just because the record is missing.
    if (outcome.denied) deniedInMemory.set(deniedKey(receipt), canonicalDirectory(path))
    // Written where the repository was last observed, so the record reaches disk without a git wait.
    const location = repo.veto() ?? (await repo.observe())
    if (location === null) return
    await writeAt(location.commonDir, receipt.receiptId, path, (existing) => ({
      receiptId: receipt.receiptId,
      worktree: path,
      headRefOid: receipt.pr.headRefOid,
      sessionID,
      landedAt: existing?.landedAt ?? now(),
      ...(existing?.nudged ? { nudged: true } : {}),
      ...(outcome.denied ? { denied: { at: now(), sessionID } } : existing?.denied ? { denied: existing.denied } : {}),
    }))
  }

  /**
   * `delivery_land` finished without removing the worktree: record the landing, in the receipt's own
   * repository, for whoever removes it. Another repository is remembered so the retry looks there.
   */
  const record = async (receipt: LandingReceipt, sessionID: string, outcome: { denied?: boolean } = {}) => {
    const path = receipt.worktree.path
    if (path === null) return
    // Before any wait, whichever repository the receipt turns out to be in.
    if (outcome.denied) deniedInMemory.set(deniedKey(receipt), canonicalDirectory(path))
    const repo = await repositoryOf(receipt)
    if (repo === null) return
    // This instance's holds and retry see the clone at once; the record is written before the registry is.
    const commonDir = repo.veto()?.commonDir ?? (await repo.observe())?.commonDir
    const entry = repo.foreign && commonDir !== undefined ? cloneEntryFor(receipt, commonDir) : undefined
    if (entry !== undefined) registered.set(entry.key, mergeClone(registered.get(entry.key), entry))
    await recordIn(repo, receipt, sessionID, outcome)
    if (entry !== undefined) await persistClone(entry)
  }

  /** Receipts, newest first, whose worktree is `path`. */
  const receiptsAt = (key: string | null, path: string): LandingReceipt[] => {
    if (key === null) return []
    const want = canonicalDirectory(path)
    return pendingReceipts(listReceipts(resolve(receiptDirectory(env, key)))).filter(
      (receipt) => receipt.worktree.path !== null && canonicalDirectory(receipt.worktree.path) === want,
    )
  }

  /** An explicit `delivery_cleanup` for `worktree` in `repo` was refused: that is a (new) denial, whatever came before. */
  const denyIn = (repo: Repository) => async (worktree: string, sessionID: string) => {
    // Visible to every final check from here on, before any wait, and kept whether or not the records below are written.
    deniedWorktrees.add(canonicalDirectory(worktree))
    // Where the repository was last observed, so the denial reaches disk without a git wait.
    const location = repo.veto() ?? (await repo.observe())
    if (location === null) return
    for (const receipt of receiptsAt(location.key, worktree)) await recordIn(repo, receipt, sessionID, { denied: true })
    // A record that exists without a pending receipt in view (for example after a restart) is denied too.
    const common = location.commonDir
    for (const entry of landingsFor(listLandings(common).records, worktree)) {
      await writeAt(common, entry.receiptId, entry.worktree, (current) => (current ? { ...current, denied: { at: now(), sessionID } } : current))
    }
  }

  /** An explicit `delivery_cleanup` for `worktree` in `repo` was authorized: only now is an earlier denial cleared. */
  const armIn = (repo: Repository) => async (worktree: string) => {
    for (const [id, where] of deniedInMemory) if (where === canonicalDirectory(worktree)) deniedInMemory.delete(id)
    deniedWorktrees.delete(canonicalDirectory(worktree))
    const { byReceipt } = await landings(repo)
    for (const entry of landingsFor([...byReceipt.values()], worktree)) {
      if (entry.denied === undefined) continue
      const { denied: _denied, ...rest } = entry
      await write(repo, entry.receiptId, entry.worktree, () => rest, { clearDenial: true })
    }
  }

  /**
   * Whether `path` may be removed by delivery right now: no lane claims it (or can be read to
   * say so) and no session is running in it. Every page of the sessions is read; a lookup that
   * fails or is incomplete holds. Returns the reason to hold, or undefined. `common` is the git
   * common directory the caller observed before this check, so the session listing is its only wait.
   */
  const holdAt = async (repo: Repository, common: string | null, path: string): Promise<string | undefined> => {
    const owned = ownershipDeferral(ownershipAt(common, path))
    if (owned !== undefined) return owned
    // Background work any idle gate (this plugin's or the lane owner's) recorded for this directory,
    // and whether the store those records live in can be written at all.
    if (common === null) return "the git common directory could not be resolved"
    if (repo.foreign && discoveryFailure !== undefined) return discoveryFailure
    const unknownHolds = holdsUnknown.get(canonicalDirectory(repo.cwd))
    if (unknownHolds !== undefined) return unknownHolds
    const failed = unsafe.get(canonicalDirectory(path))
    if (failed !== undefined) return failed
    const running = holdsState(common, path, now())
    if (running !== undefined) return running
    const projectID = repo.project()
    try {
      let query: Record<string, unknown> = {
        ...(projectID === undefined ? {} : { project: projectID }),
        directory: path,
        archived: false,
        limit: 100,
      }
      for (let pages = 0; pages < MAX_SESSION_PAGES; pages++) {
        const page = (await ctx.session.list(query as never)) as { data?: unknown; cursor?: { next?: string } }
        if (!Array.isArray(page?.data)) return `the sessions in ${path} could not be listed`
        for (const raw of page.data as Array<{ time?: { busy?: unknown; idle?: unknown } }>) {
          const busy = typeof raw.time?.busy === "number" ? raw.time.busy : undefined
          const idle = typeof raw.time?.idle === "number" ? raw.time.idle : undefined
          if (busy !== undefined && (idle === undefined || busy > idle)) return `a session is running in ${path}`
        }
        const next = page.cursor?.next
        if (!next) return undefined
        query = { cursor: next }
      }
      return `the sessions in ${path} span more pages than are read`
    } catch {
      return `the sessions in ${path} could not be listed`
    }
  }

  /** A denial recorded for `path`, or records that cannot be read, read fresh from `common`. */
  const landingBlockAt = (common: string | null, path: string): string | undefined => {
    if (common === null) return "the git common directory could not be resolved"
    const listed = listLandings(common)
    if (listed.unreadable) return "the landing records could not be read"
    if ([...deniedInMemory.values()].includes(canonicalDirectory(path)) || deniedWorktrees.has(canonicalDirectory(path))) {
      return "cleanup was denied; an explicit delivery_cleanup re-arms it"
    }
    if (landingsFor(listed.records, path).some((entry) => entry.denied !== undefined)) {
      return "cleanup was denied; an explicit delivery_cleanup re-arms it"
    }
    return undefined
  }

  /**
   * The hold and the denials for `worktree`, both read after the one observation of the common
   * directory. Vetoes still being written (an idle report of running work) are read last, with no
   * wait after them.
   */
  const holdCheckAt = async (repo: Repository, common: string | null, worktree: string): Promise<string | undefined> =>
    (await holdAt(repo, common, worktree)) ??
    landingBlockAt(common, worktree) ??
    // Read again after the session listing: a report that failed to write its hold during it marks the worktree.
    unsafe.get(canonicalDirectory(worktree)) ??
    (holdReportsInFlight > 0 ? "running work reported by an idle session is still being recorded" : undefined)

  /**
   * The last look before the removal call itself (claims, holds, sessions, denials), read fresh. The
   * common directory is observed first, so no Git wait sits between these reads and the removal: a
   * session that starts or a denial recorded during such a wait would go unseen.
   */
  const holdCheck = async (repo: Repository, worktree: string): Promise<string | undefined> => holdCheckAt(repo, await commonOf(repo), worktree)

  /**
   * The removal boundary every delivery remover goes through (explicit, inline, retry), in `repo`:
   * the same on-disk lock `subagent-worktree` takes, then, under it and after every proof, the last
   * look at claims, running work, sessions and denials, then the removal itself. Refuses (does not
   * throw) when anything holds.
   */
  const sectionIn =
    (repo: Repository) =>
    async (worktree: string, run: () => Promise<CleanupFailure | RemovalFacts>): Promise<CleanupFailure | RemovalFacts> => {
      const common = await commonOf(repo)
      if (common === null) return { ok: false, reason: "worktree.held: observed the git common directory could not be resolved, expected a coordination store; nothing was removed" }
      const outcome = await lockedWorktreeRemoval(common, worktree, { sessionID: "delivery", now, ...deps.lock }, {
        recheck: () => holdCheck(repo, worktree),
        remove: run,
      })
      if (outcome.removed) return outcome.value
      return { ok: false, reason: `worktree.held: observed ${outcome.reason}, expected no owner, hold, denial or competing remover; nothing was removed` }
    }

  /**
   * The removal dependencies every delivery remover passes to `cleanupDelivery`, bound to `repo`. The
   * worktree goes first. Then the lane's own sessions move to the repository's canonical checkout, so
   * none is left pointing at a directory that is gone ("Location not found"). The lane is every
   * session below the roots delivery knows for the worktree (the sessions passed in, and every landing
   * record's) that sits in the worktree or below it. It is discovered after the removal: the host
   * still lists and reads such a session, and a session created while the worktree was being removed
   * is found too. The roots and the worktree's canonical path are taken just before the removal, while
   * the path still resolves. A failed read or move is reported with the result and never fails the cleanup.
   */
  const removalIn = (repo: Repository, ...sessionIDs: ReadonlyArray<string | undefined>) => {
    if (!repo.foreign) warm()
    const client = ctx.session as unknown as LaneClient
    let roots: string[] = []
    let forms: string[] = []
    return {
      removalSection: sectionIn(repo),
      finalCheck: async (worktree: string): Promise<string | undefined> => {
        const common = await commonOf(repo)
        const held = await holdCheckAt(repo, common, worktree)
        if (held !== undefined) return held
        const recorded = common === null ? [] : landingsFor(listLandings(common).records, worktree).map((entry) => entry.sessionID)
        roots = [...new Set([...sessionIDs, ...recorded].filter((id): id is string => typeof id === "string"))]
        forms = [...new Set([worktree, canonicalDirectory(worktree)])]
        return undefined
      },
      afterRemoval: async (worktree: string): Promise<string[]> => {
        const lane = await laneSessionsIn(client, roots, forms.length === 0 ? [worktree] : forms)
        return moveLaneHome(client, lane, canonicalCheckout((await commonOf(repo)) ?? undefined, repo.cwd))
      },
    }
  }

  /** What `authorizeExplicit` records denials, re-arms and ownership in, for `repo`. */
  const explicitIn = (repo: Repository) => ({ deny: denyIn(repo), arm: armIn(repo), ownership: (path: string) => ownership(path, repo) })

  /**
   * One other repository's coordination, bound to the common directory it was identified by: its
   * denials, re-arms, ownership, removal section and removal dependencies, and its host registry.
   */
  const repositoryCoordination = (identity: RepositoryIdentity) => {
    const repo = repositoryAt(identity)
    return {
      ...explicitIn(repo),
      section: sectionIn(repo),
      removalFor: (...sessionIDs: ReadonlyArray<string | undefined>) => removalIn(repo, ...sessionIDs),
      host: () => projectHost(identity.root),
      observe: repo.observe,
    }
  }

  /**
   * `CleanupDeps.coordinate`: another repository's coordination, for a cleanup that runs in its
   * clone. The clone must still resolve to the common directory it was identified by. With `ask`
   * (an explicit call) a refused prompt is recorded as a denial there, and an authorized one re-arms it.
   */
  const coordinateWith =
    (sessionIDs: ReadonlyArray<string | undefined>, explicit?: { ask: (request: ExplicitRequest) => Promise<void>; sessionID: string }) =>
    async (identity: RepositoryIdentity): Promise<Coordination | CleanupFailure> => {
      const coordination = repositoryCoordination(identity)
      if ((await coordination.observe()) === null) {
        return {
          ok: false,
          reason: `repo.common: observed ${JSON.stringify(identity.root)} not resolving to ${JSON.stringify(identity.common)}, expected the clone to keep the common directory it was identified by; nothing was removed`,
        }
      }
      return {
        ...coordination.removalFor(...sessionIDs),
        host: coordination.host(),
        ...(explicit === undefined
          ? {}
          : { authorize: (request: ExplicitRequest) => authorizeExplicit(coordination, explicit.ask, explicit.sessionID, request) }),
      }
    }

  /** `authorize` and the removal dependencies for an explicit `delivery_cleanup` call, in whichever repository it names. */
  const explicit = (ask: (request: ExplicitRequest) => Promise<void>, sessionID: string) => ({
    authorize: (request: ExplicitRequest) => authorizeExplicit(explicitIn(own), ask, sessionID, request),
    ...removalIn(own, sessionID),
    coordinate: coordinateWith([sessionID], { ask, sessionID }),
  })

  /**
   * Drop landing records in `repo`, only on positive evidence: the record's own receipt is readable
   * and is cleaned or superseded by a readable later one. A denial is never dropped here (an
   * authorized re-arm clears it first). If the receipt directory is missing or unreadable, or the
   * receipt cannot be parsed, nothing is deleted.
   */
  const gcIn = async (repo: Repository): Promise<boolean> => {
    const recorded = await landings(repo)
    if (recorded.common === null || recorded.unreadable) return false
    for (const entry of recorded.byReceipt.values()) {
      // A cheap look first; the decision is made again, under the lock, from the record and receipts as they are then.
      if (entry.denied !== undefined || !(await dropEvidence(repo, entry.receiptId))) continue
      await dropLanding(repo, recorded.common, entry)
    }
    return true
  }

  /**
   * Drop `entry`'s receipts that are settled, or that `finished` names (a cleanup that just succeeded),
   * from the registry. The target's landing records are collected first, because once the registration
   * is gone nothing else would find them; records that could not all be read keep the registration for a
   * later pass. A failure is reported and keeps it too. An entry with no receipt list (older) is left to
   * the count rule.
   */
  const settleClone = async (sessionKey: string, entry: CloneEntry, finished: ReadonlySet<string> = new Set()) => {
    if (entry.receiptIds === undefined) return
    const directory = resolve(receiptDirectory(env, entry.key))
    const settled = new Set(entry.receiptIds.filter((id) => finished.has(id) || receiptSettled(directory, id)))
    if (settled.size === 0) return
    try {
      const repo = await cloneAt(entry)
      if (repo === null || !(await gcIn(repo))) {
        console.error(`delivery: landing records of ${entry.repo ?? entry.root} could not all be read; keeping its clone registration`)
        return
      }
      // Another receipt of that repository (one this session never registered) may still need the
      // clone to be found: keep the registration while any receipt is pending, or cannot be listed.
      // `listReceipts` reads a directory it cannot open as an empty one, so the directory is read first.
      let pendingLeft: boolean
      try {
        readdirSync(directory)
        pendingLeft = pendingReceipts(listReceipts(directory)).some((receipt) => !settled.has(receipt.receiptId))
      } catch {
        pendingLeft = true
      }
      if (pendingLeft) return
      const known = registered.get(entry.key)
      const left = known === undefined ? null : withoutReceipts(known, settled)
      if (left === null) registered.delete(entry.key)
      else registered.set(entry.key, left)
      await settleReceipts(env, sessionKey, entry.key, settled)
    } catch (error) {
      console.error(`delivery: clone registry gc failed for ${entry.repo ?? entry.root}`, error)
    }
  }

  /** {@link settleClone} for every registration of the session's repository. */
  const gcClones = async () => {
    const mine = own.veto() ?? (await own.observe())
    if (mine === null) return
    let listed: CloneEntry[]
    try {
      listed = registryEntries(mine.key)
    } catch (error) {
      console.error("delivery: the clone registry could not be read; no clone is settled", error)
      return
    }
    const entries = new Map(listed.map((entry) => [entry.key, entry]))
    for (const [key, entry] of registered) entries.set(key, mergeClone(entries.get(key), entry))
    for (const entry of entries.values()) if (entry.key !== mine.key) await settleClone(mine.key, entry)
  }

  /** {@link gcIn} for the session's repository, the clones with pending receipts, and `receipt`'s repository; then the registry. */
  const gc = async (receipt?: LandingReceipt) => {
    const repos = [own]
    try {
      repos.push(...(await clones()))
    } catch (error) {
      console.error("delivery: the clones could not be listed", error)
    }
    const named = receipt === undefined ? null : await repositoryOf(receipt)
    if (named?.foreign === true && !repos.some((repo) => repo.cwd === named.cwd)) repos.push(named)
    for (const repo of repos) await gcIn(repo)
    await gcClones()
  }

  /** One pass over `repo`'s pending receipts for a finished turn of `sessionID`. */
  const runIn = async (repo: Repository, sessionID: string, idle: boolean): Promise<Set<string>> => {
    /** The receipts this pass found done: their worktree is gone, or the cleanup just succeeded. */
    const finished = new Set<string>()
    const key = await repo.key()
    if (key === null) return finished
    const directory = resolve(receiptDirectory(env, key))
    let pending: LandingReceipt[]
    try {
      pending = pendingReceipts(listReceipts(directory))
    } catch {
      return finished
    }
    const idOf = (receipt: Pick<LandingReceipt, "receiptId">) => `${key}/${receipt.receiptId}`
    const recorded = await landings(repo)
    await gcIn(repo)
    // A worktree that is gone is done, whatever the window holds.
    const present: LandingReceipt[] = []
    for (const receipt of pending) {
      if (receipt.worktree.path !== null && !existsSync(receipt.worktree.path)) {
        doneIds.add(idOf(receipt))
        finished.add(receipt.receiptId)
        // Gone is evidence the worktree is done, but never erases a denial.
        if (recorded.common !== null && recorded.byReceipt.get(receipt.receiptId)?.denied === undefined) {
          await dropLanding(repo, recorded.common, { receiptId: receipt.receiptId, worktree: receipt.worktree.path }, false)
        }
      } else if (!doneIds.has(idOf(receipt))) present.push(receipt)
    }
    // Lane ownership is read for every candidate the window's filter looks at, before it runs.
    const laneOwned = new Set<string>()
    for (const receipt of present) {
      if (recorded.byReceipt.get(receipt.receiptId)?.denied !== undefined || deniedInMemory.has(idOf(receipt))) continue
      if (receipt.worktree.path !== null && (await ownership(receipt.worktree.path, repo)).owner !== "none") laneOwned.add(receipt.receiptId)
    }
    const window = selectWindow(present, {
      // Denied and lane-owned receipts need no attempt; they must not take a slot.
      skip: (receipt) =>
        recorded.byReceipt.get(receipt.receiptId)?.denied !== undefined ||
        deniedInMemory.has(idOf(receipt)) ||
        laneOwned.has(receipt.receiptId),
      lastAttempt: (receipt) => attemptedAt.get(idOf(receipt)),
      limit,
    })
    for (const receipt of window) {
      if (disposed) return finished
      attemptedAt.set(idOf(receipt), now())
      const path = resolve(directory, `${receipt.receiptId}.json`)
      const meta = recorded.byReceipt.get(receipt.receiptId)
      const recentlyTried = now() - (retriedAt.get(idOf(receipt)) ?? Number.NEGATIVE_INFINITY) < RETRY_WINDOW_MS
      const worktree = receipt.worktree.path as string
      const hold = await holdAt(repo, await commonOf(repo), worktree)
      const beads = hold !== undefined || recentlyTried ? "unknown" : await ledgerState(receipt, repo.cwd, path, deps.cleanup?.run, undefined, observationMs, deps.observe)
      const decision = pendingCleanupAction(receipt, {
        worktreeGone: false,
        done: doneIds.has(idOf(receipt)),
        hold,
        beads,
        recentlyTried,
        landingSession: meta?.sessionID === sessionID,
        idle,
        nudged: meta?.nudged === true,
        denied: false,
      })
      if (decision.action === "nudge") {
        const sent = await ctx.session.synthetic({ sessionID, text: nudgeText(receipt, path, repo.foreign ? repo.cwd : undefined) } as never).then(
          () => true,
          () => false,
        )
        if (sent && meta) await markNudged(receipt.receiptId, meta.worktree, repo)
      } else if (decision.action === "retry") {
        retriedAt.set(idOf(receipt), now())
        let result: CleanupResult
        try {
          // `finalCheck` re-checks ownership after the proofs and before the removal. Another repository's
          // receipt is cleaned in its own clone, under that repository's coordination.
          result = repo.foreign
            ? await cleanupDelivery({ receipt: path, repo: receipt.repo.nameWithOwner, repoPath: repo.cwd }, cwd, {
                env,
                coordinate: coordinateWith([sessionID, meta?.sessionID]),
                ...deps.cleanup,
              })
            : await cleanupDelivery({ receipt: path }, cwd, { env, host: deps.host(), ...removalIn(own, sessionID, meta?.sessionID), ...deps.cleanup })
        } catch {
          continue
        }
        // A refusal is silent: the proofs say what is missing and a later turn end tries again.
        if (result.ok) {
          doneIds.add(idOf(receipt))
          finished.add(receipt.receiptId)
          if (recorded.common !== null && recorded.byReceipt.get(receipt.receiptId)?.denied === undefined) {
            await dropLanding(repo, recorded.common, { receiptId: receipt.receiptId, worktree }, false)
          }
        }
      }
    }
    return finished
  }

  /** One pass over the session's repository, then over each clone it landed into that has pending receipts. */
  const run = async (sessionID: string, idle: boolean) => {
    await runIn(own, sessionID, idle)
    const mine = own.veto() ?? (await own.observe())
    if (mine !== null) {
      let entries: CloneEntry[] = []
      try {
        entries = cloneEntries(mine.key)
      } catch (error) {
        console.error("delivery: the clones could not be listed; none is cleaned", error)
      }
      for (const entry of entries) {
        if (disposed) return
        const repo = await cloneAt(entry)
        if (repo === null) continue
        await settleClone(mine.key, entry, await runIn(repo, sessionID, idle))
      }
    }
    await gcClones()
  }

  const retryNow = (sessionID: string, idle: boolean) =>
    disposed ? Promise.resolve() : serial(() => run(sessionID, idle)).catch((error) => console.error("delivery: pending cleanup failed", error))

  /** Debounced per session: `succeeded` and `idle` for one turn are one pass. */
  const schedule = (sessionID: string, idle: boolean) => {
    if (disposed) return
    if (idle) pendingIdle.add(sessionID)
    if (timers.has(sessionID)) return
    timers.set(
      sessionID,
      setTimeout(() => {
        timers.delete(sessionID)
        void retryNow(sessionID, pendingIdle.delete(sessionID))
      }, debounceMs),
    )
  }

  const handleEvent = (raw: unknown) => {
    const event = raw as { type?: string; data?: { sessionID?: unknown } }
    const sessionID = event.data?.sessionID
    if (typeof sessionID !== "string") return
    if (event.type === "session.idle") schedule(sessionID, true)
    else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") schedule(sessionID, false)
  }

  /**
   * Where a session works, or `UNRESOLVED` when the host does not answer within the bound. A lookup
   * that fails is a session the host does not have, as before; one that never settles must not keep
   * the report, and with it every removal, waiting.
   */
  const sessionLocation = (id: string): Promise<Location> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<typeof UNRESOLVED>((done) => {
      timer = setTimeout(() => done(UNRESOLVED), sessionLookupMs)
    })
    const lookup = Promise.resolve()
      .then(() => ctx.session.get({ sessionID: id } as never))
      .then(
        (session) => (session as { location?: { directory?: string } } | undefined)?.location?.directory,
        () => undefined,
      )
    return Promise.race([lookup, bound]).finally(() => clearTimeout(timer))
  }

  /**
   * The idle hook's `background` list, written to disk for every worktree delivery might clean (in the
   * session's repository and in each clone it landed into), so its final check (and the lane owner)
   * sees running work: a shell whose command names the worktree, or any job of a session that works in
   * it. A session with none clears its own entry.
   */
  const recordHolds = async (sessionID: string, background: ReadonlyArray<BackgroundJob>) => {
    // Until every hold below is written (or the worktree is marked unsafe), the report itself keeps
    // every worktree: the waits before the writes must not let a remover miss this running work.
    if (background.length === 0) return writeHolds(sessionID, background)
    holdReportsInFlight++
    try {
      await writeHolds(sessionID, background)
    } finally {
      holdReportsInFlight--
    }
  }

  const writeHolds = async (sessionID: string, background: ReadonlyArray<BackgroundJob>) => {
    // One lookup per session, shared by every repository's writes.
    const locations = new Map<string, Promise<Location>>()
    const locationOf = (id: string): Promise<Location> => {
      let found = locations.get(id)
      if (found === undefined) {
        found = sessionLocation(id)
        locations.set(id, found)
      }
      return found
    }
    // Each repository's holds are written side by side, so none waits behind another's lookups, locks
    // or observation (a stale clone that needs git delays only itself).
    const inClones = async () => {
      const mine = own.veto() ?? (await own.observe())
      if (mine === null) return
      let entries: CloneEntry[]
      try {
        entries = cloneEntries(mine.key)
      } catch (error) {
        // The clones are unknown; discoveryFailure now holds every other repository's worktrees.
        console.error("delivery: the clones could not be listed to record holds", error)
        return
      }
      await Promise.all(
        entries.map(async (entry) => {
          const repo = await cloneAt(entry).catch(() => null)
          if (repo === null) {
            holdsUnknown.set(canonicalDirectory(entry.root), `the clone ${entry.root} could not be resolved to record its running work`)
            return
          }
          await writeHoldsIn(repo, sessionID, background, locationOf)
        }),
      )
    }
    await Promise.all([writeHoldsIn(own, sessionID, background, locationOf), inClones()])
  }

  /**
   * {@link establishHolds} for one repository. When its holds cannot be established the repository
   * refuses every removal ({@link holdsUnknown}) until a later report records them.
   */
  const writeHoldsIn = async (
    repo: Repository,
    sessionID: string,
    background: ReadonlyArray<BackgroundJob>,
    locationOf: (id: string) => Promise<Location>,
  ) => {
    const guard = canonicalDirectory(repo.cwd)
    try {
      await establishHolds(repo, sessionID, background, locationOf)
      holdsUnknown.delete(guard)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      holdsUnknown.set(guard, `its running work could not be recorded (${why})`)
      console.error(`delivery: could not record holds in ${repo.cwd}: ${why}`)
    }
  }

  const establishHolds = async (
    repo: Repository,
    sessionID: string,
    background: ReadonlyArray<BackgroundJob>,
    locationOf: (id: string) => Promise<Location>,
  ) => {
    // Where the repository was last observed, so a hold reaches disk without a git wait.
    const location = repo.veto() ?? (await repo.observe())
    if (location === null) throw new Error(`the repository at ${repo.cwd} could not be resolved`)
    const { commonDir: common, key } = location
    let pending: LandingReceipt[]
    const directory = resolve(receiptDirectory(env, key))
    try {
      // `listReceipts` reads an unreadable directory as empty; only a missing one has no receipts.
      readdirSync(directory)
      pending = pendingReceipts(listReceipts(directory)).slice(0, 100)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw new Error(`its receipts could not be listed (${error instanceof Error ? error.message : String(error)})`, { cause: error })
    }
    for (const receipt of pending) {
      const path = receipt.worktree.path
      if (path === null) continue
      const want = canonicalDirectory(path)
      const jobs: Array<{ kind: string; id: string }> = []
      for (const job of background) {
        let inside = job.kind === "shell" && typeof job.command === "string" && job.command.includes(path)
        for (const id of [job.sessionID, job.childSessionID]) {
          if (inside || typeof id !== "string") continue
          const where = await locationOf(id)
          // A session whose location is still unknown after the bound may work in this worktree: hold it.
          if (where === UNRESOLVED || (where !== undefined && canonicalDirectory(where) === want)) inside = true
        }
        if (inside) jobs.push({ kind: job.kind, id: job.shellID ?? job.childSessionID ?? job.sessionID ?? "unknown" })
      }
      try {
        await lockedAt(common, path, () => setHold(common, path, sessionID, jobs, now()))
        unsafe.delete(want)
      } catch (error) {
        // The record could not be written, so running work cannot be ruled out: nothing is removed from this worktree until a write succeeds.
        const why = error instanceof Error ? error.message : String(error)
        unsafe.set(want, `its running work could not be recorded (${why})`)
        console.error(`delivery: could not record holds for ${path}: ${why}`)
      }
    }
  }

  const registrations: Array<{ dispose: () => Promise<void> }> = []
  let watching: { stop: () => void } | undefined

  const start = async () => {
    watching = watchEvents<unknown>({
      subscribe: (signal) =>
        ctx.event
          .subscribe({ types: ["session.execution.succeeded", "session.execution.failed", "session.idle"], signal } as never)
          [Symbol.asyncIterator](),
      handle: handleEvent,
      warn: (message, fields) => console.warn(`delivery: ${message}`, fields),
      label: "pending cleanup",
      ...deps.watch,
    })
    try {
      registrations.push(
        await ctx.session.hook(
          "experimental.idle" as never,
          (async (input: { sessionID: string; background?: ReadonlyArray<BackgroundJob> }) => {
            // Never throws out of the hook: coordination errors mean a held outcome, never a removal.
            try {
              await recordHolds(input.sessionID, input.background ?? [])
            } catch (error) {
              console.error("delivery: recording holds failed", error)
            }
            await retryNow(input.sessionID, true)
          }) as never,
        ),
      )
    } catch {
      // The hook is experimental; events cover its absence.
    }
  }

  const dispose = async () => {
    disposed = true
    watching?.stop()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const registration of registrations.reverse()) await registration.dispose()
    await chain
  }

  /** Wait for scheduled and running passes; for tests. */
  const settle = async () => {
    await new Promise((done) => setTimeout(done, 0)) // let a queued event reach the handler
    while (timers.size > 0) await new Promise((done) => setTimeout(done, debounceMs + 1))
    await chain
  }

  return {
    start,
    dispose,
    prime,
    record,
    deny: denyIn(own),
    arm: armIn(own),
    markNudged: (receiptId: string, worktree: string) => markNudged(receiptId, worktree),
    ownership: (path: string) => ownership(path),
    ownershipFor,
    section: sectionIn(own),
    removalFor: (...sessionIDs: ReadonlyArray<string | undefined>) => removalIn(own, ...sessionIDs),
    explicit,
    coordinate: (...sessionIDs: ReadonlyArray<string | undefined>) => coordinateWith(sessionIDs),
    repositoryCoordination,
    gc,
    retryNow,
    handleEvent,
    settle,
  }
}
