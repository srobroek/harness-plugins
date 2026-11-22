import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ambientStore, configuredStore } from "./beads-store.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  // realpath: macOS hands out /var/folders/..., a symlink to /private/var/folders/...
  const root = mkdtempSync(join(realpathSync(tmpdir()), "beads-store-"))
  roots.push(root)
  mkdirSync(join(root, "ledger"))
  return root
}

test.each(["metadata.json", "embeddeddolt"])("resolves and canonicalizes a store with %s", (marker) => {
  const root = fixture()
  if (marker === "metadata.json") writeFileSync(join(root, "ledger", marker), "{}")
  else mkdirSync(join(root, "ledger", marker))
  symlinkSync(join(root, "ledger"), join(root, "alias"))
  expect(configuredStore({ store: "alias" }, root)).toBe(join(root, "ledger"))
})

test.each(["missing", "ledger", "", 42, null])("refuses an invalid configured store %j", (store) => {
  expect(() => configuredStore({ store }, fixture())).toThrow(/Invalid beads store option.*metadata.json.*embeddeddolt/)
})

test("an absent option leaves existing store discovery unchanged", () => {
  expect(configuredStore({}, fixture())).toBeUndefined()
})

// bd 1.3.1 store commands, measured with `bd create` against real stores: `BEADS_DIR` first, then the
// `.beads` found from the working directory, and `BEADS_DB` only when none is found
// (cmd/bd/main.go:1351 `FindBeadsDir`, then internal/beads/beads.go `FindDatabasePath`).
describe("the store a bd store command opens without --db or -C", () => {
  // A git checkout with its own `.beads`, a second store, and a directory with no `.beads` above it,
  // built once: `git init` under load takes seconds.
  let base = ""
  let checkout = ""
  let own = ""
  let other = ""
  let bare = ""
  beforeAll(() => {
    base = mkdtempSync(join(realpathSync(tmpdir()), "beads-store-order-"))
    checkout = join(base, "checkout")
    own = join(checkout, ".beads")
    other = join(base, "other", ".beads")
    bare = join(base, "bare")
    for (const dir of [own, other, bare]) mkdirSync(dir, { recursive: true })
    Bun.spawnSync(["git", "init", "-q", checkout])
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  test("an inherited BEADS_DB is ignored inside a checkout with a .beads", () => {
    expect(ambientStore(checkout, { BEADS_DB: join(other, "beads.db") })).toBe(own)
  })

  test.each([
    ["a .beads directory", (store: string) => store],
    ["a database file inside it", (store: string) => join(store, "beads.db")],
    ["its embeddeddolt directory", (store: string) => join(store, "embeddeddolt")],
  ])("with no .beads found, a BEADS_DB naming %s selects the store that holds it", (_name, value) => {
    expect(ambientStore(bare, { BEADS_DB: value(other) })).toBe(other)
  })

  test("with no .beads found, a relative BEADS_DB resolves against the working directory", () => {
    expect(ambientStore(bare, { BEADS_DB: "db/.beads/beads.db" })).toBe(join(bare, "db", ".beads"))
  })

  test("BEADS_DIR beats both the .beads found and BEADS_DB", () => {
    const named = join(checkout, "named", ".beads")
    expect(ambientStore(checkout, { BEADS_DIR: named, BEADS_DB: join(other, "beads.db") })).toBe(named)
  })

  test("with no .beads found and no BEADS_DB there is no store", () => {
    expect(ambientStore(bare, {})).toBeUndefined()
  })
})
