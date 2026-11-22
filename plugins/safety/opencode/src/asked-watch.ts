/**
 * The loop behind the `permission.asked` backstop: read a host event stream, hand each event to a
 * handler, and resubscribe a bounded number of times when the stream fails or ends. The host and the
 * clock are injected, so tests drive it without a wall-clock wait.
 */

/** The two timer functions `abortableSleep` uses; a test passes a controlled pair. */
export type SleepTimers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">

/** Waits `ms`, or returns early when `signal` aborts. Never rejects; the timer does not hold the process open. */
export function abortableSleep(ms: number, signal: AbortSignal, timers: SleepTimers = globalThis): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      timers.clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = timers.setTimeout(done, ms)
    timer.unref?.()
    signal.addEventListener("abort", done, { once: true })
  })
}

/** Delays before each resubscribe attempt; its length is the attempt bound. */
export const DEFAULT_RESUBSCRIBE_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000]

export type AskedWatchDeps = {
  /** Opens one subscription; may throw. */
  readonly subscribe: () => AsyncIterator<unknown>
  /** Handles one event; must not reject. */
  readonly handle: (event: unknown) => Promise<void>
  /** Called once per failure, with the attempt number (1-based) and the bound; `willRetry` is false on the last. */
  readonly onFailure: (failure: { error: string; attempt: number; willRetry: boolean }) => void
  readonly signal: AbortSignal
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly delaysMs?: readonly number[]
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error)

/**
 * Starts the loop. `stop()` ends the current iterator without awaiting a pending read (which may never
 * settle) and swallows a rejection from `return()`: at teardown nobody can act on it.
 */
export function watchAsked(deps: AskedWatchDeps): { done: Promise<void>; stop: () => void } {
  const { signal } = deps
  const sleep = deps.sleep ?? abortableSleep
  const delays = deps.delaysMs ?? DEFAULT_RESUBSCRIBE_DELAYS_MS
  let current: AsyncIterator<unknown> | undefined

  /** Reads one subscription until it fails or ends; returns the reason, or undefined on teardown. */
  const consume = async (): Promise<string | undefined> => {
    try {
      current = deps.subscribe()
    } catch (error) {
      return errorName(error)
    }
    for (;;) {
      let next: IteratorResult<unknown>
      try {
        next = await current.next()
      } catch (error) {
        return signal.aborted ? undefined : errorName(error)
      }
      if (signal.aborted) return undefined
      if (next.done) return "stream ended"
      await deps.handle(next.value)
    }
  }

  const run = async (): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      const failure = await consume()
      if (failure === undefined || signal.aborted) return
      const delay = delays[attempt - 1]
      deps.onFailure({ error: failure, attempt, willRetry: delay !== undefined })
      if (delay === undefined) return
      await sleep(delay, signal)
      if (signal.aborted) return
    }
  }

  return {
    done: run(),
    stop: () => {
      try {
        void Promise.resolve(current?.return?.()).catch(() => undefined)
      } catch {
        // A synchronous throw from return() is as unactionable as a rejection.
      }
    },
  }
}
