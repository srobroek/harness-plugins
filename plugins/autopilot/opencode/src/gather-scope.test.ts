import { describe, expect, test } from "bun:test"
import { readBeads } from "./gather.ts"
import type { Run } from "./rundir.ts"

const epic = { id: "p-1", status: "open", issue_type: "epic" }
const child = (status: string, id = "p-1.1") => ({ id, status, parent: "p-1" })
const scope = { scopeId: "p-1", pauseMs: 0 }

/** A fake bd: `lists` and `kids` hold one reply per call and the last one repeats; `null` is a failed call, a string is raw output. */
function fakeBd(lists: (unknown[] | null)[], kids: (unknown[] | string | null)[] = [[]]) {
  const calls: string[] = []
  let listCalls = 0
  let kidCalls = 0
  const reply = <T,>(replies: T[], n: number) => replies[Math.min(n, replies.length - 1)] as T
  const run: Run = async (_cwd, _command, args) => {
    calls.push(args[0] as string)
    const out = args[0] === "list" ? reply(lists, listCalls++) : args[0] === "children" ? reply(kids, kidCalls++) : []
    if (out === null) return { ok: false, stdout: "", stderr: "boom" }
    return { ok: true, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "" }
  }
  return { run, calls }
}

describe("readBeads with a bead scope", () => {
  test("an empty list for an existing epic is retried, and the retry that sees the epic is used", async () => {
    const { run } = fakeBd([[], [epic, child("open")]])
    const view = await readBeads("/repo", run, "/l/.beads", scope)
    expect(view.ok).toBe(true)
    expect(view.beads.map((bead) => bead.id)).toEqual(["p-1", "p-1.1"])
  })

  test("a list that stays empty is an unknown read that names the scope, never a finished one", async () => {
    const { run } = fakeBd([[]])
    const view = await readBeads("/repo", run, "/l/.beads", scope)
    expect(view.ok).toBe(false)
    expect(view.problem).toContain("p-1")
  })

  test("a failed list is retried once and the next read stands", async () => {
    const { run } = fakeBd([null, [epic, child("closed")]], [[child("closed")]])
    expect((await readBeads("/repo", run, "/l/.beads", scope)).ok).toBe(true)
  })

  test("a list without open work while bd children shows open work is unknown after three reads", async () => {
    const { run, calls } = fakeBd([[epic]], [[child("open"), child("open", "p-1.2")]])
    const view = await readBeads("/repo", run, "/l/.beads", scope)
    expect(view.ok).toBe(false)
    expect(view.problem).toContain("2 open")
    expect(calls.filter((call) => call === "list")).toHaveLength(3)
  })

  test("a failed bd children leaves a list without open work unconfirmed", async () => {
    const { run } = fakeBd([[epic, child("closed")]], [null])
    expect((await readBeads("/repo", run, "/l/.beads", scope)).ok).toBe(false)
  })

  test("a scope whose children are closed in both reads is finished and the read is complete", async () => {
    const { run } = fakeBd([[epic, child("closed")]], [[child("closed")]])
    expect((await readBeads("/repo", run, "/l/.beads", scope)).ok).toBe(true)
  })

  test("a list that already shows open work needs no bd children call", async () => {
    const { run, calls } = fakeBd([[epic, child("open")]])
    expect((await readBeads("/repo", run, "/l/.beads", scope)).ok).toBe(true)
    expect(calls).not.toContain("children")
  })

  test("without a scope bead the reads are as before: no bd children call, one attempt on success", async () => {
    const { run, calls } = fakeBd([[]])
    expect((await readBeads("/repo", run, "/l/.beads", { pauseMs: 0 })).ok).toBe(true)
    expect(calls.filter((call) => call === "list")).toHaveLength(1)
  })

  test("an open child epic or handoff bead in bd children does not contradict a list without open work", async () => {
    const childEpic = { id: "p-1.2", status: "open", parent: "p-1", issue_type: "epic" }
    const handoff = { id: "p-1.3", status: "open", parent: "p-1", labels: ["autopilot-handoff"] }
    const { run } = fakeBd([[epic, child("closed")]], [[child("closed"), childEpic, handoff]])
    const view = await readBeads("/repo", run, "/l/.beads", scope)
    expect(view.ok).toBe(true)
    expect(view.problem).toBeUndefined()
  })

  test.each([
    ["not JSON", "oops"],
    ["not a list", '{"error":"no such bead"}'],
    ["an entry without a status", '[{"id":"p-1.1"}]'],
  ])("bd children answering %s leaves a list without open work unconfirmed", async (_name, raw) => {
    const { run } = fakeBd([[epic, child("closed")]], [raw])
    const view = await readBeads("/repo", run, "/l/.beads", scope)
    expect(view.ok).toBe(false)
    expect(view.problem).toContain("not a list of beads")
  })

  test("a bd warning before the children list is skipped", async () => {
    const { run } = fakeBd([[epic, child("closed")]], [`warning: slow store\n${JSON.stringify([child("closed")])}`])
    expect((await readBeads("/repo", run, "/l/.beads", scope)).ok).toBe(true)
  })

  test("no retry reads until the pause has finished", async () => {
    const { run, calls } = fakeBd([[]])
    const lists = () => calls.filter((call) => call === "list").length
    let release = () => {}
    let started = () => {}
    const sleeping = new Promise<void>((done) => {
      started = done
    })
    const pauses: number[] = []
    const sleep = (ms: number) => {
      pauses.push(ms)
      started()
      return new Promise<void>((done) => {
        release = done
      })
    }
    const pending = readBeads("/repo", run, "/l/.beads", { scopeId: "p-1", attempts: 2, pauseMs: 2_000, sleep })
    await sleeping
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
    expect(lists()).toBe(1)
    release()
    expect((await pending).ok).toBe(false)
    expect(lists()).toBe(2)
    expect(pauses).toEqual([2_000])
  })

  /** A bd whose `slow` command uses up its whole timeout and fails; the rest answer at once with a closed scope. */
  function clockedBd(slow: string, sleepExtraMs = 0) {
    let clock = 0
    const timeouts: Record<string, number[]> = {}
    const run: Run = async (_cwd, _command, args, timeout) => {
      const name = args[0] as string
      timeouts[name] = [...(timeouts[name] ?? []), timeout as number]
      if (name === slow) {
        clock += timeout as number
        return { ok: false, stdout: "", stderr: "timed out" }
      }
      const out = name === "list" ? [epic, child("closed")] : name === "children" ? [child("closed")] : []
      return { ok: true, stdout: JSON.stringify(out), stderr: "" }
    }
    const sleep = async (ms: number) => {
      clock += ms + sleepExtraMs
    }
    return { run, sleep, timeouts, now: () => clock }
  }

  test.each(["list", "ready", "blocked", "children"])("a slow bd %s gets only the time left, and the reads stop at the budget", async (slow) => {
    const bd = clockedBd(slow)
    const view = await readBeads("/repo", bd.run, "/l/.beads", { scopeId: "p-1", budgetMs: 180_000, now: bd.now, sleep: bd.sleep })
    expect(view.ok).toBe(false)
    expect(bd.timeouts[slow]).toEqual([90_000, 88_000])
    expect(bd.now()).toBe(180_000)
  })

  test("a budget spent by the list leaves no time for bd children, and the scope is unconfirmed", async () => {
    const bd = clockedBd("none")
    const run: Run = async (...args) => {
      const reply = await bd.run(...args)
      if (args[2][0] === "list") await bd.sleep(180_000)
      return reply
    }
    const view = await readBeads("/repo", run, "/l/.beads", { scopeId: "p-1", budgetMs: 180_000, now: bd.now, sleep: bd.sleep })
    expect(view.ok).toBe(false)
    expect(view.problem).toContain("no time was left")
    expect(bd.timeouts.children).toBeUndefined()
  })

  test("a pause that oversleeps the budget starts no further read", async () => {
    const bd = clockedBd("list", 100_000)
    const view = await readBeads("/repo", bd.run, "/l/.beads", { scopeId: "p-1", budgetMs: 180_000, now: bd.now, sleep: bd.sleep })
    expect(view.ok).toBe(false)
    expect(bd.timeouts.list).toEqual([90_000])
  })
})
