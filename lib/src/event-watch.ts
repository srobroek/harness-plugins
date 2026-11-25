/**
 * A bounded-resubscribe loop for host event streams. A stream that fails or ends is resubscribed after
 * a backoff, a fixed number of times over the plugin's life; a handler that throws is reported and never
 * counts against the stream. The host and the clock are injected, so tests drive it without a wall-clock wait.
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

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error)

export type StreamWatchDeps<T = unknown> = {
  /** Opens one subscription; may throw. */
  readonly subscribe: () => AsyncIterator<T>
  /** Handles one event. A throw or rejection goes to `onHandlerError` and does not end the stream. */
  readonly handle: (event: T) => unknown
  /** Called once per stream failure, with the attempt number (1-based); `willRetry` is false on the last. */
  readonly onFailure: (failure: { error: string; attempt: number; willRetry: boolean }) => void
  /** Called with the error a handler threw; omitted means the error is dropped. */
  readonly onHandlerError?: (error: unknown) => void
  readonly signal: AbortSignal
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly delaysMs?: readonly number[]
}

/**
 * Starts the loop. `stop()` ends the current iterator without awaiting a pending read (which may never
 * settle) and swallows a rejection from `return()`: at teardown nobody can act on it.
 */
export function watchStream<T = unknown>(deps: StreamWatchDeps<T>): { done: Promise<void>; stop: () => void } {
  const { signal } = deps
  const sleep = deps.sleep ?? abortableSleep
  const delays = deps.delaysMs ?? DEFAULT_RESUBSCRIBE_DELAYS_MS
  let current: AsyncIterator<T> | undefined

  /** Reads one subscription until it fails or ends; returns the reason, or undefined on teardown. */
  const consume = async (): Promise<string | undefined> => {
    try {
      current = deps.subscribe()
    } catch (error) {
      return errorName(error)
    }
    for (;;) {
      let next: IteratorResult<T>
      try {
        next = await current.next()
      } catch (error) {
        return signal.aborted ? undefined : errorName(error)
      }
      if (signal.aborted) return undefined
      if (next.done) return "stream ended"
      try {
        await deps.handle(next.value)
      } catch (error) {
        try {
          deps.onHandlerError?.(error)
        } catch {
          // A failing reporter must not end the stream either.
        }
      }
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

export type EventWatchDeps<T = unknown> = {
  /** Opens one subscription, ending it when `signal` aborts; may throw. */
  readonly subscribe: (signal: AbortSignal) => AsyncIterator<T>
  /** Handles one event; a throw is warned about and the stream goes on. */
  readonly handle: (event: T) => unknown
  /** Warns with a message and the error's name only (never its text). */
  readonly warn: (message: string, fields: { error: string }) => void
  /** Names the watch in warnings, for example "pending cleanup". */
  readonly label: string
  readonly delaysMs?: readonly number[]
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Watches a host event stream. A failure warns and resubscribes up to the bound; the last warns that the
 * watch stopped. `stop()` aborts the watch (ending backoff sleeps, silencing warnings) and releases the
 * live iterator without awaiting it. `done` settles when the loop has ended.
 */
export function watchEvents<T = unknown>(deps: EventWatchDeps<T>): { stop: () => void; done: Promise<void> } {
  const controller = new AbortController()
  const { label, warn } = deps
  const safeWarn = (message: string, error: string) => {
    if (controller.signal.aborted) return
    try {
      warn(message, { error })
    } catch {
      // A broken logger must not end the watch.
    }
  }
  const watch = watchStream<T>({
    subscribe: () => deps.subscribe(controller.signal),
    handle: deps.handle,
    onHandlerError: (error) => safeWarn(`${label} event handler failed`, errorName(error)),
    onFailure: ({ error, attempt, willRetry }) =>
      safeWarn(willRetry ? `${label} watch failed; resubscribing (attempt ${attempt})` : `${label} watch stopped; later events are no longer handled`, error),
    signal: controller.signal,
    sleep: deps.sleep,
    delaysMs: deps.delaysMs,
  })
  return {
    done: watch.done,
    stop: () => {
      controller.abort()
      watch.stop()
    },
  }
}
