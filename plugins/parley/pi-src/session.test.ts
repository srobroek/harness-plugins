import { describe, expect, test } from "bun:test"
import type { StoredRound } from "../shared/persist.ts"
import type { Question } from "../shared/questions.ts"
import { RELOADED_REASON, type Round } from "../shared/rounds.ts"
import { type Closure, type Deps, deliveryText, InputError, latestRounds, NO_UI, PiParley } from "./session.ts"

const questions: Question[] = [
  { id: "db", title: "Database?", kind: "pick_one", options: [{ id: "sqlite", label: "SQLite" }, { id: "pg", label: "Postgres" }], recommended: "sqlite" },
  { id: "retries", title: "Retries?", kind: "slider", min: 0, max: 5, recommended: 3 },
]

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(overrides: Partial<Deps> = {}) {
  const stored: StoredRound[] = []
  const delivered: string[] = []
  const presented: Round[] = []
  const closures: Closure[] = []
  const parley = new PiParley({
    sessionID: "s1",
    directory: "/repo",
    persist: (round) => stored.push(round),
    deliver: (text) => delivered.push(text),
    present: (round) => presented.push(round),
    closed: (closure) => closures.push(closure),
    ...overrides,
  })
  return { parley, stored, delivered, presented, closures }
}

const ui = { ui: true }

describe("PiParley.ask", () => {
  test("returns unavailable at once without a panel, after checking the questions", async () => {
    const { parley, presented } = harness()
    const { result } = await parley.ask({ questions }, { ui: false })
    expect(result).toEqual({ status: "unavailable", reason: NO_UI, answers: [], pending: [] })
    expect(presented).toEqual([])
    await expect(parley.ask({ questions: [{ id: "x", title: "", kind: "pick_one" } as Question] }, { ui: false })).rejects.toBeInstanceOf(InputError)
  })

  test("returns unavailable when PARLEY_DISABLE turned parley off", async () => {
    const { parley } = harness({ disabled: true })
    expect((await parley.ask({ questions }, ui)).result.reason).toBe("disabled")
  })

  test("waits for the submission and reports accepted and changed answers", async () => {
    const { parley, presented, closures } = harness()
    const asked = parley.ask({ questions, title: "Plan" }, ui)
    await tick()
    const round = presented[0] as Round
    expect(round.title).toBe("Plan")
    expect(parley.submit(round.id, [{ id: "db", status: "accepted" }, { id: "retries", status: "answered", value: { value: 4 }, note: "flaky network" }])).toEqual([])
    const { result } = await asked
    expect(result.status).toBe("submitted")
    expect(result.answers).toEqual([
      { id: "db", status: "accepted", value: { selected: "sqlite" }, accepted_recommendation: true },
      { id: "retries", status: "answered", value: { value: 4 }, accepted_recommendation: false, note: "flaky network" },
    ])
    expect(closures.map((closure) => closure.round.status)).toEqual(["submitted"])
  })

  test("keeps the round open on a rejected submission", async () => {
    const { parley, presented } = harness()
    void parley.ask({ questions }, ui)
    await tick()
    const round = presented[0] as Round
    expect(parley.submit(round.id, [{ id: "db", status: "answered", value: { selected: "mysql" } }])).toEqual(["db: selected must be an option id"])
    expect(parley.current()?.id).toBe(round.id)
  })

  test("wait none returns open; parley_wait then collects the answers", async () => {
    const { parley, presented } = harness()
    const { result } = await parley.ask({ questions, wait: "none" }, ui)
    expect(result.status).toBe("open")
    expect(result.pending).toEqual(["db", "retries"])
    const waiting = parley.wait({}, ui)
    parley.submit((presented[0] as Round).id, [{ id: "db", status: "deferred" }])
    const waited = (await waiting).result
    expect(waited.status).toBe("submitted")
    expect(waited.answers).toEqual([{ id: "db", status: "deferred" }])
    expect(waited.pending).toEqual(["retries"])
  })

  test("a second ask joins the open round and returns only its own questions", async () => {
    const { parley, presented } = harness()
    void parley.ask({ questions: [questions[0] as Question], wait: "none" }, ui)
    await tick()
    const joined = parley.ask({ questions: [questions[1] as Question] }, ui)
    await tick()
    const round = presented[0] as Round
    expect(presented.map((shown) => shown.id)).toEqual([round.id, round.id])
    parley.submit(round.id, [{ id: "db", status: "accepted" }, { id: "retries", status: "accepted" }])
    expect((await joined).result.answers.map((answer) => answer.id)).toEqual(["retries"])
  })

  test("a timeout closes the round as timeout and tells the user", async () => {
    const { parley, closures } = harness()
    const { result } = await parley.ask({ questions, timeout_s: 0.02 }, ui)
    expect(result.status).toBe("timeout")
    expect(closures[0]?.round.reason).toBe("timeout")
  })

  test("an interrupted call cancels its round", async () => {
    const { parley, closures } = harness()
    const abort = new AbortController()
    const asked = parley.ask({ questions }, { ui: true, signal: abort.signal })
    await tick()
    abort.abort()
    expect((await asked).result).toMatchObject({ status: "cancelled", reason: "aborted" })
    expect(closures[0]?.round.reason).toBe("aborted")
  })

  test("a dismissal returns cancelled with every question pending", async () => {
    const { parley, presented } = harness()
    const asked = parley.ask({ questions }, ui)
    await tick()
    parley.dismiss((presented[0] as Round).id)
    expect((await asked).result).toMatchObject({ status: "cancelled", reason: "user_closed", pending: ["db", "retries"] })
  })

  test("reports progress while it waits", async () => {
    const { parley, presented } = harness()
    const reports: string[] = []
    const asked = parley.ask({ questions }, { ui: true, progress: (round, answered, total) => reports.push(`${round.number}:${answered}/${total}`) })
    await tick()
    parley.submit((presented[0] as Round).id, [{ id: "db", status: "accepted" }])
    await asked
    expect(reports[0]).toBe("1:0/2")
  })
})

