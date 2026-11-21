import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { planEmbeddedWrites } from "./bd-embedded-write-lock.ts"
import { readBounded, readBoundedBytes } from "./bounded-read.ts"

// Real child processes; 30 s leaves headroom for a loaded machine (AGENTS.md, Testing).
setDefaultTimeout(30_000)

let root = ""
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-bounded-")))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function ledger(name: string, make: (store: string) => void): string {
  const store = join(root, name, ".beads")
  mkdirSync(store, { recursive: true })
  make(store)
  return realpathSync(store)
}

const hostile: Record<string, (store: string) => void> = {
  "symlink to /dev/zero": (store) => symlinkSync("/dev/zero", join(store, "metadata.json")),
  "FIFO": (store) => execFileSync("mkfifo", [join(store, "metadata.json")]),
  "oversized file": (store) => writeFileSync(join(store, "metadata.json"), "x".repeat(70_000)),
  "dangling symlink": (store) => symlinkSync(join(store, "nowhere"), join(store, "metadata.json")),
}

describe("readBounded", () => {
  test("reads a small regular file, reports absent, and refuses everything else", () => {
    const store = ledger("plain", (s) => writeFileSync(join(s, "metadata.json"), "{}"))
    expect(readBounded(join(store, "metadata.json"))).toEqual({ kind: "text", text: "{}" })
    expect(readBounded(join(store, "config.yaml"))).toEqual({ kind: "absent" })
    for (const [name, make] of Object.entries(hostile)) {
      const hostileStore = ledger(`rb-${name}`, make)
      expect(readBounded(join(hostileStore, "metadata.json")).kind).toBe("unreadable")
    }
  })
})

describe("readBoundedBytes", () => {
  const dir = () => realpathSync(mkdtempSync(join(root, "bytes-")))

  test("returns the bytes of a regular file within the limit, at the limit included", () => {
    const d = dir()
    writeFileSync(join(d, "f"), Buffer.from([0, 1, 2, 255]))
    expect(readBoundedBytes(join(d, "f"), 4)).toEqual({ kind: "bytes", bytes: Buffer.from([0, 1, 2, 255]) })
  })

  test("reports absent, and refuses a file one byte over the limit without reading it", () => {
    const d = dir()
    writeFileSync(join(d, "f"), "12345")
    expect(readBoundedBytes(join(d, "nope"), 10)).toEqual({ kind: "absent" })
    expect(readBoundedBytes(join(d, "f"), 4)).toEqual({ kind: "unreadable", reason: "too-large" })
  })

  test("refuses a FIFO without blocking, and a symlink, whatever they point at", () => {
    const d = dir()
    execFileSync("mkfifo", [join(d, "fifo")])
    writeFileSync(join(d, "real"), "x")
    symlinkSync(join(d, "real"), join(d, "link"))
    expect(readBoundedBytes(join(d, "fifo"), 10)).toEqual({ kind: "unreadable", reason: "not-regular" })
    expect(readBoundedBytes(join(d, "link"), 10)).toEqual({ kind: "unreadable", reason: "not-regular" })
    expect(readBoundedBytes(d, 10)).toEqual({ kind: "unreadable", reason: "not-regular" })
  })
})

describe("the write planner's store classification", () => {
  for (const [name, make] of Object.entries(hostile)) {
    test(`a ${name} metadata.json neither hangs nor drops the lock`, () => {
      const store = ledger(`plan-${name}`, make)
      const plan = planEmbeddedWrites("bd update proj-1 --claim", root, { BEADS_DIR: store })
      expect(plan).toEqual({ kind: "writes", writes: [{ store, selected: store, offset: 0 }] })
    })
  }

  test("a readable empty carrier is still not an embedded store", () => {
    const store = ledger("empty", (s) => writeFileSync(join(s, "metadata.json"), ""))
    expect(planEmbeddedWrites("bd update proj-1 --claim", root, { BEADS_DIR: store })).toEqual({
      kind: "writes",
      writes: [],
    })
  })

  test("target-only resolution classifies nothing and still reports the target", () => {
    const store = ledger("targets", (s) => writeFileSync(join(s, "metadata.json"), "{}"))
    const seen: string[] = []
    const plan = planEmbeddedWrites("bd create --title t", root, { BEADS_DIR: store }, {
      classify: false,
      observe: (target) => seen.push(`${target.invocation.verb}@${target.store}`),
    })
    expect(plan).toEqual({ kind: "writes", writes: [] })
    expect(seen).toEqual([`create@${store}`])
  })
})
