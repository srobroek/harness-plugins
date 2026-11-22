import { describe, expect, test } from "bun:test"
import { readBeads } from "./gather.ts"
import type { Run } from "./rundir.ts"

const epic = { id: "p-1", status: "open", issue_type: "epic" }
const child = (status: string, id = "p-1.1") => ({ id, status, parent: "p-1" })
const scope = { scopeId: "p-1", pauseMs: 0 }

/** A fake bd: `lists` and `kids` hold one reply per call and the last one repeats; `null` is a failed call. */
function fakeBd(lists: (unknown[] | null)[], kids: (unknown[] | null)[] = [[]]) {
  const calls: string[] = []
  let listCalls = 0
  let kidCalls = 0
  const reply = (replies: (unknown[] | null)[], n: number) => replies[Math.min(n, replies.length - 1)] as unknown[] | null
  const run: Run = async (_cwd, _command, args) => {
    calls.push(args[0] as string)
    const out = args[0] === "list" ? reply(lists, listCalls++) : args[0] === "children" ? reply(kids, kidCalls++) : []
    return out === null ? { ok: false, stdout: "", stderr: "boom" } : { ok: true, stdout: JSON.stringify(out), stderr: "" }
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
})
