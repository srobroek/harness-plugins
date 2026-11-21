import { describe, expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, {
  createRestartNudger,
  isRestartNotice,
  NUDGE_TEXT,
  needsNudge,
  parseRestartNudgeOptions,
  type SessionTimes,
  setupRestartNudge,
} from "./index.ts"

const NOTICE = "<shell state=cancelled>Command cancelled because the server restarted</shell>"

describe("parseRestartNudgeOptions", () => {
  test("is off unless asked for", () => {
    expect(parseRestartNudgeOptions({})).toBeUndefined()
    expect(parseRestartNudgeOptions({ restartNudge: false })).toBeUndefined()
  })

  test("true selects the default grace; an object may set a positive grace", () => {
    expect(parseRestartNudgeOptions({ restartNudge: true })).toEqual({ graceMs: 5000 })
    expect(parseRestartNudgeOptions({ restartNudge: { graceMs: 250 } })).toEqual({ graceMs: 250 })
    expect(parseRestartNudgeOptions({ restartNudge: { graceMs: -1 } })).toEqual({ graceMs: 5000 })
  })
})

describe("isRestartNotice", () => {
  test("matches the cancelled-shell notice only", () => {
    expect(isRestartNotice(NOTICE)).toBe(true)
    expect(isRestartNotice("Command finished with exit code 0")).toBe(false)
  })

  test("does not match the nudge's own synthetic message, so a nudge cannot retrigger itself", () => {
    expect(isRestartNotice(NUDGE_TEXT)).toBe(false)
  })
})

describe("needsNudge", () => {
  const at = (time: SessionTimes["time"]): SessionTimes => ({ time })
  test("an idle session whose last run ended before the notice needs a nudge", () => {
    expect(needsNudge(at({ busy: 10, idle: 20 }), 100)).toBe(true)
    expect(needsNudge(at({ idle: 20 }), 100)).toBe(true)
  })
  test("a session that is running does not", () => {
    expect(needsNudge(at({ busy: 150, idle: 20 }), 100)).toBe(false)
  })
  test("a session that finished a run after the notice was already woken", () => {
    expect(needsNudge(at({ busy: 110, idle: 200 }), 100)).toBe(false)
  })
  test("an archived session does not", () => {
    expect(needsNudge(at({ idle: 20, archived: 30 }), 100)).toBe(false)
  })
  test("a session that never finished a run does not", () => {
    expect(needsNudge(at({}), 100)).toBe(false)
  })
})

describe("createRestartNudger", () => {
  function harness(session: () => SessionTimes | Error = () => ({ time: { idle: 20 } })) {
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
    const nudged: string[] = []
    const nudger = createRestartNudger({
      graceMs: 5_000,
      getSession: async () => {
        const value = session()
        if (value instanceof Error) throw value
        return value
      },
      nudge: async (sessionID) => {
        nudged.push(sessionID)
      },
      schedule: (fn, ms) => {
        const timer = { fn, ms, live: true }
        timers.push(timer)
        return () => {
          timer.live = false
        }
      },
    })
    const fire = async () => {
      for (const timer of timers.splice(0)) if (timer.live) timer.fn()
      await Promise.resolve()
      await Promise.resolve()
    }
    return { nudger, timers, nudged, fire }
  }
  const notice = (sessionID = "ses_a", text = NOTICE) => ({ sessionID, text, created: 100 })

  test("nudges an idle session once, only after the grace period", async () => {
    const h = harness()
    h.nudger.notice(notice())
    expect(h.timers.map((timer) => timer.ms)).toEqual([5_000])
    expect(h.nudged).toEqual([])
    await h.fire()
    expect(h.nudged).toEqual(["ses_a"])
  })

  test("ignores events that are not the restart notice", async () => {
    const h = harness()
    h.nudger.notice(notice("ses_a", "Command finished"))
    expect(h.timers).toEqual([])
  })

  test("two notices in the grace period give one nudge", async () => {
    const h = harness()
    h.nudger.notice(notice())
    h.nudger.notice(notice())
    await h.fire()
    expect(h.nudged).toEqual(["ses_a"])
  })

  test("a session is nudged at most once per process", async () => {
    const h = harness()
    h.nudger.notice(notice())
    await h.fire()
    h.nudger.notice(notice())
    await h.fire()
    expect(h.nudged).toEqual(["ses_a"])
  })

  test("sessions are nudged independently", async () => {
    const h = harness()
    h.nudger.notice(notice("ses_a"))
    h.nudger.notice(notice("ses_b"))
    await h.fire()
    expect(h.nudged.sort()).toEqual(["ses_a", "ses_b"])
  })

  test("no nudge when the session was woken in the meantime, and a later notice may still nudge", async () => {
    let state: SessionTimes = { time: { busy: 110, idle: 200 } }
    const h = harness(() => state)
    h.nudger.notice(notice())
    await h.fire()
    expect(h.nudged).toEqual([])
    state = { time: { idle: 20 } }
    h.nudger.notice(notice())
    await h.fire()
    expect(h.nudged).toEqual(["ses_a"])
  })

  test("no nudge when the session lookup fails", async () => {
    const h = harness(() => new Error("gone"))
    h.nudger.notice(notice())
    await h.fire()
    expect(h.nudged).toEqual([])
  })

  test("dispose cancels pending nudges", async () => {
    const h = harness()
    h.nudger.notice(notice())
    h.nudger.dispose()
    await h.fire()
    expect(h.nudged).toEqual([])
  })
})

describe("createRestartNudger with a slow session lookup", () => {
  function slow() {
    const lookups: Array<(value: SessionTimes) => void> = []
    const timers: Array<() => void> = []
    const nudged: string[] = []
    const nudger = createRestartNudger({
      graceMs: 5_000,
      getSession: () => new Promise<SessionTimes>((resolve) => lookups.push(resolve)),
      nudge: async (sessionID) => {
        nudged.push(sessionID)
      },
      schedule: (fn) => {
        timers.push(fn)
        return () => {}
      },
    })
    const flush = () => new Promise((resolve) => setImmediate(resolve))
    return { nudger, lookups, timers, nudged, flush }
  }
  const notice = { sessionID: "ses_a", text: NOTICE, created: 100 }
  const idle: SessionTimes = { time: { idle: 20 } }

  test("a notice that arrives while the lookup is in flight does not start a second nudge", async () => {
    const h = slow()
    h.nudger.notice(notice)
    h.timers[0]?.()
    h.nudger.notice(notice)
    expect(h.timers).toHaveLength(1)
    h.lookups[0]?.(idle)
    await h.flush()
    h.nudger.notice(notice)
    expect(h.timers).toHaveLength(1)
    expect(h.nudged).toEqual(["ses_a"])
  })

  test("dispose during the lookup stops the nudge", async () => {
    const h = slow()
    h.nudger.notice(notice)
    h.timers[0]?.()
    h.nudger.dispose()
    h.lookups[0]?.(idle)
    await h.flush()
    expect(h.nudged).toEqual([])
  })

  test("a disposed nudger ignores later notices", () => {
    const h = slow()
    h.nudger.dispose()
    h.nudger.notice(notice)
    expect(h.timers).toEqual([])
  })
})

describe("plugin wiring", () => {
  const synthetic = (sessionID: string) => ({ type: "session.synthetic", created: 100, data: { sessionID, text: NOTICE } })
  const setup = async (options: Record<string, unknown>) => {
    const fake = createFakeContext({ options, sessions: [{ id: "ses_a", time: { idle: 20 } }] })
    const dispose = await plugin.setup(fake.context)
    return { fake, dispose }
  }
  const subscribedToSynthetic = (fake: Awaited<ReturnType<typeof setup>>["fake"]) =>
    fake.calls.some((call) => call.method === "event.subscribe" && JSON.stringify(call.input).includes("session.synthetic"))

  test("subscribes to restart notices only when restartNudge is set", async () => {
    const off = await setup({})
    expect(subscribedToSynthetic(off.fake)).toBe(false)
    await off.dispose?.()
    const on = await setup({ restartNudge: { graceMs: 1 } })
    expect(subscribedToSynthetic(on.fake)).toBe(true)
    await on.dispose?.()
  })

  test("posts one resume nudge to the idle session after the grace", async () => {
    const fake = createFakeContext({ sessions: [{ id: "ses_a", time: { idle: 20 } }] })
    const timers: Array<() => void> = []
    const stop = await setupRestartNudge(fake.context, { graceMs: 5_000 }, (fn) => {
      timers.push(fn)
      return () => {}
    })
    fake.emit(synthetic("ses_a"))
    await new Promise((resolve) => setImmediate(resolve))
    expect(timers).toHaveLength(1)
    expect(fake.calls.filter((call) => call.method === "session.synthetic")).toEqual([])
    timers[0]?.()
    await new Promise((resolve) => setImmediate(resolve))
    const posts = fake.calls.filter((call) => call.method === "session.synthetic")
    expect(posts).toHaveLength(1)
    expect(posts[0]?.input).toMatchObject({ sessionID: "ses_a", resume: true, delivery: "queue" })
    await stop()
  })

  test("logs a subscription failure with its cause", async () => {
    const fake = createFakeContext()
    const boom = new Error("stream broke")
    ;(fake.context.event as { subscribe: unknown }).subscribe = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(boom) }),
    })
    const warnings: unknown[][] = []
    const stop = await setupRestartNudge(fake.context, { graceMs: 5_000 }, undefined, (...args) => warnings.push(args))
    await new Promise((resolve) => setImmediate(resolve))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.[1]).toBe(boom)
    await stop()
  })

  test("stays quiet when teardown aborts the subscription", async () => {
    const fake = createFakeContext()
    const warnings: unknown[][] = []
    const stop = await setupRestartNudge(fake.context, { graceMs: 5_000 }, undefined, (...args) => warnings.push(args))
    await stop()
    await new Promise((resolve) => setImmediate(resolve))
    expect(warnings).toEqual([])
  })
})
