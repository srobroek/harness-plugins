import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { planEmbeddedWrites } from "./bd-embedded-write-lock.ts"
import { readBounded, readBoundedFile } from "./bounded-read.ts"

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

describe("readBoundedFile", () => {
  test("reads a file within the cap, and says why it refuses the rest", () => {
    const dir = join(root, "bounded-file")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "ok.txt"), "hello")
    writeFileSync(join(dir, "big.txt"), "x".repeat(11))
    writeFileSync(join(dir, "locked.txt"), "secret")
    chmodSync(join(dir, "locked.txt"), 0o000)
    expect(readBoundedFile(join(dir, "ok.txt"), 10)).toEqual({ kind: "text", text: "hello" })
    expect(readBoundedFile(join(dir, "big.txt"), 10)).toEqual({ kind: "failed", reason: "larger than 10 bytes" })
    expect(readBoundedFile(join(dir, "nope.txt"), 10)).toEqual({ kind: "failed", reason: "ENOENT: no such file or directory" })
    expect(readBoundedFile(dir, 10)).toEqual({ kind: "failed", reason: "not a regular file" })
    // Root ignores permission bits, so the EACCES case only holds for an ordinary user.
    if (process.getuid?.() !== 0)
      expect(readBoundedFile(join(dir, "locked.txt"), 10)).toEqual({ kind: "failed", reason: "EACCES: permission denied" })
  })
})
