/** Reading the world for one tick: beads, git and child sessions. */

import { ledgerEnv } from "./ledger.ts"
import type { RootIdentity } from "./policy.ts"
import type { Run } from "./rundir.ts"
import { type Bead, type Child, inScope, isWorkBead } from "./state.ts"

function parseArray(text: string): unknown[] {
  const start = text.indexOf("[")
  if (start < 0) return []
  try {
    const value = JSON.parse(text.slice(start))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

const ids = (items: unknown[]) => items.map((item) => (item as { id?: unknown })?.id).filter((id): id is string => typeof id === "string")

export type BeadView = {
  beads: Bead[]
  ready: string[]
  blocked: string[]
  ok: boolean
  /** Why a scope check failed, when that is why `ok` is false. */
  problem?: string
}

/** A cold embedded store can take 30-50 s for one read. */
export const BD_READ_TIMEOUT_MS = 90_000

/** All reads and retries of one `readBeads` call, kept well inside one tick (`TICK_MS`, 4 minutes). */
export const BD_READ_BUDGET_MS = 180_000

export type ReadOptions = {
  /** The scope bead of a bead-scoped run. It must be listed, and an answer with no open work under it is cross-checked. */
  scopeId?: string
  /** Reads before an unknown answer stands. */
  attempts?: number
  /** Wait between reads, in milliseconds. */
  pauseMs?: number
  /** The wait itself; tests pass a controlled one. */
  sleep?: (ms: number) => Promise<void>
  /** Time for all reads and retries together; each bd call gets at most what is left. */
  budgetMs?: number
  /** The clock the budget is measured on; tests pass a controlled one. */
  now?: () => number
}

/** `bd list --all`, `bd ready` and `bd blocked`, as JSON, from `ledger` and no other. */
async function readOnce(directory: string, run: Run, ledger: string, timeout: number): Promise<BeadView> {
  const env = ledgerEnv(ledger)
  const [list, ready, blocked] = await Promise.all([
    run(directory, "bd", ["list", "--all", "--brief", "--json", "--limit", "0"], timeout, env),
    run(directory, "bd", ["ready", "--brief", "--json", "--limit", "0"], timeout, env),
    run(directory, "bd", ["blocked", "--json"], timeout, env),
  ])
  const beads = parseArray(list.stdout).flatMap((raw) => {
    const item = raw as Partial<Bead>
    if (typeof item?.id !== "string" || typeof item.status !== "string") return []
    return [{ id: item.id, status: item.status, parent: item.parent ?? null, ...(item.issue_type ? { issue_type: item.issue_type } : {}), labels: item.labels ?? null }]
  })
  return { beads, ready: ids(parseArray(ready.stdout)), blocked: ids(parseArray(blocked.stdout)), ok: list.ok && ready.ok && blocked.ok }
}

/**
 * A scope read that cannot be trusted is unknown, not empty. An existing scope bead must be listed, and
 * a list with no open work under it must agree with `bd children`, which reads the same store another
 * way. Returns the reason the read is not trusted, or `undefined`.
 */
async function scopeProblem(directory: string, run: Run, ledger: string, scopeId: string, view: BeadView, timeout: () => number): Promise<string | undefined> {
  if (!view.beads.some((bead) => bead.id === scopeId)) return `bd list did not return the scope bead ${scopeId}`
  const all = new Map(view.beads.map((bead) => [bead.id, bead]))
  const scope = { kind: "bead", id: scopeId } as const
  if (view.beads.some((bead) => bead.status !== "closed" && isWorkBead(bead) && inScope(bead, scope, all))) return undefined
  const left = timeout()
  if (left <= 0) return `no time was left to run bd children ${scopeId}, so a scope with no open work cannot be confirmed`
  const children = await run(directory, "bd", ["children", scopeId, "--json"], left, ledgerEnv(ledger))
  if (!children.ok) return `bd children ${scopeId} failed, so a scope with no open work cannot be confirmed`
  const kids = parseBeadList(children.stdout)
  if (kids === undefined) return `bd children ${scopeId} answered something that is not a list of beads, so a scope with no open work cannot be confirmed`
  const open = kids.filter((bead) => bead.status !== "closed" && isWorkBead(bead))
  return open.length > 0 ? `bd list shows no open work under ${scopeId} but bd children shows ${open.length} open` : undefined
}

/**
 * A `bd ... --json` list of beads, or undefined when the reply is not one: not JSON, not an array, or an
 * entry without a string `id` and `status`. Text before the first `[` (a bd warning) is skipped.
 */
function parseBeadList(text: string): Pick<Bead, "id" | "status" | "issue_type" | "labels">[] | undefined {
  const start = text.indexOf("[")
  if (start < 0) return undefined
  let value: unknown
  try {
    value = JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
  if (!Array.isArray(value)) return undefined
  const beads: Pick<Bead, "id" | "status" | "issue_type" | "labels">[] = []
  for (const raw of value) {
    const item = raw as { id?: unknown; status?: unknown; issue_type?: unknown; labels?: unknown }
    if (typeof item?.id !== "string" || typeof item.status !== "string") return undefined
    beads.push({
      id: item.id,
      status: item.status,
      ...(typeof item.issue_type === "string" ? { issue_type: item.issue_type } : {}),
      labels: Array.isArray(item.labels) ? item.labels.filter((label): label is string => typeof label === "string") : null,
    })
  }
  return beads
}

const realSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/**
 * The beads of one ledger, read up to `attempts` times until the read is complete and, for a bead scope,
 * plausible. The whole call stays within `budgetMs`: no retry starts once the budget is spent.
 */
export async function readBeads(directory: string, run: Run, ledger: string, options: ReadOptions = {}): Promise<BeadView> {
  const { scopeId, attempts = 3, pauseMs = 2_000, sleep = realSleep, budgetMs = BD_READ_BUDGET_MS, now = Date.now } = options
  const deadline = now() + budgetMs
  const timeout = () => Math.min(BD_READ_TIMEOUT_MS, deadline - now())
  let view: BeadView = { beads: [], ready: [], blocked: [], ok: false }
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      if (timeout() <= pauseMs) break
      if (pauseMs > 0) await sleep(pauseMs)
    }
    const left = timeout()
    if (left <= 0) break
    view = await readOnce(directory, run, ledger, left)
    if (!view.ok) continue
    const problem = scopeId === undefined ? undefined : await scopeProblem(directory, run, ledger, scopeId, view, timeout)
    if (problem === undefined) return view
    view = { ...view, ok: false, problem }
  }
  return view
}

/** Commits reachable from any ref; a rising count means someone committed. */
export async function commitCount(directory: string, run: Run): Promise<number> {
  const result = await run(directory, "git", ["rev-list", "--all", "--count"])
  const count = Number(result.stdout.trim())
  return result.ok && Number.isFinite(count) ? count : 0
}

/** The fields of a host `SessionInfo` a tick reads. */
export type SessionView = { id?: unknown; title?: unknown; agent?: unknown; parentID?: unknown; location?: { directory?: unknown }; time?: { updated?: unknown; busy?: unknown; idle?: unknown } }

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/**
 * Whether a session is executing. The host stamps `time.busy` when an execution starts and
 * `time.idle` when it ends, and keeps both across restarts.
 */
export function sessionBusy(info: Pick<SessionView, "time"> | undefined): boolean {
  const busy = finite(info?.time?.busy)
  const idle = finite(info?.time?.idle)
  return busy !== undefined && (idle === undefined || busy > idle)
}

/**
 * A child session as a tick sees it. `lastSeen` is the newest event the plugin saw for it since
 * load; without one, the session's own timestamps stand in. Nothing counts from before `armedAt`.
 */
export function childFrom(info: SessionView & { id: string }, lastSeen: number | undefined, armedAt: number, worktree?: RootIdentity): Child {
  const stamped = Math.max(finite(info.time?.updated) ?? 0, finite(info.time?.busy) ?? 0)
  return {
    sessionID: info.id,
    ...(typeof info.title === "string" && info.title ? { title: info.title } : {}),
    ...(typeof info.agent === "string" && info.agent ? { agent: info.agent } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    busy: sessionBusy(info),
    lastActivity: Math.max(lastSeen ?? stamped, armedAt),
  }
}

/** The last event time per session, fed by the event stream, and a parent cache. */
export class Activity {
  readonly #last = new Map<string, number>()
  readonly #parent = new Map<string, string | undefined>()

  constructor(readonly now: () => number = Date.now) {}

  /** Record one host event. */
  observe(event: unknown): void {
    const record = event as { type?: unknown; data?: { sessionID?: unknown } } | null
    const type = record?.type
    const sessionID = record?.data?.sessionID
    if (typeof type !== "string" || typeof sessionID !== "string") return
    if (type === "session.deleted") {
      this.#last.delete(sessionID)
      this.#parent.delete(sessionID)
      return
    }
    this.#last.set(sessionID, this.now())
  }

  /** The newest event time for `sessionID` since load, if any. */
  lastSeen(sessionID: string): number | undefined {
    return this.#last.get(sessionID)
  }

  cachedParent(sessionID: string): string | undefined | null {
    return this.#parent.has(sessionID) ? (this.#parent.get(sessionID) ?? null) : undefined
  }

  rememberParent(sessionID: string, parentID: string | undefined): void {
    this.#parent.set(sessionID, parentID)
  }
}
