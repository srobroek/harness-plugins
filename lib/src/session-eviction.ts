/**
 * Move sessions out of a worktree before it is removed.
 *
 * OpenCode resolves a session's location for every request that touches the session (the TUI
 * listing it, a wake or drain, a plugin calling `session.get`). A session whose directory is gone
 * fails all of them with "Location not found". So a remover moves every idle session whose location
 * is the target, or inside it, to the repository's canonical checkout first, and refuses to remove
 * if a session there is running, or if any lookup or move fails.
 *
 * The adapter takes the few `ctx.session` calls it needs, so delivery and subagent-worktree (which
 * bundle separate copies of this lib) both use it.
 */

import { basename, dirname } from "node:path"
import { insideDirectory } from "./session-lanes.ts"
import { canonicalDirectory } from "./worktree-claims.ts"

export type SessionLike = {
  id: string
  projectID?: string
  location?: { directory?: string }
  time?: { busy?: unknown; idle?: unknown; archived?: unknown }
}

export type SessionApi = {
  list: (query: never) => Promise<unknown>
  move: (input: never) => Promise<unknown>
}

const MAX_PAGES = 100

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
export function sessionRunning(session: Pick<SessionLike, "time">): boolean {
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

/** One pass over the listing with `archived` fixed, all pages; undefined when a page cannot be read. */
async function listPass(api: Pick<SessionApi, "list">, projectID: string | undefined, archived: boolean): Promise<SessionLike[] | undefined> {
  const found: SessionLike[] = []
  let query: Record<string, unknown> = { ...(projectID === undefined ? {} : { project: projectID }), archived, limit: 100 }
  try {
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const page = (await api.list(query as never)) as { data?: unknown; cursor?: { next?: string } } | undefined
      if (!page || !Array.isArray(page.data)) return undefined
      for (const raw of page.data) {
        const session = raw as SessionLike
        if (typeof session?.id === "string") found.push(session)
      }
      const next = page.cursor?.next
      if (!next) return found
      query = { cursor: next }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Every session of the project, archived ones included (an archived session left in a removed worktree
 * keeps its dead location, and unarchiving it later fails), all pages. A session that names another
 * project is dropped even if the host ignored the filter. `undefined` when any page cannot be read or
 * the listing does not end within the page cap: an incomplete answer is unknown, never "none".
 */
export async function listProjectSessions(api: Pick<SessionApi, "list">, projectID: string | undefined): Promise<SessionLike[] | undefined> {
  const live = await listPass(api, projectID, false)
  const shelved = live === undefined ? undefined : await listPass(api, projectID, true)
  if (live === undefined || shelved === undefined) return undefined
  const byId = new Map<string, SessionLike>()
  for (const session of [...live, ...shelved]) {
    if (projectID !== undefined && session.projectID !== undefined && session.projectID !== projectID) continue
    byId.set(session.id, session)
  }
  return [...byId.values()]
}

export type Eviction = { ok: true; moved: string[] } | { ok: false; reason: string }

/**
 * Run under the removal lock, right before the removal. Running sessions block it; each idle session in
 * the target is moved to `destination`; a failed lookup or move blocks it. `exclude` skips sessions the
 * caller already handled (a lane's own child, moved home separately).
 */
export async function evictSessions(
  api: SessionApi,
  options: {
    projectID: string | undefined
    directory: string
    destination: string
    exclude?: ReadonlySet<string>
    /**
     * The listing is a snapshot and each move is awaited, so a session that starts after the listing would still be
     * moved. When given, each move is fenced: `fresh` reads the session again (a reason to refuse, or undefined), then
     * `started` is read synchronously, with nothing awaited between it and the move call.
     */
    guard?: { fresh: (session: SessionLike) => Promise<string | undefined>; started: (session: SessionLike) => string | undefined }
  },
): Promise<Eviction> {
  const sessions = await listProjectSessions(api, options.projectID)
  if (sessions === undefined) return { ok: false, reason: `the sessions of the project could not all be listed, so who is in ${options.directory} is unknown` }
  const target = canonicalDirectory(options.directory)
  const inside = sessions.filter((session) => {
    if (options.exclude?.has(session.id)) return false
    const where = session.location?.directory
    return typeof where === "string" && insideDirectory(canonicalDirectory(where), target)
  })
  const running = inside.find(sessionRunning)
  if (running) return { ok: false, reason: `session ${running.id} is running in ${options.directory}` }
  const moved: string[] = []
  for (const session of inside) {
    if (options.guard) {
      const why = (await options.guard.fresh(session)) ?? options.guard.started(session)
      if (why !== undefined) return { ok: false, reason: `${why}; nothing was removed` }
    }
    try {
      await api.move({ sessionID: session.id, directory: options.destination } as never)
      moved.push(session.id)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `session ${session.id} could not be moved out of ${options.directory} (${why}); nothing was removed` }
    }
  }
  return { ok: true, moved }
}
