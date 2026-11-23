import { describe, expect, test } from "bun:test"
import { abortableSleep, type SleepTimers, watchEvents } from "./event-watch.ts"

const eventLoopTurn = () => new Promise<void>((resolve) => setImmediate(resolve))
const settledSoon = (promise: Promise<unknown>) => Promise.race([promise.then(() => "early"), eventLoopTurn().then(() => "pending")])

/** An iterator over a fixed script: each step is an event, an error to throw, or "end". */
function scripted(steps: Array<{ event: string } | { error: Error } | "end" | "hang">, onReturn?: () => unknown): AsyncIterator<string> {
  let i = 0
  return {
    next: async () => {
      const step = steps[i++] ?? "end"
      if (step === "end") return { done: true, value: undefined }
      if (step === "hang") return new Promise<never>(() => {})
      if ("error" in step) throw step.error
      return { done: false, value: step.event }
    },
    return: async () => {
      await onReturn?.()
      return { done: true, value: undefined }
    },
  }
}

const noSleep = async () => {}

describe("watchEvents", () => {
  test("a stream error warns by name, resubscribes, and handles later events", async () => {
    const handled: string[] = []
    const warnings: Array<[string, { error: string }]> = []
    const streams = [scripted([{ event: "a" }, { error: new TypeError("secret text") }]), scripted([{ event: "b" }, "hang"])]
    let subscriptions = 0
    const watch = watchEvents<string>({
      subscribe: () => streams[subscriptions++] as AsyncIterator<string>,
      handle: (event) => void handled.push(event),
      warn: (message, fields) => void warnings.push([message, fields]),
      label: "demo",
      sleep: noSleep,
    })
    while (handled.length < 2) await eventLoopTurn()
    watch.stop()
    expect(handled).toEqual(["a", "b"])
    expect(warnings).toEqual([["demo watch failed; resubscribing (attempt 1)", { error: "TypeError" }]])
  })

  test("the bound counts every failure: three resubscribes, then a final stopped warning", async () => {
    const warnings: string[] = []
    let subscriptions = 0
    const delays: number[] = []
    const watch = watchEvents<string>({
      subscribe: () => {
        subscriptions++
        return scripted([])
      },
      handle: () => {},
      warn: (message) => void warnings.push(message),
      label: "demo",
      sleep: async (ms) => void delays.push(ms),
    })
    await watch.done
    expect(subscriptions).toBe(4)
    expect(delays).toEqual([1_000, 5_000, 15_000])
    expect(warnings).toEqual([
      "demo watch failed; resubscribing (attempt 1)",
      "demo watch failed; resubscribing (attempt 2)",
      "demo watch failed; resubscribing (attempt 3)",
      "demo watch stopped; later events are no longer handled",
    ])
  })

  test("a subscribe that throws counts as a failure", async () => {
    const warnings: string[] = []
    const watch = watchEvents<string>({
      subscribe: () => {
        throw new RangeError("x")
      },
      handle: () => {},
      warn: (message) => void warnings.push(message),
      label: "demo",
      delaysMs: [1],
      sleep: noSleep,
    })
    await watch.done
    expect(warnings).toEqual(["demo watch failed; resubscribing (attempt 1)", "demo watch stopped; later events are no longer handled"])
  })

  test("a throwing handler is warned about and neither ends nor counts against the stream", async () => {
    const handled: string[] = []
    const warnings: Array<[string, { error: string }]> = []
    const watch = watchEvents<string>({
      subscribe: () => scripted([{ event: "a" }, { event: "b" }, "hang"]),
      handle: async (event) => {
        handled.push(event)
        if (event === "a") throw new SyntaxError("boom")
      },
      warn: (message, fields) => void warnings.push([message, fields]),
      label: "demo",
      sleep: noSleep,
    })
    while (handled.length < 2) await eventLoopTurn()
    watch.stop()
    expect(handled).toEqual(["a", "b"])
    expect(warnings).toEqual([["demo event handler failed", { error: "SyntaxError" }]])
  })

  test("an abort during the backoff sleep ends the loop with no further subscription or warning", async () => {
    const pending = new Map<number, () => void>()
    let next = 1
    const timers = {
      setTimeout: (callback: () => void) => {
        pending.set(next, callback)
        return next++
      },
      clearTimeout: (id: number) => void pending.delete(id),
    } as unknown as SleepTimers
    const warnings: string[] = []
    let subscriptions = 0
    const watch = watchEvents<string>({
      subscribe: () => {
        subscriptions++
        return scripted([{ error: new Error("down") }])
      },
      handle: () => {},
      warn: (message) => void warnings.push(message),
      label: "demo",
      sleep: (ms, signal) => abortableSleep(ms, signal, timers),
    })
    while (pending.size === 0) await eventLoopTurn()
    watch.stop()
    expect(await settledSoon(watch.done)).toBe("early")
    expect(pending.size).toBe(0)
    expect(subscriptions).toBe(1)
    expect(warnings).toEqual(["demo watch failed; resubscribing (attempt 1)"])
  })

  test("stop does not await a return() that never settles", async () => {
    let returned = false
    const iterator: AsyncIterator<string> = {
      next: () => new Promise<never>(() => {}),
      return: () => {
        returned = true
        return new Promise<never>(() => {})
      },
    }
    const watch = watchEvents<string>({ subscribe: () => iterator, handle: () => {}, warn: () => {}, label: "demo" })
    await eventLoopTurn()
    expect(() => watch.stop()).not.toThrow()
    expect(returned).toBe(true)
  })

  test("the subscription receives the abort signal that stop fires", async () => {
    let seen: AbortSignal | undefined
    const watch = watchEvents<string>({
      subscribe: (signal) => {
        seen = signal
        return scripted(["hang"])
      },
      handle: () => {},
      warn: () => {},
      label: "demo",
    })
    await eventLoopTurn()
    expect(seen?.aborted).toBe(false)
    watch.stop()
    expect(seen?.aborted).toBe(true)
  })
})
