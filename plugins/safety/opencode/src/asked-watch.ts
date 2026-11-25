/**
 * The loop behind the `permission.asked` backstop. The loop itself is the shared `watchStream` in
 * `lib/src/event-watch.ts`; this module keeps the names the plugin and its tests use.
 */
import { abortableSleep, DEFAULT_RESUBSCRIBE_DELAYS_MS, type SleepTimers, type StreamWatchDeps, watchStream } from "@srobroek/opencode-lib/event-watch"

export { abortableSleep, DEFAULT_RESUBSCRIBE_DELAYS_MS, type SleepTimers }

export type AskedWatchDeps = StreamWatchDeps

/** Starts the loop; see `watchStream`. */
export const watchAsked = (deps: AskedWatchDeps) => watchStream(deps)
