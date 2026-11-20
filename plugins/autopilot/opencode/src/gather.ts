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

/** `bd list --all`, `bd ready` and `bd blocked`, as JSON. */
export async function readBeads(directory: string, run: Run): Promise<BeadView> {
  const [list, ready, blocked] = await Promise.all([
    run(directory, "bd", ["list", "--all", "--json", "--limit", "0"]),
    run(directory, "bd", ["ready", "--json", "--limit", "0"]),
    run(directory, "bd", ["blocked", "--json"]),
  ])
  const beads = parseArray(list.stdout).flatMap((raw) => {
    const item = raw as Partial<Bead>
    if (typeof item?.id !== "string" || typeof item.status !== "string") return []
    return [{ id: item.id, status: item.status, parent: item.parent ?? null, ...(item.issue_type ? { issue_type: item.issue_type } : {}), labels: item.labels ?? null }]
  })
  return { beads, ready: ids(parseArray(ready.stdout)), blocked: ids(parseArray(blocked.stdout)), ok: list.ok }
}

/** Commits reachable from any ref; a rising count means someone committed. */
export async function commitCount(directory: string, run: Run): Promise<number> {
  const result = await run(directory, "git", ["rev-list", "--all", "--count"])
  const count = Number(result.stdout.trim())
  return result.ok && Number.isFinite(count) ? count : 0
}

/** Activity per session, fed by the event stream. */
export class Activity {
  readonly #busy = new Map<string, boolean>()
  readonly #last = new Map<string, number>()
  readonly #parent = new Map<string, string | undefined>()

  constructor(readonly now: () => number = Date.now) {}

  /** Record one host event. */
  observe(event: unknown): void {
    const record = event as { type?: unknown; data?: { sessionID?: unknown } } | null
    const type = record?.type
    const sessionID = record?.data?.sessionID
    if (typeof type !== "string" || typeof sessionID !== "string") return
    this.#last.set(sessionID, this.now())
    if (type === "session.execution.started") this.#busy.set(sessionID, true)
    else if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted")
      this.#busy.set(sessionID, false)
    else if (type === "session.deleted") {
      this.#busy.delete(sessionID)
      this.#last.delete(sessionID)
    }
  }

  busy(sessionID: string): boolean {
    return this.#busy.get(sessionID) === true
  }

  /** Last activity, or `fallback` for a session seen in no event since load. */
  lastActivity(sessionID: string, fallback: number): number {
    return this.#last.get(sessionID) ?? fallback
  }

  child(sessionID: string, title: string | undefined, fallback: number): Child {
    return { sessionID, ...(title ? { title } : {}), busy: this.busy(sessionID), lastActivity: this.lastActivity(sessionID, fallback) }
  }

  cachedParent(sessionID: string): string | undefined | null {
    return this.#parent.has(sessionID) ? (this.#parent.get(sessionID) ?? null) : undefined
  }

  rememberParent(sessionID: string, parentID: string | undefined): void {
    this.#parent.set(sessionID, parentID)
  }
}
