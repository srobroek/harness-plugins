import { describe, expect, test } from "bun:test"
import {
  canonicalCheckout,
  evictSessions,
  listProjectSessions,
  type SessionLike,
  sessionRunning,
} from "./session-eviction.ts"

const idle = { busy: 1, idle: 2 }
const session = (id: string, directory: string, time: SessionLike["time"] = idle, projectID = "prj"): SessionLike => ({
  id,
  projectID,
  location: { directory },
  time,
})
const archived = (id: string, directory: string, time: SessionLike["time"] = idle) => session(id, directory, { ...time, archived: 3 })

/** A fake `ctx.session` with pages of `sessions`, recording moves. */
const api = (
  pages: SessionLike[][],
  over: { move?: (input: { sessionID: string; directory: string }) => Promise<void>; list?: () => Promise<unknown>; ignoreProject?: boolean } = {},
) => {
  const moves: Array<{ sessionID: string; directory: string }> = []
  const queries: Array<Record<string, unknown>> = []
  const ignoreProject = over.ignoreProject === true
  return {
    moves,
    queries,
    list:
      over.list ??
      (async (query: { cursor?: string; archived?: boolean; project?: string }) => {
        queries.push(query)
        const index = query.cursor === undefined ? 0 : Number(query.cursor)
        // The real API: `archived: true` lists archived sessions, `archived: false` the others; `project` filters.
        const visible = (pages[index] ?? []).filter((entry) => {
          const isArchived = (entry.time as { archived?: unknown } | undefined)?.archived !== undefined
          if (query.archived === true && !isArchived) return false
          if (query.archived === false && isArchived) return false
          if (query.project !== undefined && entry.projectID !== query.project && !ignoreProject) return false
          return true
        })
        return { data: visible, ...(index + 1 < pages.length ? { cursor: { next: String(index + 1) } } : {}) }
      }),
    move: async (input: { sessionID: string; directory: string }) => {
      await over.move?.(input)
      moves.push(input)
    },
  } as { moves: typeof moves; queries: typeof queries; list: never; move: never }
}

describe("pure helpers", () => {
  test("sessionRunning: busy after idle, or busy with no idle", () => {
    expect(sessionRunning({ time: { busy: 5, idle: 2 } })).toBe(true)
    expect(sessionRunning({ time: { busy: 5 } })).toBe(true)
    expect(sessionRunning({ time: { busy: 1, idle: 2 } })).toBe(false)
    expect(sessionRunning({})).toBe(false)
  })

  test("an archived session counts as idle, whatever its times say", () => {
    expect(sessionRunning({ time: { busy: 9, idle: 2, archived: 3 } })).toBe(false)
  })

  test("canonicalCheckout: the parent of .git, else the fallback", () => {
    expect(canonicalCheckout("/repo/.git", "/fallback")).toBe("/repo")
    expect(canonicalCheckout("/store/repo.git", "/fallback")).toBe("/fallback")
    expect(canonicalCheckout(undefined, "/fallback")).toBe("/fallback")
  })
})

describe("listProjectSessions", () => {
  test("reads every page", async () => {
    const found = await listProjectSessions(api([[session("a", "/x")], [session("b", "/y")]]), "prj")
    expect(found?.map((entry) => entry.id)).toEqual(["a", "b"])
  })

  test("archived sessions are listed too, once", async () => {
    const fake = api([[session("live", "/x"), archived("old", "/y")]])
    const found = await listProjectSessions(fake, "prj")
    expect(found?.map((entry) => entry.id).sort()).toEqual(["live", "old"])
  })

  test("a session of another project is dropped even when the host ignores the project filter", async () => {
    const fake = api([[session("mine", "/x"), session("theirs", "/x", idle, "other")]], { ignoreProject: true })
    const found = await listProjectSessions(fake, "prj")
    expect(found?.map((entry) => entry.id)).toEqual(["mine"])
  })

  test("an error or a malformed page is unknown, not empty", async () => {
    expect(await listProjectSessions(api([], { list: async () => Promise.reject(new Error("down")) }), "prj")).toBeUndefined()
    expect(await listProjectSessions(api([], { list: async () => ({ data: "nope" }) }), "prj")).toBeUndefined()
  })
})

