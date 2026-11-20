/** Journal entries: validation and rendering. Pure. */

export const ENTRY_TYPES = ["decision", "blocker", "issue", "ambiguity", "stop", "progress", "action"] as const
export type EntryType = (typeof ENTRY_TYPES)[number]

export type JournalEntry = {
  ts: string
  type: EntryType
  summary: string
  bead?: string
  lane?: string
  chosen?: string
  alternatives?: string[]
  reversible?: boolean
  confidence?: "low" | "medium" | "high"
  evidence?: string
  /** Set on blockers that park an item until a human looks at it. */
  parked?: boolean
  /** A short stable signature of an error, for the same-error-twice stop. */
  error?: string
}

export const LOG_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "summary"],
  properties: {
    type: { type: "string", enum: [...ENTRY_TYPES] },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    bead: { type: "string" },
    lane: { type: "string" },
    chosen: { type: "string" },
    alternatives: { type: "array", items: { type: "string" } },
    reversible: { type: "boolean" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    evidence: { type: "string", description: "path:line, command, PR or bead link" },
    parked: { type: "boolean", description: "blocker: park the item" },
    error: { type: "string", description: "short stable error signature" },
  },
} as const

const STRING_FIELDS = ["bead", "lane", "chosen", "evidence", "error"] as const

/** A validated entry, or why the input is not one. Disjoint from `JournalEntry`, whose `error` is data. */
export type Validated = { ok: true; entry: JournalEntry } | { ok: false; reason: string }

/** A validated entry stamped with `now`, or the reason the input is invalid. */
export function validateEntry(input: unknown, now: Date): Validated {
  if (input === null || typeof input !== "object") return { ok: false, reason: "entry must be an object" }
  const raw = input as Record<string, unknown>
  if (!ENTRY_TYPES.includes(raw.type as EntryType)) return { ok: false, reason: `type must be one of ${ENTRY_TYPES.join(", ")}` }
  if (typeof raw.summary !== "string" || raw.summary.trim() === "") return { ok: false, reason: "summary is required" }
  const entry: JournalEntry = { ts: now.toISOString(), type: raw.type as EntryType, summary: raw.summary.trim() }
  for (const key of STRING_FIELDS) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== "string") return { ok: false, reason: `${key} must be a string` }
    if (value.trim() !== "") entry[key] = value.trim()
  }
  if (raw.alternatives !== undefined) {
    if (!Array.isArray(raw.alternatives) || raw.alternatives.some((item) => typeof item !== "string")) return { ok: false, reason: "alternatives must be strings" }
    entry.alternatives = raw.alternatives as string[]
  }
  for (const key of ["reversible", "parked"] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== "boolean") return { ok: false, reason: `${key} must be a boolean` }
    entry[key] = raw[key] as boolean
  }
  if (raw.confidence !== undefined) {
    if (!["low", "medium", "high"].includes(raw.confidence as string)) return { ok: false, reason: "confidence must be low, medium or high" }
    entry.confidence = raw.confidence as JournalEntry["confidence"]
  }
  if (entry.type === "decision" && entry.chosen === undefined) return { ok: false, reason: "a decision needs chosen" }
  return { ok: true, entry }
}

/** Parse journal.jsonl, skipping lines that do not parse. */
export function readJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      const value = JSON.parse(line) as JournalEntry
      if (typeof value?.type === "string" && typeof value.summary === "string") entries.push(value)
    } catch {
      // A torn last line after a crash.
    }
  }
  return entries
}

/** Items a human must look at: open blockers and ambiguities. */
export function needsInput(entries: readonly JournalEntry[]): JournalEntry[] {
  return entries.filter((entry) => entry.type === "blocker" || entry.type === "ambiguity")
}

/** Beads parked by a blocker entry. */
export function parkedBeads(entries: readonly JournalEntry[]): string[] {
  const parked = new Set<string>()
  for (const entry of entries) if (entry.type === "blocker" && entry.parked && entry.bead) parked.add(entry.bead)
  return [...parked]
}
