import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { headerView, readSessionHeader } from "./pi-session-header.ts"

const root = mkdtempSync(join(tmpdir(), "pi-session-header-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("reads the first line of a session file", () => {
  const file = join(root, "a.jsonl")
  writeFileSync(file, `${JSON.stringify({ type: "session", id: "s-1", parentSession: "/p.jsonl" })}\n{"type":"message"}\n`)
  expect(readSessionHeader(file)).toEqual({ id: "s-1", parentSession: "/p.jsonl" })
})

test("a missing file, a non-header first line or a directory is no header", () => {
  const other = join(root, "b.jsonl")
  writeFileSync(other, '{"type":"message","id":"m"}\n')
  expect(readSessionHeader(join(root, "missing.jsonl"))).toBeUndefined()
  expect(readSessionHeader(other)).toBeUndefined()
  expect(readSessionHeader(root)).toBeUndefined()
})

test("an empty parentSession is dropped", () => {
  expect(headerView({ type: "session", id: "x", parentSession: "" })).toEqual({ id: "x" })
})
