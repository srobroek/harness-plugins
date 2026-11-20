/**
 * The fallback tick: a process-wide registry of unref'd intervals, one per lead session, so two
 * plugin instances in one process never tick a run twice. Used only when automation_create fails.
 */

export type Clock = {
  setInterval: (callback: () => void, ms: number) => unknown
  clearInterval: (timer: unknown) => void
}

export const realClock: Clock = {
  setInterval: (callback, ms) => {
    const timer = setInterval(callback, ms)
    timer.unref?.()
    return timer
  },
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
}

type Entry = { owner: object; timer: unknown; clock: Clock; running: boolean }

const REGISTRY: unique symbol = Symbol.for("srobroek.autopilot.ticks") as never

function registry(): Map<string, Entry> {
  const holder = globalThis as { [REGISTRY]?: Map<string, Entry> }
  holder[REGISTRY] ??= new Map()
  return holder[REGISTRY]
}

export class Ticks {
  readonly #owner = {}
  constructor(readonly clock: Clock = realClock) {}

  /** Start ticking `sessionID`; a session that already ticks in any instance is left alone. */
  start(sessionID: string, ms: number, beat: () => Promise<void>): void {
    if (registry().has(sessionID)) return
    const entry: Entry = { owner: this.#owner, clock: this.clock, running: false, timer: undefined }
    entry.timer = this.clock.setInterval(() => {
      if (entry.running) return
      entry.running = true
      beat()
        .catch((error: unknown) => console.error("srobroek.autopilot: fallback tick failed", error))
        .finally(() => {
          entry.running = false
        })
    }, ms)
    registry().set(sessionID, entry)
  }

  active(sessionID: string): boolean {
    return registry().has(sessionID)
  }

  stop(sessionID: string): void {
    const entry = registry().get(sessionID)
    if (!entry) return
    registry().delete(sessionID)
    entry.clock.clearInterval(entry.timer)
  }

  dispose(): void {
    for (const [key, entry] of [...registry()]) if (entry.owner === this.#owner) this.stop(key)
  }
}
