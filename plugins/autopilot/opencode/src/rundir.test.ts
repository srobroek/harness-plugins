import { afterEach, expect, test } from "bun:test"
import { appendFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunDir } from "./rundir.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("an entry appended after a torn last line still reads back", () => {
  const root = mkdtempSync(join(tmpdir(), "autopilot-rundir-"))
  roots.push(root)
  const dir = new RunDir(root, "r1")
  dir.create()
  dir.append({ ts: "t", type: "progress", summary: "a" })
  appendFileSync(dir.journalPath, '{"ts":"t","ty')
  dir.append({ ts: "t", type: "progress", summary: "b" })
  expect(dir.journal().map((entry) => entry.summary)).toEqual(["a", "b"])
})

test("append reports a journal it cannot read instead of guessing", () => {
  const root = mkdtempSync(join(tmpdir(), "autopilot-rundir-"))
  roots.push(root)
  const dir = new RunDir(root, "r2")
  dir.create()
  dir.append({ ts: "t", type: "progress", summary: "a" })
  chmodSync(dir.journalPath, 0o200)
  try {
    expect(() => dir.append({ ts: "t", type: "progress", summary: "b" })).toThrow(/EACCES/)
  } finally {
    chmodSync(dir.journalPath, 0o600)
  }
})
