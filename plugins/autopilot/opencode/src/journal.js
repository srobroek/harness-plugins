/** Journal entries: validation and rendering. Pure. */
export const ENTRY_TYPES = ["decision", "blocker", "issue", "ambiguity", "stop", "progress", "action"];
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
};
const STRING_FIELDS = ["bead", "lane", "chosen", "evidence", "error"];
/** A validated entry stamped with `now`, or the reason the input is invalid. */
export function validateEntry(input, now) {
    if (input === null || typeof input !== "object")
        return { ok: false, reason: "entry must be an object" };
    const raw = input;
    if (!ENTRY_TYPES.includes(raw.type))
        return { ok: false, reason: `type must be one of ${ENTRY_TYPES.join(", ")}` };
    if (typeof raw.summary !== "string" || raw.summary.trim() === "")
        return { ok: false, reason: "summary is required" };
    const entry = { ts: now.toISOString(), type: raw.type, summary: raw.summary.trim() };
    for (const key of STRING_FIELDS) {
        const value = raw[key];
        if (value === undefined)
            continue;
        if (typeof value !== "string")
            return { ok: false, reason: `${key} must be a string` };
        if (value.trim() !== "")
            entry[key] = value.trim();
    }
    if (raw.alternatives !== undefined) {
        if (!Array.isArray(raw.alternatives) || raw.alternatives.some((item) => typeof item !== "string"))
            return { ok: false, reason: "alternatives must be strings" };
        entry.alternatives = raw.alternatives;
    }
    for (const key of ["reversible", "parked"]) {
        if (raw[key] === undefined)
            continue;
        if (typeof raw[key] !== "boolean")
            return { ok: false, reason: `${key} must be a boolean` };
        entry[key] = raw[key];
    }
    if (raw.confidence !== undefined) {
        if (!["low", "medium", "high"].includes(raw.confidence))
            return { ok: false, reason: "confidence must be low, medium or high" };
        entry.confidence = raw.confidence;
    }
    if (entry.type === "decision" && entry.chosen === undefined)
        return { ok: false, reason: "a decision needs chosen" };
    return { ok: true, entry };
}
/**
 * Parse journal.jsonl. Only the last line may be torn (a crash mid-append, no line ending);
 * any other line that is not an entry is corruption and throws, naming the line.
 */
export function readJournal(text) {
    const entries = [];
    const lines = text.split("\n");
    const tornTail = !text.endsWith("\n");
    lines.forEach((line, index) => {
        if (line.trim() === "")
            return;
        let value;
        try {
            value = JSON.parse(line);
        }
        catch {
            value = undefined;
        }
        if (typeof value?.type === "string" && typeof value.summary === "string") {
            entries.push(value);
            return;
        }
        if (tornTail && index === lines.length - 1)
            return;
        throw new JournalCorrupt(index + 1);
    });
    return entries;
}
/** A journal line that is neither an entry nor a torn last line. */
export class JournalCorrupt extends Error {
    line;
    constructor(line) {
        super(`line ${line} is not a journal entry`);
        this.line = line;
    }
}
/** Items a human must look at: open blockers and ambiguities. */
export function needsInput(entries) {
    return entries.filter((entry) => entry.type === "blocker" || entry.type === "ambiguity");
}
/** Beads parked by a blocker entry. */
export function parkedBeads(entries) {
    const parked = new Set();
    for (const entry of entries)
        if (entry.type === "blocker" && entry.parked && entry.bead)
            parked.add(entry.bead);
    return [...parked];
}
