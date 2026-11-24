import { expect, test } from "bun:test"
import { newRunState } from "./state.ts"
import { decodeRunState } from "./state-schema.ts"

const fresh = () => newRunState({ runId: "20261120-1400-abcd", sessionID: "ses_lead", directory: "/repo", options: {}, scope: { kind: "queue" }, now: 1 })

/** A state as JSON gives it back, so the decoder sees what it reads from disk. */
const onDisk = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value))

test("a run state decodes to itself", () => {
  const state = { ...fresh(), phase: "running" as const, worktrees: [{ path: "/w", real: "/w", dev: "1", ino: "2" }], stop: { journalLength: 3, summary: true, handoff: "t-1" } }
  expect(decodeRunState(onDisk(state))).toEqual({ ok: true, state })
})

test("each scope kind decodes, and an unknown one is refused", () => {
  for (const scope of [{ kind: "queue" }, { kind: "bead", id: "p-1" }, { kind: "goal", text: "ship it" }]) expect(decodeRunState(onDisk({ ...fresh(), scope })).ok).toBe(true)
  expect(decodeRunState(onDisk({ ...fresh(), scope: { kind: "epic", id: "p-1" } })).ok).toBe(false)
  expect(decodeRunState(onDisk({ ...fresh(), scope: { kind: "bead" } })).ok).toBe(false)
})

test("a key the schema does not name is dropped, at every depth", () => {
  const decoded = decodeRunState({ ...onDisk(fresh()), extra: 1, tick: { kind: "none", stray: true } })
  expect(decoded.ok).toBe(true)
  if (!decoded.ok) return
  expect("extra" in decoded.state).toBe(false)
  expect(decoded.state.tick).toEqual({ kind: "none" })
})

test("a missing required key is refused and named", () => {
  const { generation: _, ...rest } = onDisk(fresh())
  expect(decodeRunState(rest)).toEqual({ ok: false, reason: "generation: expected a value (missing)" })
})

test("wrong types are refused with the path to the bad value", () => {
  expect(decodeRunState({ ...onDisk(fresh()), version: 2 })).toMatchObject({ ok: false, reason: expect.stringContaining("version") })
  expect(decodeRunState({ ...onDisk(fresh()), phase: "paused" })).toMatchObject({ ok: false, reason: expect.stringContaining("phase") })
  expect(decodeRunState({ ...onDisk(fresh()), options: { ...fresh().options, allow: ["merge", "everything"] } })).toEqual({ ok: false, reason: expect.stringContaining("options.allow[1]") })
  expect(decodeRunState({ ...onDisk(fresh()), attempts: { "p-1": "3" } })).toEqual({ ok: false, reason: expect.stringContaining("attempts.p-1") })
  expect(decodeRunState({ ...onDisk(fresh()), children: { ses_a: { step: "wait" } } })).toEqual({ ok: false, reason: expect.stringContaining("children.ses_a.step") })
  expect(decodeRunState({ ...onDisk(fresh()), beads: { ...fresh().beads, open: "p-1" } })).toEqual({ ok: false, reason: expect.stringContaining("beads.open") })
})

test("an optional key may be absent but not present with the wrong type", () => {
  expect(decodeRunState({ ...onDisk(fresh()), deadline: "soon" }).ok).toBe(false)
  expect(decodeRunState({ ...onDisk(fresh()), ledger: null }).ok).toBe(false)
  expect(decodeRunState({ ...onDisk(fresh()), stop: { journalLength: 1, summary: false } }).ok).toBe(true)
})

test("a value that is not an object, or is an array, is not a run state", () => {
  for (const value of [null, 1, "state", [], [onDisk(fresh())]]) expect(decodeRunState(value).ok).toBe(false)
  expect(decodeRunState({ ...onDisk(fresh()), tick: [] }).ok).toBe(false)
})
