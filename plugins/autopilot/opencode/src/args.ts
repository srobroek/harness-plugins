/** Parsing `/autopilot` command arguments. Pure. */

import { tokenize } from "@srobroek/opencode-lib/shell-command"
import { shellQuoteBalanced } from "@srobroek/opencode-lib/shell-tokenizer"

export type Grant = "merge" | "deploy"
export const GRANTS: readonly Grant[] = ["merge", "deploy"]

export type RunOptions = {
  scope?: string
  full?: boolean
  allow?: Grant[]
  lanes?: number
  /** Wall budget in milliseconds. */
  forMs?: number
  /** Clock deadline as "HH:MM" local time. */
  untilTime?: string
  /** Free-text stop condition. */
  until?: string
}

export type Invocation =
  | { kind: "start"; options: RunOptions; missing: SetupField[] }
  | { kind: "resume"; runId?: string }
  | { kind: "review"; runId?: string }
  | { kind: "stop" }
  | { kind: "error"; message: string }

/** Setup values the one setup round asks for when the command line leaves them out. */
export type SetupField = "scope" | "full" | "allow" | "lanes" | "budget" | "until"

export const DEFAULT_LANES = 3

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** "3h", "90m", "1h30m" or "45s" in milliseconds, or `undefined` when it is not a duration. */
export function parseDuration(text: string): number | undefined {
  const trimmed = text.trim().toLowerCase()
  if (!/^(\d+[smhd])+$/.test(trimmed)) return undefined
  let total = 0
  for (const [, count, unit] of trimmed.matchAll(/(\d+)([smhd])/g)) total += Number(count) * (UNITS[unit as string] ?? 0)
  return total > 0 ? total : undefined
}

/** "18:00" style, 24-hour. */
export function parseClock(text: string): string | undefined {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim())
  return match ? `${match[1]?.padStart(2, "0")}:${match[2]}` : undefined
}

/** The next instant at local `clock` ("HH:MM") after `now`. */
export function deadlineAt(clock: string, now: number): number {
  const [hours, minutes] = clock.split(":").map(Number)
  const date = new Date(now)
  date.setHours(hours ?? 0, minutes ?? 0, 0, 0)
  if (date.getTime() <= now) date.setDate(date.getDate() + 1)
  return date.getTime()
}

/** Parse the text after `/autopilot`. */
export function parseInvocation(text: string): Invocation {
  if (!shellQuoteBalanced(text)) return { kind: "error", message: "unbalanced quotes in /autopilot arguments" }
  const tokens = tokenize(text.trim()).map((token) => token.value)
  const first = tokens[0]
  if (first === "stop") return tokens.length === 1 ? { kind: "stop" } : { kind: "error", message: "/autopilot stop takes no arguments" }
  if (first === "resume" || first === "review") {
    if (tokens.length > 2) return { kind: "error", message: `/autopilot ${first} takes at most one run id` }
    return tokens[1] ? { kind: first, runId: tokens[1] } : { kind: first }
  }
  const options: RunOptions = {}
  const scope: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string
    const [flag, inline] = token.startsWith("--") && token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined]
    const value = (): string | undefined => inline ?? tokens[++index]
    switch (flag) {
      case "--full":
        options.full = true
        break
      case "--allow": {
        const raw = value()
        if (!raw) return { kind: "error", message: "--allow needs a list, for example --allow merge,deploy" }
        const grants = raw.split(",").map((item) => item.trim()).filter(Boolean)
        const unknown = grants.filter((grant) => !GRANTS.includes(grant as Grant))
        if (unknown.length) return { kind: "error", message: `--allow: unknown grant ${unknown.join(", ")}; known: ${GRANTS.join(", ")}` }
        options.allow = [...new Set(grants as Grant[])]
        break
      }
      case "--lanes": {
        const raw = value()
        const lanes = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN
        if (!Number.isInteger(lanes) || lanes < 1) return { kind: "error", message: "--lanes needs a whole number of at least 1" }
        options.lanes = lanes
        break
      }
      case "--for": {
        const ms = parseDuration(value() ?? "")
        if (ms === undefined) return { kind: "error", message: "--for needs a duration such as 3h or 90m" }
        options.forMs = ms
        break
      }
      case "--until-time": {
        const clock = parseClock(value() ?? "")
        if (clock === undefined) return { kind: "error", message: "--until-time needs a 24-hour time such as 18:00" }
        options.untilTime = clock
        break
      }
      case "--until": {
        const raw = value()
        if (!raw) return { kind: "error", message: "--until needs a condition in quotes" }
        options.until = raw
        break
      }
      default:
        if (flag.startsWith("--")) return { kind: "error", message: `unknown flag ${flag}` }
        scope.push(token)
    }
  }
  if (options.forMs !== undefined && options.untilTime !== undefined) return { kind: "error", message: "use --for or --until-time, not both" }
  if (scope.length) options.scope = scope.join(" ")
  return { kind: "start", options, missing: missingFields(options) }
}

/** Fields the setup round still has to ask. */
export function missingFields(options: RunOptions): SetupField[] {
  const missing: SetupField[] = []
  if (options.scope === undefined) missing.push("scope")
  if (options.full === undefined) missing.push("full")
  if (options.allow === undefined) missing.push("allow")
  if (options.lanes === undefined) missing.push("lanes")
  if (options.forMs === undefined && options.untilTime === undefined) missing.push("budget")
  if (options.until === undefined) missing.push("until")
  return missing
}

/** What a scope string names. */
export type Scope = { kind: "queue" } | { kind: "bead"; id: string } | { kind: "goal"; text: string }

/** A bead id looks like `prefix-abc` or `prefix-abc.1`; anything else is a free-text goal. */
export function classifyScope(scope: string | undefined): Scope {
  const text = scope?.trim() ?? ""
  if (text === "" || text === "ready" || text === "queue") return { kind: "queue" }
  if (/^[a-z0-9][a-z0-9_-]*-[a-z0-9]+(\.\d+)*$/i.test(text) && !/\s/.test(text)) return { kind: "bead", id: text }
  return { kind: "goal", text }
}
