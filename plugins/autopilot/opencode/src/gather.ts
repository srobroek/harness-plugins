/** Reading the world for one tick: beads, git and child sessions. */

import type { Run } from "./rundir.ts"
import type { Bead, Child } from "./state.ts"

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

export type BeadView = { beads: Bead[]; ready: string[]; blocked: string[]; ok: boolean }

/** A cold embedded store can take 30-50 s for one read. */
export const BD_READ_TIMEOUT_MS = 90_000

/** `bd list --all`, `bd ready` and `bd blocked`, as JSON. */
export async function readBeads(directory: string, run: Run): Promise<BeadView> {
  const [list, ready, blocked] = await Promise.all([
    run(directory, "bd", ["list", "--all", "--brief", "--json", "--limit", "0"], BD_READ_TIMEOUT_MS),
    run(directory, "bd", ["ready", "--brief", "--json", "--limit", "0"], BD_READ_TIMEOUT_MS),
    run(directory, "bd", ["blocked", "--json"], BD_READ_TIMEOUT_MS),
  ])
  const beads = parseArray(list.stdout).flatMap((raw) => {
    const item = raw as Partial<Bead>
    if (typeof item?.id !== "string" || typeof item.status !== "string") return []
    return [{ id: item.id, status: item.status, parent: item.parent ?? null, ...(item.issue_type ? { issue_type: item.issue_type } : {}), labels: item.labels ?? null }]
  })
  return { beads, ready: ids(parseArray(ready.stdout)), blocked: ids(parseArray(blocked.stdout)), ok: list.ok && ready.ok && blocked.ok }
}

/** Commits reachable from any ref; a rising count means someone committed. */
export async function commitCount(directory: string, run: Run): Promise<number> {
  const result = await run(directory, "git", ["rev-list", "--all", "--count"])
  const count = Number(result.stdout.trim())
  return result.ok && Number.isFinite(count) ? count : 0
}

/** The fields of a host `SessionInfo` a tick reads. */
export type SessionView = { id?: unknown; title?: unknown; agent?: unknown; parentID?: unknown; time?: { updated?: unknown; busy?: unknown; idle?: unknown } }

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
export function childFrom(info: SessionView & { id: string }, lastSeen: number | undefined, armedAt: number): Child {
  const stamped = Math.max(finite(info.time?.updated) ?? 0, finite(info.time?.busy) ?? 0)
  return {
    sessionID: info.id,
    ...(typeof info.title === "string" && info.title ? { title: info.title } : {}),
    ...(typeof info.agent === "string" && info.agent ? { agent: info.agent } : {}),
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
