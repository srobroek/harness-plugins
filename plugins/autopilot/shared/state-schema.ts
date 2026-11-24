/**
 * The `state.json` schema, checked at the disk boundary. Plain TypeScript, so every host can
 * bundle it: OpenCode supplies `effect` at run time, pi does not.
 *
 * A struct keeps only the keys it names, so a key the schema does not know never reaches the
 * state, and an optional key may be absent but never present with the wrong type.
 */

import type { RunState } from "./state.ts"

type Decoded<T> = { ok: true; value: T } | { ok: false; reason: string }
type Decoder<T> = (value: unknown, path: string) => Decoded<T>

const fail = (path: string, expected: string): { ok: false; reason: string } => ({ ok: false, reason: `${path || "state"}: expected ${expected}` })

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const string: Decoder<string> = (value, path) => (typeof value === "string" ? { ok: true, value } : fail(path, "a string"))
const finite: Decoder<number> = (value, path) => (typeof value === "number" && Number.isFinite(value) ? { ok: true, value } : fail(path, "a finite number"))
const boolean: Decoder<boolean> = (value, path) => (typeof value === "boolean" ? { ok: true, value } : fail(path, "a boolean"))

function literal<const T extends string | number>(...options: readonly T[]): Decoder<T> {
  return (value, path) => ((options as readonly unknown[]).includes(value) ? { ok: true, value: value as T } : fail(path, `one of ${options.map((option) => JSON.stringify(option)).join(", ")}`))
}

function array<T>(item: Decoder<T>): Decoder<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return fail(path, "an array")
    const out: T[] = []
    for (const [index, element] of value.entries()) {
      const decoded = item(element, `${path}[${index}]`)
      if (!decoded.ok) return decoded
      out.push(decoded.value)
    }
    return { ok: true, value: out }
  }
}

function record<T>(item: Decoder<T>): Decoder<Record<string, T>> {
  return (value, path) => {
    if (!isObject(value)) return fail(path, "an object")
    const out: Record<string, T> = {}
    for (const [key, element] of Object.entries(value)) {
      const decoded = item(element, `${path}.${key}`)
      if (!decoded.ok) return decoded
      out[key] = decoded.value
    }
    return { ok: true, value: out }
  }
}

/** A field of a struct; `optional` fields may be absent. */
type Field = { decode: Decoder<unknown>; optional?: true }
const optional = (decode: Decoder<unknown>): Field => ({ decode, optional: true })

function struct<T>(fields: Record<string, Decoder<unknown> | Field>): Decoder<T> {
  const entries = Object.entries(fields).map(([key, field]): [string, Field] => [key, typeof field === "function" ? { decode: field } : field])
  return (value, path) => {
    if (!isObject(value)) return fail(path, "an object")
    const out: Record<string, unknown> = {}
    for (const [key, field] of entries) {
      const at = path ? `${path}.${key}` : key
      if (!Object.hasOwn(value, key)) {
        if (field.optional) continue
        return fail(at, "a value (missing)")
      }
      const decoded = field.decode(value[key], at)
      if (!decoded.ok) return decoded
      out[key] = decoded.value
    }
    return { ok: true, value: out as T }
  }
}

/** The first member that decodes, or the reason the last one gave. */
function union<T>(...members: readonly Decoder<T>[]): Decoder<T> {
  return (value, path) => {
    let last: Decoded<T> = fail(path, "a known variant")
    for (const member of members) {
      last = member(value, path)
      if (last.ok) return last
    }
    return last
  }
}

const strings = array(string)

const scope = union(
  struct({ kind: literal("queue") }),
  struct({ kind: literal("bead"), id: string }),
  struct({ kind: literal("goal"), text: string }),
)

const options = struct({
  scope: optional(string),
  full: boolean,
  allow: array(literal("merge", "deploy", "self-review")),
  lanes: finite,
  forMs: optional(finite),
  untilTime: optional(string),
  until: optional(string),
})

const childState = struct({
  step: optional(literal("nudge", "respawn", "park")),
  stepAt: optional(finite),
  done: optional(boolean),
})

const runState = struct<RunState>({
  version: literal(1),
  generation: finite,
  runId: string,
  sessionID: string,
  directory: string,
  phase: literal("setup", "running", "stopping", "stopped"),
  options,
  scope,
  ledger: optional(string),
  createdAt: finite,
  armedAt: optional(finite),
  deadline: optional(finite),
  tick: struct({
    kind: literal("none", "automation", "fallback"),
    automationId: optional(string),
    token: optional(string),
  }),
  ticks: finite,
  idleTicks: finite,
  beads: struct({ open: strings, ready: strings, blocked: strings, inProgress: strings, closed: strings }),
  commits: finite,
  journalLength: finite,
  finishedChildren: finite,
  attempts: record(finite),
  children: record(childState),
  parked: strings,
  worktrees: optional(array(struct({ path: string, real: string, dev: string, ino: string }))),
  stopRequested: optional(boolean),
  stopReason: optional(string),
  stoppedAt: optional(finite),
  stop: optional(
    struct({
      journalLength: finite,
      summary: boolean,
      handoff: optional(string),
    }),
  ),
})

/** `value` as a run state, or why it is not one. */
export function decodeRunState(value: unknown): { ok: true; state: RunState } | { ok: false; reason: string } {
  const decoded = runState(value, "")
  if (decoded.ok) return { ok: true, state: decoded.value }
  return { ok: false, reason: decoded.reason.replace(/\s+/g, " ").slice(0, 300) }
}
