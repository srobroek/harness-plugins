import type { Context } from "@opencode/plugin/promise/plugin"
import { sessionRunning } from "@srobroek/opencode-lib/session-eviction"
import { isSessionNotFound } from "@srobroek/opencode-lib/session-lanes"

/** Text OpenCode's restart recovery posts (`session.synthetic`, `resume: false`) for a shell the restart killed. */
export const RESTART_NOTICE = "Command cancelled because the server restarted"
export const DEFAULT_RESTART_NUDGE_GRACE_MS = 5_000

export type RestartNudgeOptions = { graceMs: number }

/** The `time` fields of a session that decide whether it needs waking. */
export type SessionTimes = { time: { busy?: number; idle?: number; archived?: number } }

export type RestartNotice = { sessionID: string; text: string; created: number }

/** `restartNudge` option: off unless `true` or an object; `graceMs` falls back to the default when unset or invalid. */
export function parseRestartNudgeOptions(options: Record<string, unknown>): RestartNudgeOptions | undefined {
  const raw = options.restartNudge
  if (raw !== true && (raw === null || typeof raw !== "object")) return undefined
  const graceMs = raw === true ? undefined : (raw as Record<string, unknown>).graceMs
  return { graceMs: typeof graceMs === "number" && Number.isFinite(graceMs) && graceMs > 0 ? graceMs : DEFAULT_RESTART_NUDGE_GRACE_MS }
}

export function isRestartNotice(text: string): boolean {
  return text.includes(RESTART_NOTICE)
}

/**
 * Whether a session that got a restart notice at `noticeCreated` is stalled: not archived, not running,
 * and its last run ended before the notice. A later run means the host already woke it.
 */
export function needsNudge(session: SessionTimes, noticeCreated: number): boolean {
  const { idle, archived } = session.time
  if (archived !== undefined || idle === undefined || sessionRunning(session)) return false
  return idle <= noticeCreated
}

export type Schedule = (fn: () => void, ms: number) => () => void

export type RestartNudger = { notice: (event: RestartNotice) => void; dispose: () => void }

export type RestartNudgerDeps = {
  graceMs: number
  getSession: (sessionID: string) => Promise<SessionTimes>
  nudge: (sessionID: string) => Promise<void>
  schedule?: Schedule
  /** Called for a lookup or post failure other than a missing session. */
  warn?: (message: string, cause: unknown) => void
}

const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

/** Waits `graceMs` after a restart notice, then nudges the session once if it is still stalled. At most one nudge per session. */
export function createRestartNudger(deps: RestartNudgerDeps): RestartNudger {
  const schedule = deps.schedule ?? defaultSchedule
  // A session stays here from its notice until its nudge attempt ends, so overlapping notices cannot start a second attempt.
  const active = new Map<string, () => void>()
  const nudged = new Set<string>()
  let disposed = false
  const settle = async (sessionID: string, created: number) => {
    try {
      const session = await deps.getSession(sessionID)
      if (disposed || nudged.has(sessionID) || !needsNudge(session, created)) return
      nudged.add(sessionID)
      await deps.nudge(sessionID)
    } catch (error) {
      // The attempt is not retried. A missing session is expected (deleted meanwhile); anything else is reported.
      if (!isSessionNotFound(error, sessionID)) deps.warn?.(`agent-efficiency: restartNudge could not wake session ${sessionID}`, error)
    } finally {
      active.delete(sessionID)
    }
  }
  return {
    notice(event) {
      if (disposed || !isRestartNotice(event.text) || nudged.has(event.sessionID) || active.has(event.sessionID)) return
      active.set(event.sessionID, schedule(() => void settle(event.sessionID, event.created), deps.graceMs))
    },
    dispose() {
      disposed = true
      for (const cancel of active.values()) cancel()
      active.clear()
    },
  }
}

export const NUDGE_TEXT =
  "The server restarted while you were waiting for a background shell, and that shell was lost. Check its output files and the state on disk, rerun it if needed, and continue your task."

/** Subscribes to `session.synthetic` events and nudges stalled sessions. Returns the cleanup. */
export async function setupRestartNudge(
  ctx: Context,
  options: RestartNudgeOptions,
  schedule?: Schedule,
  warn: (message: string, cause: unknown) => void = (message, cause) => console.warn(message, cause),
): Promise<() => Promise<void>> {
  const nudger = createRestartNudger({
    graceMs: options.graceMs,
    schedule,
    warn,
    getSession: (sessionID) => ctx.session.get({ sessionID } as never) as unknown as Promise<SessionTimes>,
    nudge: async (sessionID) => {
      await ctx.session.synthetic({ sessionID, text: NUDGE_TEXT, description: "Shell lost to server restart", delivery: "queue", resume: true } as never)
    },
  })
  const controller = new AbortController()
  const iterator = ctx.event.subscribe({ signal: controller.signal, types: ["session.synthetic"] } as never)[Symbol.asyncIterator]()
  void (async () => {
    try {
      while (!controller.signal.aborted) {
        const next = await iterator.next()
        if (next.done) break
        const event = next.value as unknown as { type: string; created: number; data: { sessionID: string; text: string } }
        if (event.type === "session.synthetic") nudger.notice({ sessionID: event.data.sessionID, text: event.data.text, created: event.created })
      }
    } catch (error) {
      // Without the stream no notice arrives, so say so; an abort is our own teardown.
      if (!controller.signal.aborted) warn("agent-efficiency: restartNudge stopped listening for restart notices", error)
    }
  })()
  return async () => {
    controller.abort()
    nudger.dispose()
    await iterator.return?.()
  }
}
