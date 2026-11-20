import { expect, test } from "bun:test"
import { needsInput, parkedBeads, readJournal, validateEntry } from "./journal.ts"

const now = new Date("2026-11-20T14:00:00Z")

test("validateEntry stamps and trims a valid entry", () => {
  expect(validateEntry({ type: "decision", summary: " use bun ", chosen: "bun", alternatives: ["node"], reversible: true, confidence: "high" }, now)).toEqual({
    ts: "2026-11-20T14:00:00.000Z",
    type: "decision",
    summary: "use bun",
    chosen: "bun",
    alternatives: ["node"],
    reversible: true,
    confidence: "high",
  })
})

test.each([
  [{ type: "note", summary: "x" }, "type must be one of decision, blocker, issue, ambiguity, stop, progress, action"],
  [{ type: "issue", summary: "  " }, "summary is required"],
  [{ type: "decision", summary: "x" }, "a decision needs chosen"],
  [{ type: "issue", summary: "x", reversible: "yes" }, "reversible must be a boolean"],
  [{ type: "issue", summary: "x", alternatives: [1] }, "alternatives must be strings"],
])("validateEntry rejects %p", (input, error) => {
  expect(validateEntry(input, now)).toEqual({ error })
})

test("readJournal skips a torn last line", () => {
  const text = `${JSON.stringify({ ts: "t", type: "progress", summary: "a" })}\n{"ts":"t","ty`
  expect(readJournal(text)).toHaveLength(1)
})

test("needsInput and parkedBeads", () => {
  const entries = [
    { ts: "t", type: "blocker" as const, summary: "a", bead: "b-1", parked: true },
    { ts: "t", type: "blocker" as const, summary: "b", bead: "b-2" },
    { ts: "t", type: "ambiguity" as const, summary: "c" },
    { ts: "t", type: "progress" as const, summary: "d", bead: "b-3" },
  ]
  expect(needsInput(entries).map((entry) => entry.summary)).toEqual(["a", "b", "c"])
  expect(parkedBeads(entries)).toEqual(["b-1"])
})
