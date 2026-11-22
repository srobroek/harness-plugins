import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { addClone, MAX_CLONES, mergeClone, parseClones, readClones, registryFile, settleReceipts, withClone, withoutReceipts } from "./clone-registry.ts"

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

  test("reads a registry file as 0.10.5 wrote it, and a new landing is added beside its entries", async () => {
    const receipts = store()
    const file = registryFile(receipts, SESSION)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify([A, B]))
    expect(readClones(receipts, SESSION)).toEqual([A, B])
    const C = { key: "d".repeat(16), root: "/repos/c", receiptIds: ["r1"] }
    await addClone(receipts, SESSION, C, () => false)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([C, A, B])
  })

  test("a second landing in the same repository adds its receipt id to the entry", async () => {
    const receipts = store()
    await addClone(receipts, SESSION, { ...A, receiptIds: ["r1"] }, () => false)
    await addClone(receipts, SESSION, { ...A, receiptIds: ["r2"] }, () => false)
    expect(readClones(receipts, SESSION)).toEqual([{ ...A, receiptIds: ["r1", "r2"] }])
  })

  test("settling the last receipt removes the entry; an older entry without ids is untouched", async () => {
    const receipts = store()
    const file = registryFile(receipts, SESSION)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify([{ ...A, receiptIds: ["r1", "r2"] }, B]))
    await settleReceipts(receipts, SESSION, A.key, new Set(["r1"]))
    expect(readClones(receipts, SESSION)).toEqual([{ ...A, receiptIds: ["r2"] }, B])
    await settleReceipts(receipts, SESSION, A.key, new Set(["r2"]))
    await settleReceipts(receipts, SESSION, B.key, new Set(["r9"]))
    expect(readClones(receipts, SESSION)).toEqual([B])
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

  test("keeps the parse error as the cause of an unparseable registry's refusal", async () => {
    const receipts = store()
    const file = registryFile(receipts, SESSION)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "{not json")
    const failure = await addClone(receipts, SESSION, B, () => false).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).cause).toBeInstanceOf(SyntaxError)
  })

  test("refuses to replace a registry file it cannot read, naming the cause", async () => {
    const receipts = store()
    await addClone(receipts, SESSION, A, () => false)
    const file = registryFile(receipts, SESSION)
    const before = readFileSync(file, "utf8")
    chmodSync(file, 0o000)
    try {
      const failure = await addClone(receipts, SESSION, B, () => false).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(/EACCES/)
      expect(((failure as Error).cause as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES")
    } finally {
      chmodSync(file, 0o600)
    }
    expect(readFileSync(file, "utf8")).toBe(before)
  })
})

describe("mergeClone and withoutReceipts", () => {
  test("an entry without ids stays without: it means every pending receipt", () => {
    expect(mergeClone(A, { ...A, receiptIds: ["r1"] })).toEqual(A)
    expect(withoutReceipts(A, new Set(["r1"]))).toEqual(A)
  })
  test("the new root wins and the ids are the union", () => {
    expect(mergeClone({ ...A, receiptIds: ["r1"] }, { ...A, root: "/moved", receiptIds: ["r2"] })).toEqual({ ...A, root: "/moved", receiptIds: ["r1", "r2"] })
  })
})
