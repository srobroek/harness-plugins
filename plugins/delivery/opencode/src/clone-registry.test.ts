import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { addClone, MAX_CLONES, parseClones, readClones, registryFile, withClone } from "./clone-registry.ts"

const A = { key: "a".repeat(16), root: "/repos/a" }
const B = { key: "b".repeat(16), root: "/repos/b" }

describe("withClone", () => {
  test("puts the newest landing first and keeps one entry per repository", () => {
    const moved = { key: A.key, root: "/repos/a-moved" }
    expect(withClone([A, B], moved)).toEqual([moved, B])
  })

  test(`past ${MAX_CLONES} repositories, drops the oldest with nothing pending`, () => {
    const many = Array.from({ length: MAX_CLONES }, (_, index) => ({ key: index.toString(16).padStart(16, "0"), root: `/repos/${index}` }))
    const next = withClone(many, B)
    expect(next).toHaveLength(MAX_CLONES)
    expect(next[0]).toEqual(B)
    expect(next.at(-1)).toEqual(many[MAX_CLONES - 2])
  })

  test("keeps a repository with pending receipts past the limit", () => {
    const many = Array.from({ length: MAX_CLONES }, (_, index) => ({ key: index.toString(16).padStart(16, "0"), root: `/repos/${index}` }))
    const oldest = many[MAX_CLONES - 1] as (typeof many)[number]
    const next = withClone(many, B, (entry) => entry === oldest)
    expect(next).toHaveLength(MAX_CLONES)
    expect(next).toContainEqual(oldest)
    expect(next).not.toContainEqual(many[MAX_CLONES - 2])
  })
})

describe("parseClones", () => {
  test.each([
    ["text that is not JSON", "{not json"],
    ["an object instead of a list", JSON.stringify(A)],
    ["a key that is not 16 hex characters", JSON.stringify([{ key: "../x", root: "/repos/x" }])],
    ["a relative root", JSON.stringify([{ key: A.key, root: "repos/a" }])],
  ])("reads nothing from %s", (_name, text) => {
    expect(parseClones(text)).toEqual([])
  })

  test("keeps the well-formed entries beside a malformed one", () => {
    expect(parseClones(JSON.stringify([A, { key: 7 }, B]))).toEqual([A, B])
  })
})

describe("addClone", () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
  /** A receipts root of its own; only `DELIVERY_RECEIPTS_DIR` is read. */
  const store = (): NodeJS.ProcessEnv => {
    const root = mkdtempSync(join(tmpdir(), "delivery-clones-"))
    roots.push(root)
    return { DELIVERY_RECEIPTS_DIR: join(root, "receipts") }
  }
  const SESSION = "c".repeat(16)

  test("adds each repository to the session's file", async () => {
    const receipts = store()
    await addClone(receipts, SESSION, A, () => false)
    await addClone(receipts, SESSION, B, () => false)
    expect(readClones(receipts, SESSION)).toEqual([B, A])
  })

  test("waits for a live writer's lock instead of writing past it", async () => {
    const receipts = store()
    await addClone(receipts, SESSION, A, () => false)
    const file = registryFile(receipts, SESSION)
    mkdirSync(dirname(file), { recursive: true })
    const now = Date.now()
    writeFileSync(`${file}.lock`, JSON.stringify({ host: hostname(), pid: process.pid, owner: "other writer", token: "t", taken: now, expires: now + 60_000 }))
    await expect(addClone(receipts, SESSION, B, () => false, { waitMs: 50 })).rejects.toThrow("could not be updated")
    expect(readClones(receipts, SESSION)).toEqual([A])
  })

  test("refuses to replace a registry file it cannot parse, naming the cause", async () => {
    const receipts = store()
    const file = registryFile(receipts, SESSION)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "{not json")
    await expect(addClone(receipts, SESSION, B, () => false)).rejects.toThrow(/cannot be parsed/)
    expect(readFileSync(file, "utf8")).toBe("{not json")
  })

  test("refuses to replace a registry file it cannot read, naming the cause", async () => {
    const receipts = store()
    await addClone(receipts, SESSION, A, () => false)
    const file = registryFile(receipts, SESSION)
    const before = readFileSync(file, "utf8")
    chmodSync(file, 0o000)
    try {
      await expect(addClone(receipts, SESSION, B, () => false)).rejects.toThrow(/EACCES/)
    } finally {
      chmodSync(file, 0o600)
    }
    expect(readFileSync(file, "utf8")).toBe(before)
  })
})
