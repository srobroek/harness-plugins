import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { foreignBead, fsLedgerHost, resolveLedger } from "./ledger.ts"

// Each test makes a few directories and, for the derivation test, runs `git init` and `git rev-parse`
// (tens of milliseconds here); the allowance covers a slow endpoint scan.
setDefaultTimeout(30_000)

let base: string
let rig: string
let ledger: string
let other: string
const bead = { kind: "bead", id: "oth-1" } as const

/** A real ledger directory: `.beads` holding a `metadata.json`. */
function makeLedger(directory: string): string {
  const dir = join(directory, ".beads")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "metadata.json"), "{}")
  return dir
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-ledger-")))
  rig = join(base, "rig")
  other = join(base, "other")
  mkdirSync(rig)
  mkdirSync(other)
  ledger = makeLedger(rig)
  makeLedger(other)
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

const host = { ...fsLedgerHost, sessionLedger: () => ledger }
const route = '{"prefix":"oth-","path":"../other"}\n'

test("a routes.jsonl in the ledger routes a bead to the target ledger", () => {
  writeFileSync(join(ledger, "routes.jsonl"), route)
  expect(resolveLedger({ scope: bead, directory: rig }, host)).toEqual({ ok: true, ledger: join(other, ".beads") })
})

test("no routes.jsonl is no route, not an error", () => {
  expect(resolveLedger({ scope: bead, directory: rig }, host)).toEqual({ ok: true, ledger })
  expect(foreignBead(ledger, "oth-1", host)).toBeUndefined()
})

test("a symlinked routes.jsonl refuses selection and every write, instead of reading as no routes", () => {
  writeFileSync(join(base, "elsewhere.jsonl"), route)
  symlinkSync(join(base, "elsewhere.jsonl"), join(ledger, "routes.jsonl"))
  expect(resolveLedger({ scope: bead, directory: rig }, host)).toMatchObject({ ok: false, error: expect.stringContaining("routes.jsonl") })
  expect(foreignBead(ledger, "p-1", host)).toContain("routes.jsonl")
})

test("an oversized routes.jsonl refuses selection and every write", () => {
  writeFileSync(join(ledger, "routes.jsonl"), `${route}${" ".repeat(70 * 1024)}`)
  expect(resolveLedger({ scope: bead, directory: rig }, host)).toMatchObject({ ok: false })
  expect(foreignBead(ledger, "p-1", host)).toContain("routes.jsonl")
})

test("a symlinked redirect refuses selection, even for a scope that reads no routes", () => {
  writeFileSync(join(base, "target"), "../other/.beads")
  symlinkSync(join(base, "target"), join(ledger, "redirect"))
  expect(resolveLedger({ scope: { kind: "queue" }, directory: rig }, host)).toMatchObject({ ok: false, error: expect.stringContaining("redirect") })
})

test("a redirect file is followed to the ledger it names", () => {
  writeFileSync(join(ledger, "redirect"), "../other/.beads\n")
  expect(resolveLedger({ scope: { kind: "queue" }, directory: rig }, host)).toEqual({ ok: true, ledger: join(other, ".beads") })
})

test("the session ledger comes from the directory, whatever BEADS_DIR the process inherited", () => {
  execFileSync("git", ["init", "-q", rig])
  const inherited = process.env.BEADS_DIR
  process.env.BEADS_DIR = join(other, ".beads")
  try {
    expect(resolveLedger({ scope: { kind: "queue" }, directory: rig }, fsLedgerHost)).toEqual({ ok: true, ledger })
  } finally {
    if (inherited === undefined) delete process.env.BEADS_DIR
    else process.env.BEADS_DIR = inherited
  }
})
