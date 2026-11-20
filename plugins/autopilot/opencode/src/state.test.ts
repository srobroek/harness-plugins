import { describe, expect, test } from "bun:test"
import type { Scope } from "./args.ts"
import type { JournalEntry } from "./journal.ts"
import { type Bead, type Child, type ChildState, newRunState, type RunState, renderPing, type Snapshot, STALL_MS, type StallStep, stallStep, tick, tickPrompt } from "./state.ts"

const T0 = new Date(2026, 10, 20, 14, 32).getTime()
const MIN = 60_000

function running(scope: Scope, patch: Partial<RunState> = {}): RunState {
  return { ...newRunState({ runId: "r1", sessionID: "ses_lead", directory: "/repo", options: { lanes: 4 }, scope, now: T0 }), phase: "running", armedAt: T0, commits: 10, ...patch }
}

function snapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return { now: T0, beads: [], ready: [], blocked: [], commits: 10, children: [], journal: [], leadBusy: false, ...patch }
}

const bead = (id: string, status: string, extra: Partial<Bead> = {}): Bead => ({ id, status, ...extra })
const child = (sessionID: string, busy: boolean, lastActivity: number, extra: Partial<Child> = {}): Child => ({ sessionID, busy, lastActivity, ...extra })
const entry = (type: JournalEntry["type"], extra: Partial<JournalEntry> = {}): JournalEntry => ({ ts: "t", type, summary: type, ...extra })

describe("tick diff", () => {
  test("reports beads that moved from blocked to ready", () => {
    const previous = running({ kind: "queue" }, { beads: { open: ["a", "b"], ready: [], blocked: ["a", "b"], inProgress: [], closed: [] }, commits: 10 })
    const result = tick(previous, snapshot({ beads: [bead("a", "open"), bead("b", "open")], ready: ["a"], blocked: ["b"] }))
    expect(result.newlyUnblocked).toEqual(["a"])
  })

  test.each([
    ["a bead closed", { beads: [bead("a", "closed"), bead("b", "open")], ready: ["b"] }],
    ["a commit landed", { beads: [bead("a", "open"), bead("b", "open")], ready: ["a", "b"], commits: 11 }],
    ["a progress entry was logged", { beads: [bead("a", "open"), bead("b", "open")], ready: ["a", "b"], journal: [entry("progress")] }],
    ["a lane finished", { beads: [bead("a", "open"), bead("b", "open")], ready: ["a", "b"], children: [child("ses_lane", false, T0)] }],
  ])("counts progress when %s and resets the idle count", (_name, patch) => {
    const previous = running({ kind: "queue" }, { idleTicks: 3, commits: 10, beads: { open: ["a", "b"], ready: ["a", "b"], blocked: [], inProgress: [], closed: [] } })
    const result = tick(previous, snapshot(patch))
    expect(result.progress).toBe(true)
    expect(result.state.idleTicks).toBe(0)
  })

  test("a tick with nothing new adds one idle tick", () => {
    const previous = running({ kind: "queue" }, { idleTicks: 2, beads: { open: ["a"], ready: ["a"], blocked: [], inProgress: [], closed: [] } })
    const result = tick(previous, snapshot({ beads: [bead("a", "open")], ready: ["a"] }))
    expect(result.progress).toBe(false)
    expect(result.state.idleTicks).toBe(3)
  })

  test("counts a bead scope's descendants only, and never epics or handoff beads", () => {
    const beads = [
      bead("p-1", "open", { issue_type: "epic" }),
      bead("p-1.1", "open"),
      bead("p-2", "open", { parent: "p-1" }),
      bead("p-3", "open"),
      bead("p-4", "open", { labels: ["autopilot-handoff"], parent: "p-1" }),
    ]
    const result = tick(running({ kind: "bead", id: "p-1" }), snapshot({ beads, ready: ["p-1.1", "p-2", "p-3"] }))
    expect(result.state.beads.open).toEqual(["p-1.1", "p-2"])
    expect(result.state.beads.ready).toEqual(["p-1.1", "p-2"])
  })

  test("parks a bead on its third attempt without closing", () => {
    const previous = running({ kind: "queue" }, { attempts: { a: 2 }, beads: { open: ["a", "b"], ready: ["b"], blocked: [], inProgress: [], closed: [] } })
    const result = tick(previous, snapshot({ beads: [bead("a", "in_progress"), bead("b", "open")], ready: ["b"] }))
    expect(result.actions).toContainEqual({ kind: "park", item: "a", reason: "attempted 3 times without closing" })
    expect(result.state.parked).toEqual(["a"])
  })

  test("parks the bead that hit the same error signature twice in a row", () => {
    const journal = [entry("issue", { bead: "a", error: "ENOENT x" }), entry("issue", { bead: "a", error: "ENOENT x" })]
    const previous = running({ kind: "queue" }, { beads: { open: ["a", "b"], ready: ["a", "b"], blocked: [], inProgress: [], closed: [] } })
    const result = tick(previous, snapshot({ beads: [bead("a", "open"), bead("b", "open")], ready: ["a", "b"], journal }))
    expect(result.actions).toContainEqual({ kind: "park", item: "a", reason: "same error twice: ENOENT x" })
  })
})

