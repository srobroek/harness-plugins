import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validate } from "./json-schema.ts";
import { LENSES, PHASES } from "./lenses.ts";
const references = join(import.meta.dir, "..", "..", "common", "skills", "code-challenge", "references");
const load = (name) => JSON.parse(readFileSync(join(references, name), "utf8"));
const report = load("report.schema.json");
const decision = load("decisions.schema.json");
const finding = {
    id: "F1",
    lens: "hand-rolled-library",
    title: "hand-written retry loop",
    location: { path: "src/http.ts", line: 40 },
    claim: "a 20-line retry loop duplicates what the fetch wrapper's retry option does",
    evidence: { tier: "proven", detail: "src/http.ts:40-60 and docs for the wrapper's retry option" },
    impact: "medium",
    blast_radius: "low",
    test_protection: "protected",
    status: "accepted",
    decided_by: "autonomous-rule",
};
const doc = {
    run_id: "20261120-101200-http",
    target: "src/http.ts",
    depth: "standard",
    mode: "autonomous",
    created: "2026-11-20T10:12:00Z",
    lenses: ["hand-rolled-library"],
    summary: { found: 1, accepted: 1, deferred: 0, rejected: 0, dropped: 0 },
    findings: [finding],
    gaps: [],
};
const line = {
    ts: "2026-11-20T10:15:00Z",
    run_id: "20261120-101200-http",
    phase: "INTAKE",
    kind: "inference",
    subject: "pluggability expected",
    choice: "no",
    reason: "no second provider, config key or adapter directory",
    by: "agent",
};
describe("shipped JSON schemas", () => {
    test("lens ids in the report schema are the lenses of the plugin, each with a reference file", () => {
        expect(report.$defs?.lens?.enum).toEqual([...LENSES]);
        for (const lens of LENSES)
            expect(existsSync(join(references, `lens-${lens}.md`))).toBe(true);
        expect(readdirSync(references).filter((file) => file.startsWith("lens-"))).toHaveLength(LENSES.length);
    });
    test("a performance-only run with benchmarks declined reports its replacement lens and the dropped one, and validates", () => {
        const replaced = { ...doc, lenses: ["optimisation"], gaps: ["performance lens dropped: benchmarks were not allowed; optimisation ran instead"] };
        expect(validate(report, replaced)).toEqual([]);
        expect(validate(report, { ...doc, lenses: [] })).toEqual(["$.lenses: fewer than 1 items"]);
        const text = readFileSync(join(references, "lens-performance.md"), "utf8");
        expect(text).toContain("replacement lens");
    });
    test("the decisions schema names the phases of the plugin", () => {
        expect(decision.properties?.phase?.enum).toEqual([...PHASES]);
    });
    test("a complete report and a complete decisions line validate", () => {
        expect(validate(report, doc)).toEqual([]);
        expect(validate(decision, line)).toEqual([]);
    });
    test("a report with a finding that lacks a locator, or carries an unknown tier, is rejected", () => {
        const { location: _location, ...noLocator } = finding;
        expect(validate(report, { ...doc, findings: [noLocator] })).toContainEqual(expect.stringContaining("location"));
        const badTier = { ...finding, evidence: { tier: "certain", detail: "x" } };
        expect(validate(report, { ...doc, findings: [badTier] })).toContainEqual(expect.stringContaining("tier"));
    });
    test.each([
        ["a negative count", (d) => ({ ...d, summary: { ...d.summary, found: -1 } }), ["$.summary.found: below 0"]],
        ["no lenses", (d) => ({ ...d, lenses: [] }), ["$.lenses: fewer than 1 items"]],
        ["an empty target", (d) => ({ ...d, target: "" }), ["$.target: shorter than 1"]],
        ["an empty gap", (d) => ({ ...d, gaps: [""] }), ["$.gaps[0]: shorter than 1"]],
        [
            "an empty title",
            (d) => ({ ...d, findings: [{ ...finding, title: "" }] }),
            ["$.findings[0].title: shorter than 1"],
        ],
        [
            "an empty claim",
            (d) => ({ ...d, findings: [{ ...finding, claim: "" }] }),
            ["$.findings[0].claim: shorter than 1"],
        ],
        [
            "empty evidence detail",
            (d) => ({ ...d, findings: [{ ...finding, evidence: { tier: "proven", detail: "" } }] }),
            ["$.findings[0].evidence.detail: shorter than 1"],
        ],
        [
            "line 0",
            (d) => ({ ...d, findings: [{ ...finding, location: { path: "src/http.ts", line: 0 } }] }),
            ["$.findings[0].location.line: below 1"],
        ],
        [
            "a location without a line",
            (d) => ({ ...d, findings: [{ ...finding, location: { path: "src/http.ts" } }] }),
            ["$.findings[0].location: missing line"],
        ],
    ])("rejects %s with exactly one error", (_name, mutate, errors) => {
        expect(validate(report, mutate(doc))).toEqual(errors);
    });
    test("a run id, depth and extra property outside the schema are rejected", () => {
        expect(validate(report, { ...doc, run_id: "run-1" })).toEqual([
            "$.run_id: does not match ^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,24}$",
        ]);
        expect(validate(report, { ...doc, depth: "thorough" })).toEqual([
            '$.depth: "thorough" is not one of ["quick","standard","deep"]',
        ]);
        expect(validate(report, { ...doc, extra: true })).toEqual(["$: unexpected property extra"]);
    });
    test("a decisions line needs every field and a known kind", () => {
        const { reason: _reason, ...noReason } = line;
        expect(validate(decision, noReason)).toContainEqual(expect.stringContaining("reason"));
        expect(validate(decision, { ...line, kind: "guess" }).length).toBeGreaterThan(0);
    });
    test("schemas.md links both schema files, and they sit beside it", () => {
        const text = readFileSync(join(references, "schemas.md"), "utf8");
        for (const name of ["report.schema.json", "decisions.schema.json"]) {
            expect(text).toContain(`(${name})`);
            expect(existsSync(join(dirname(join(references, "schemas.md")), name))).toBe(true);
        }
    });
});