describe("evictSessions", () => {
  const options = { projectID: "prj", directory: "/wt/a", destination: "/repo" }

  test("an idle session inside is moved to the destination, one outside is left", async () => {
    const fake = api([[session("in", "/wt/a"), session("deeper", "/wt/a/pkg"), session("out", "/wt/other")]])
    const result = await evictSessions(fake, options)
    expect(result).toEqual({ ok: true, moved: ["in", "deeper"] })
    expect(fake.moves).toEqual([
      { sessionID: "in", directory: "/repo" },
      { sessionID: "deeper", directory: "/repo" },
    ])
  })

  test("a running session inside blocks, and nothing is moved", async () => {
    const fake = api([[session("idle", "/wt/a"), session("busy", "/wt/a", { busy: 9, idle: 2 })]])
    const result = await evictSessions(fake, options)
    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.reason).toContain("busy is running")
    expect(fake.moves).toEqual([])
  })

  test("a failed move blocks and says which session", async () => {
    const fake = api([[session("in", "/wt/a")]], { move: async () => Promise.reject(new Error("refused")) })
    const result = await evictSessions(fake, options)
    expect(result.ok === false && result.reason).toContain("session in could not be moved")
    expect(result.ok === false && result.reason).toContain("nothing was removed")
  })

  describe("the guard fences each move after the listing", () => {
    test("a session the guard refuses is not moved, and nothing after it is", async () => {
      const fake = api([[session("first", "/wt/a"), session("second", "/wt/a")]])
      const result = await evictSessions(fake, {
        ...options,
        guard: { fresh: async (entry) => (entry.id === "second" ? "second is running in /wt/a" : undefined), started: () => undefined },
      })
      expect(result.ok === false && result.reason).toContain("second is running")
      expect(fake.moves.map((move) => move.sessionID)).toEqual(["first"])
    })

    test("a start seen synchronously after the fresh read refuses the move", async () => {
      const fake = api([[session("in", "/wt/a")]])
      const result = await evictSessions(fake, { ...options, guard: { fresh: async () => undefined, started: () => "in started a new execution" } })
      expect(result.ok === false && result.reason).toContain("in started a new execution")
      expect(fake.moves).toEqual([])
    })

    test("a guard that agrees moves the session as before", async () => {
      const fake = api([[session("in", "/wt/a")]])
      const result = await evictSessions(fake, { ...options, guard: { fresh: async () => undefined, started: () => undefined } })
      expect(result).toEqual({ ok: true, moved: ["in"] })
    })
  })

  test("an incomplete listing blocks: who is inside is unknown", async () => {
    const result = await evictSessions(api([], { list: async () => Promise.reject(new Error("down")) }), options)
    expect(result.ok === false && result.reason).toContain("could not all be listed")
  })

  test("a session on the second page is found", async () => {
    const fake = api([[session("p1", "/elsewhere")], [session("p2", "/wt/a")]])
    expect(await evictSessions(fake, options)).toEqual({ ok: true, moved: ["p2"] })
  })

  test("an archived idle session inside is moved too, so unarchiving it later does not fail", async () => {
    const fake = api([[archived("shelved", "/wt/a"), session("in", "/wt/a")]])
    expect(await evictSessions(fake, options)).toEqual({ ok: true, moved: ["in", "shelved"] })
    expect(fake.moves.map((move) => move.sessionID).sort()).toEqual(["in", "shelved"])
  })

  test("an archived session never blocks as running", async () => {
    const fake = api([[archived("shelved", "/wt/a", { busy: 9, idle: 2 })]])
    expect(await evictSessions(fake, options)).toEqual({ ok: true, moved: ["shelved"] })
  })

  test("excluded sessions (a lane child moved home separately) are skipped", async () => {
    const fake = api([[session("child", "/wt/a"), session("other", "/wt/a")]])
    expect(await evictSessions(fake, { ...options, exclude: new Set(["child"]) })).toEqual({ ok: true, moved: ["other"] })
  })
})