describe("stall ladder", () => {
  const stalled = (at: number) => child("ses_lane", true, at, { title: "lane a" })

  test.each<[string, Child, ChildState | undefined, StallStep | undefined]>([
    ["active lane", child("ses_lane", true, T0 - 11 * MIN), undefined, undefined],
    ["first silence of 12 minutes", stalled(T0 - STALL_MS), undefined, "nudge"],
    ["nudged less than 12 minutes ago", stalled(T0 - 20 * MIN), { step: "nudge" as const, stepAt: T0 - 5 * MIN }, undefined],
    ["nudged 12 minutes ago", stalled(T0 - 30 * MIN), { step: "nudge" as const, stepAt: T0 - STALL_MS }, "respawn"],
    ["respawned 12 minutes ago", stalled(T0 - 50 * MIN), { step: "respawn" as const, stepAt: T0 - STALL_MS }, "park"],
    ["already parked", stalled(T0 - 90 * MIN), { step: "park" as const, stepAt: T0 - 30 * MIN }, undefined],
  ])("%s", (_name, lane, previous, expected) => {
    expect(stallStep(lane, previous, T0)).toBe(expected)
  })

  test("a tick nudges a silent busy lane and parks it after a respawn", () => {
    const beads = { open: ["a"], ready: ["a"], blocked: [], inProgress: [], closed: [] }
    const first = tick(running({ kind: "queue" }, { beads }), snapshot({ beads: [bead("a", "open")], ready: ["a"], children: [stalled(T0 - STALL_MS)] }))
    expect(first.actions).toEqual([{ kind: "nudge", sessionID: "ses_lane", title: "lane a" }])
    const later = { ...first.state, children: { ses_lane: { step: "respawn" as const, stepAt: T0 }, }, }
    const third = tick(later, snapshot({ now: T0 + STALL_MS, beads: [bead("a", "open")], ready: ["a"], children: [stalled(T0 - STALL_MS)] }))
    expect(third.actions).toContainEqual({ kind: "park", item: "lane a", reason: "lane ses_lane stalled after nudge and respawn" })
  })
})

describe("stop conditions", () => {
  const open = (ids: string[]) => ({ open: ids, ready: [], blocked: [], inProgress: [], closed: [] })

  test.each([
    ["stop requested", running({ kind: "queue" }, { stopRequested: true, beads: open(["a"]) }), snapshot({ beads: [bead("a", "open")], ready: ["a"] }), "stop requested"],
    ["logged stop entry", running({ kind: "queue" }, { beads: open(["a"]) }), snapshot({ beads: [bead("a", "open")], ready: ["a"], journal: [entry("stop", { summary: "PR open" })] }), "logged: PR open"],
    ["deadline", running({ kind: "queue" }, { deadline: T0, beads: open(["a"]) }), snapshot({ beads: [bead("a", "open")], ready: ["a"] }), "budget or deadline reached"],
    ["scope finished", running({ kind: "bead", id: "p-1" }, { beads: open(["p-1"]) }), snapshot({ beads: [bead("p-1", "closed")] }), "scope finished"],
    ["all blocked", running({ kind: "queue" }, { beads: open(["a"]) }), snapshot({ beads: [bead("a", "open")], blocked: ["a"] }), "everything left is blocked or parked"],
    ["six idle ticks", running({ kind: "queue" }, { idleTicks: 5, beads: open(["a"]) }), snapshot({ beads: [bead("a", "open")], ready: ["a"] }), "6 ticks without progress"],
  ])("%s", (_name, previous, now, reason) => {
    expect(tick(previous, now).stop).toBe(reason)
  })

  test("a busy lane keeps an all-blocked run going", () => {
    const result = tick(running({ kind: "queue" }, { beads: open(["a"]) }), snapshot({ beads: [bead("a", "open")], blocked: ["a"], children: [child("ses_lane", true, T0)] }))
    expect(result.stop).toBeUndefined()
  })

  test("a goal run does not stop because unrelated beads are blocked", () => {
    const result = tick(running({ kind: "goal", text: "fix the flaky tests" }), snapshot({ beads: [bead("x-1", "open")], blocked: ["x-1"] }))
    expect(result.stop).toBeUndefined()
  })
})

describe("ping line", () => {
  test("renders lanes, counts, unblocked and time left", () => {
    const ping = renderPing({
      now: T0,
      busyLanes: 2,
      lanes: 4,
      beads: { open: [], ready: ["a", "b", "c", "d"], blocked: ["e", "f"], inProgress: [], closed: [] },
      newlyUnblocked: 1,
      parked: 1,
      deadline: T0 + 72 * MIN,
    })
    expect(ping).toBe("♥ 14:32 · 2/4 lanes · ready 4 · blocked 2 (+1 unblocked) · parked 1 · 1h12m left")
  })

  test("busy read-only subagents take no write lane", () => {
    const children = [child("ses_a", true, T0, { agent: "coder" }), child("ses_b", true, T0, { agent: "explore" }), child("ses_c", false, T0, { agent: "coder" })]
    const result = tick(running({ kind: "goal", text: "x" }), snapshot({ children }))
    expect(result.ping.startsWith("♥ 14:32 · 1/4 lanes ·")).toBe(true)
  })

  test("a tick that acted adds one line and the prompt lists the actions", () => {
    const result = tick(running({ kind: "queue" }, { attempts: { a: 2 }, beads: open2() }), snapshot({ beads: [bead("a", "in_progress"), bead("b", "open")], ready: ["b"] }))
    expect(result.ping.split("\n")).toEqual(["♥ 14:32 · 0/4 lanes · ready 1 · blocked 0 · parked 1", "↳ park a (attempted 3 times without closing)"])
    expect(tickPrompt(result)).toContain("Actions due: park a (attempted 3 times without closing).")
  })
})

function open2() {
  return { open: ["a", "b"], ready: ["b"], blocked: [], inProgress: [], closed: [] }
}
