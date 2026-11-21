import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateRun } from "./validate.ts"

const report = {
  run_id: "20261120-101200-http",
  target: "src/http.ts",
  depth: "standard",
  mode: "autonomous",
  created: "2026-11-20T10:12:00Z",
  lenses: ["stability"],
  summary: { found: 1, accepted: 0, deferred: 1, rejected: 0, dropped: 0 },
  findings: [
    {
      id: "F1",
      lens: "stability",
      title: "unbounded retry",
      location: { path: "src/http.ts", line: 40 },
      also_at: [{ path: "src/client.ts", line: 12 }],
      recurs: 2,
      claim: "the retry loop has no cap",
      evidence: { tier: "proven", detail: "src/http.ts:40-60" },
      impact: "medium",
      blast_radius: "low",
      test_protection: "not-applicable",
      status: "deferred",
    },
  ],
  gaps: [],
}
const line = {
  ts: "2026-11-20T10:15:00Z",
  run_id: "20261120-101200-http",
  phase: "INTAKE",
  kind: "inference",
  subject: "pluggability expected",
  choice: "no",
  reason: "no second provider",
  by: "agent",
}

function run(files: Record<string, string>, check: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "challenge-validate-"))
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    check(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("a valid report with recurring locations and a valid decisions log pass", () => {
  run({ "report.json": JSON.stringify(report), "decisions.jsonl": `${JSON.stringify(line)}\n${JSON.stringify(line)}\n` }, (dir) =>
    expect(validateRun(dir)).toEqual([]),
  )
})

test("errors name the file and, for the log, the line", () => {
  const bad = { ...report, depth: "thorough" }
  run(
    { "report.json": JSON.stringify(bad), "decisions.jsonl": `${JSON.stringify(line)}\n${JSON.stringify({ ...line, kind: "guess" })}\nnot json\n` },
    (dir) => {
      const errors = validateRun(dir)
      expect(errors).toHaveLength(3)
      expect(errors[0]).toStartWith("report.json $.depth:")
      expect(errors[1]).toStartWith("decisions.jsonl:2 $.kind:")
      expect(errors[2]).toStartWith("decisions.jsonl:3:")
    },
  )
})

test("a missing file and an empty log are reported", () => {
  run({ "decisions.jsonl": "\n" }, (dir) =>
    expect(validateRun(dir)).toEqual(["report.json: cannot be read", "decisions.jsonl: has no lines"]),
  )
})
