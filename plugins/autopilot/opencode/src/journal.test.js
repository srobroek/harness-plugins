import { expect, test } from "bun:test";
import { needsInput, parkedBeads, readJournal, validateEntry } from "./journal.ts";
const now = new Date("2026-11-20T14:00:00Z");
test("validateEntry stamps and trims a valid entry", () => {
    expect(validateEntry({ type: "decision", summary: " use bun ", chosen: "bun", alternatives: ["node"], reversible: true, confidence: "high" }, now)).toEqual({ ok: true, entry: {
            ts: "2026-11-20T14:00:00.000Z",
            type: "decision",
            summary: "use bun",
            chosen: "bun",
            alternatives: ["node"],
            reversible: true,
            confidence: "high",
        } });
});
test("validateEntry keeps an error signature as data", () => {
    expect(validateEntry({ type: "issue", summary: "build fails", error: "TS2304" }, now)).toMatchObject({ ok: true, entry: { error: "TS2304" } });
});
test.each([
    [{ type: "note", summary: "x" }, "type must be one of decision, blocker, issue, ambiguity, stop, progress, action"],
    [{ type: "issue", summary: "  " }, "summary is required"],
    [{ type: "decision", summary: "x" }, "a decision needs chosen"],
    [{ type: "issue", summary: "x", reversible: "yes" }, "reversible must be a boolean"],
    [{ type: "issue", summary: "x", alternatives: [1] }, "alternatives must be strings"],
])("validateEntry rejects %p", (input, reason) => {
    expect(validateEntry(input, now)).toEqual({ ok: false, reason });
});
test("readJournal skips a torn last line", () => {
    const text = `${JSON.stringify({ ts: "t", type: "progress", summary: "a" })}\n{"ts":"t","ty`;
    expect(readJournal(text)).toHaveLength(1);
});
test("readJournal throws on a bad line that is not the torn tail", () => {
    const text = `{"ts":"t","ty\n${JSON.stringify({ ts: "t", type: "progress", summary: "a" })}\n`;
    expect(() => readJournal(text)).toThrow("line 1 is not a journal entry");
});
test("needsInput and parkedBeads", () => {
    const entries = [
        { ts: "t", type: "blocker", summary: "a", bead: "b-1", parked: true },
        { ts: "t", type: "blocker", summary: "b", bead: "b-2" },
        { ts: "t", type: "ambiguity", summary: "c" },
        { ts: "t", type: "progress", summary: "d", bead: "b-3" },
    ];
    expect(needsInput(entries).map((entry) => entry.summary)).toEqual(["a", "b", "c"]);
    expect(parkedBeads(entries)).toEqual(["b-1"]);
});