describe("no panel after all", () => {
  test("a withdrawn round answers its calls with unavailable", async () => {
    const { parley, closures } = harness()
    const asked = parley.ask({ questions }, ui)
    await tick()
    parley.withdraw(parley.current()?.id as string)
    expect((await asked).result).toMatchObject({ status: "unavailable", reason: NO_UI, round: 1, pending: ["db", "retries"] })
    expect(closures[0]?.round.reason).toBe(NO_UI)
  })

  test("a host that withdraws inside present never leaves the call waiting", async () => {
    let parley: PiParley | undefined
    const own = harness({ present: (round) => parley?.withdraw(round.id) })
    parley = own.parley
    expect((await parley.ask({ questions }, ui)).result).toMatchObject({ status: "unavailable", reason: NO_UI })
  })

  test("parley_wait without a panel returns unavailable instead of waiting on an open round", async () => {
    const { parley } = harness()
    await parley.ask({ questions, wait: "none" }, ui)
    expect((await parley.wait({}, { ui: false })).result).toMatchObject({ status: "unavailable", reason: NO_UI, pending: ["db", "retries"] })
    expect(parley.current()).toBeDefined()
  })
})

describe("PiParley.end", () => {
  test("closes the open round with the agent's message", async () => {
    const { parley, closures } = harness()
    const asked = parley.ask({ questions }, ui)
    await tick()
    expect(parley.end("All settled")).toEqual({ ok: true, closed: 1 })
    expect(closures[0]).toMatchObject({ message: "All settled" })
    expect((await asked).result.status).toBe("cancelled")
    expect(parley.end()).toEqual({ ok: true, closed: 0 })
  })
})

describe("persistence", () => {
  test("every change is written, and the latest entry per round wins on restore", async () => {
    const first = harness()
    const asked = first.parley.ask({ questions, wait: "none" }, ui)
    await asked
    const roundID = (first.presented[0] as Round).id
    expect(first.stored.at(-1)).toMatchObject({ id: roundID, status: "open", directory: "/repo" })
    expect(latestRounds(first.stored)).toHaveLength(1)

    const second = harness()
    second.parley.restore(first.stored)
    expect(second.parley.current()?.id).toBe(roundID)
  })

  test("a restored round no call waits on sends its answers to the agent as a message", async () => {
    const first = harness()
    const pending = first.parley.ask({ questions }, ui)
    await tick()
    first.parley.suspend()
    expect((await pending).result).toMatchObject({ status: "unavailable", reason: RELOADED_REASON })
    expect(first.stored.at(-1)?.status).toBe("open")

    const second = harness()
    second.parley.restore(first.stored)
    const roundID = second.parley.current()?.id as string
    expect(second.parley.submit(roundID, [{ id: "db", status: "accepted" }])).toEqual([])
    expect(second.delivered).toHaveLength(1)
    expect(second.delivered[0]).toContain("The user answered that round afterwards")
    expect(second.delivered[0]).toContain("Q1 db [accepted] → SQLite")
    expect(second.stored.at(-1)).toMatchObject({ status: "submitted", delivered: ["db"] })
  })

  test("a call asking the restored questions again takes the round over instead of messaging", async () => {
    const first = harness()
    void first.parley.ask({ questions }, ui)
    await tick()
    first.parley.suspend()

    const second = harness()
    second.parley.restore(first.stored)
    const asked = second.parley.ask({ questions }, ui)
    await tick()
    const roundID = second.parley.current()?.id as string
    expect(second.presented[0]?.id).toBe(roundID)
    second.parley.submit(roundID, [{ id: "db", status: "accepted" }])
    expect((await asked).result.answers.map((answer) => answer.id)).toEqual(["db"])
    expect(second.delivered).toEqual([])
  })

  test("other questions asked over a restored round with the same ids are renamed and mapped back", async () => {
    const first = harness()
    void first.parley.ask({ questions }, ui)
    await tick()
    first.parley.suspend()

    const second = harness()
    second.parley.restore(first.stored)
    const other: Question = { id: "db", title: "Which cache?", kind: "ask_text" }
    const asked = second.parley.ask({ questions: [other] }, ui)
    await tick()
    const round = second.parley.current() as Round
    expect(round.questions.map((question) => question.id)).toEqual(["db", "retries", "db-2"])
    second.parley.submit(round.id, [{ id: "db-2", status: "answered", value: { text: "redis" } }])
    expect((await asked).result.answers).toMatchObject([{ id: "db", value: { text: "redis" } }])
  })

  test("a fork's restored rounds belong to the new session", () => {
    const first = harness()
    void first.parley.ask({ questions, wait: "none" }, ui)
    const forked = harness({ sessionID: "s2" })
    forked.parley.restore(first.stored)
    expect(forked.parley.current()?.sessionID).toBe("s2")
  })
})

test("deliveryText words a dismissed restored round as a dismissal", () => {
  const text = deliveryText({ status: "cancelled", reason: "user_closed", round: 1, answers: [], pending: ["db"] }, questions)
  expect(text).toContain("dismissed that round")
  expect(text).toContain("Pending: db")
})
