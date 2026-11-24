import { afterEach, expect, test } from "bun:test"
import { type Clock, Ticks } from "./timer.ts"

type Timer = { callback: () => void; ms: number; cleared: boolean }

function fakeClock() {
  const timers: Timer[] = []
  const clock: Clock = {
    setInterval: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearInterval: (timer) => {
      ;(timer as Timer).cleared = true
    },
  }
  return { clock, timers }
}

const owned: Ticks[] = []
const ticks = (clock: Clock) => {
  const instance = new Ticks(clock)
  owned.push(instance)
  return instance
}

afterEach(() => {
  for (const instance of owned.splice(0)) instance.dispose()
})

test("beats on the interval and skips a beat while the previous one runs", async () => {
  const { clock, timers } = fakeClock()
  let release: () => void = () => {}
  let beats = 0
  ticks(clock).start("ses_a", 240_000, () => {
    beats += 1
    return new Promise<void>((resolve) => {
      release = resolve
    })
  })
  expect(timers.map((timer) => timer.ms)).toEqual([240_000])
  timers[0]?.callback()
  timers[0]?.callback()
  expect(beats).toBe(1)
  release()
  await Promise.resolve()
  await Promise.resolve()
  timers[0]?.callback()
  expect(beats).toBe(2)
})

test("a second instance in the same process never ticks a session twice", () => {
  const { clock, timers } = fakeClock()
  ticks(clock).start("ses_b", 1_000, async () => {})
  const other = ticks(clock)
  other.start("ses_b", 1_000, async () => {})
  expect(timers).toHaveLength(1)
  expect(other.active("ses_b")).toBe(true)
})

test("dispose clears only the instance's own timers", () => {
  const { clock, timers } = fakeClock()
  const first = ticks(clock)
  const second = ticks(clock)
  first.start("ses_c", 1_000, async () => {})
  second.start("ses_d", 1_000, async () => {})
  first.dispose()
  expect(timers.map((timer) => timer.cleared)).toEqual([true, false])
  expect(second.active("ses_d")).toBe(true)
  expect(first.active("ses_c")).toBe(false)
})
