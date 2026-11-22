import { describe, expect, test } from "bun:test"
import { abortableSleep, type SleepTimers, watchAsked } from "./asked-watch.ts"

/** A controlled clock: nothing fires until the test calls `fire`, and every clear is recorded. */
function fakeTimers() {
  const pending = new Map<number, () => void>()
  const cleared: number[] = []
  let next = 1
  const timers = {
    setTimeout: (callback: () => void) => {
      const id = next++
      pending.set(id, callback)
      return id
    },
    clearTimeout: (id: number) => {
      cleared.push(id)
      pending.delete(id)
    },
  } as unknown as SleepTimers
  const fire = () => {
    for (const callback of [...pending.values()]) callback()
  }
  return { timers, cleared, scheduled: () => pending.size, fire }
}

/** One turn of the event loop: every promise continuation queued before it has run. Used for a negative assertion only. */
const eventLoopTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Resolves "early" when `promise` settles within one event-loop turn, else "pending". */
const settledSoon = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => "early" as const), eventLoopTurn().then(() => "pending" as const)])

describe("abortableSleep", () => {
  test("resolves when the timer fires", async () => {
    const clock = fakeTimers()
    const sleeping = abortableSleep(50, new AbortController().signal, clock.timers)
    expect(await settledSoon(sleeping)).toBe("pending")
    clock.fire()
    expect(await settledSoon(sleeping)).toBe("early")
  })

  test("resolves early on abort and clears its timer, so a teardown never waits out the backoff", async () => {
    const clock = fakeTimers()
    const controller = new AbortController()
    const sleeping = abortableSleep(15_000, controller.signal, clock.timers)
    controller.abort()
    expect(await settledSoon(sleeping)).toBe("early")
    expect(clock.cleared).toHaveLength(1)
    expect(clock.scheduled()).toBe(0)
  })

  test("an already aborted signal resolves at once and schedules nothing", async () => {
    const clock = fakeTimers()
    const controller = new AbortController()
    controller.abort()
    expect(await settledSoon(abortableSleep(15_000, controller.signal, clock.timers))).toBe("early")
    expect(clock.scheduled()).toBe(0)
  })
})

describe("watchAsked", () => {
  test("a teardown during the real backoff sleep ends the loop without another subscription or failure report", async () => {
    const clock = fakeTimers()
    const controller = new AbortController()
    const failures: unknown[] = []
    let subscriptions = 0
    const watch = watchAsked({
      subscribe: () => {
        subscriptions++
        return { next: () => Promise.reject(new TypeError("host down")) }
      },
      handle: async () => {},
      onFailure: (failure) => void failures.push(failure),
      signal: controller.signal,
      delaysMs: [15_000],
      sleep: (ms, signal) => abortableSleep(ms, signal, clock.timers),
    })
    // The failure is reported before the sleep starts, so a scheduled timer proves the loop is in the backoff.
    while (clock.scheduled() === 0) await eventLoopTurn()
    controller.abort()
    expect(await settledSoon(watch.done)).toBe("early")
    expect(subscriptions).toBe(1)
    expect(failures).toEqual([{ error: "TypeError", attempt: 1, willRetry: true }])
  })
})
