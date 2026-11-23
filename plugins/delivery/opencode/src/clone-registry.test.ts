import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { landingFile, removeLanding, writeLanding } from "@srobroek/opencode-lib/worktree-claims"
import { addClone, MAX_CLONES, mergeClone, parseClones, readClones, registrationNeeded, registryFile, removeClone, settleReceipts, withClone, withoutReceipts } from "./clone-registry.ts"

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

describe("registrationNeeded under registry pressure", () => {
  // Nothing is pending in any clone here: only the target's landing records can keep an entry.
  const nothingPending = () => false
  const fill = async (receipts: NodeJS.ProcessEnv, session: string, from: number) => {
    for (let index = from; index < from + MAX_CLONES; index++) {
      await addClone(receipts, session, { key: index.toString(16).padStart(16, "0"), root: `/repos/${index}` }, (entry) => registrationNeeded(entry, nothingPending))
    }
  }
  const marks = [
    ["its own landing record", (common: string) => writeLanding(common, { receiptId: "r1", worktree: "/w", headRefOid: "a".repeat(40), sessionID: "s", landedAt: 1 })],
    [
      "a landing record that cannot be read",
      (common: string) => {
        mkdirSync(dirname(landingFile(common, "r9")), { recursive: true })
        writeFileSync(landingFile(common, "r9"), "{not json")
      },
    ],
  ] as const
  test.each(marks)("a clone whose target still has %s outlives a full registry, and goes once it is collected", async (_name, mark) => {
    const root = mkdtempSync(join(tmpdir(), "delivery-clones-pressure-"))
    try {
      const receipts = { DELIVERY_RECEIPTS_DIR: join(root, "receipts") }
      const session = "c".repeat(16)
      const commonDir = join(root, "common")
      mark(commonDir)
      await addClone(receipts, session, { ...A, commonDir, receiptIds: ["r1"] }, () => true)
      await fill(receipts, session, 0)
      expect(readClones(receipts, session).map((entry) => entry.key)).toContain(A.key)
      removeLanding(commonDir, "r1")
      removeLanding(commonDir, "r9")
      await fill(receipts, session, MAX_CLONES)
      expect(readClones(receipts, session).map((entry) => entry.key)).not.toContain(A.key)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("readClones", () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
  const store = (): NodeJS.ProcessEnv => {
    const root = mkdtempSync(join(tmpdir(), "delivery-clones-read-"))
    roots.push(root)
    return { DELIVERY_RECEIPTS_DIR: join(root, "receipts") }
  }
  const SESSION = "c".repeat(16)

  test("a registry that does not exist is empty", () => {
    expect(readClones(store(), SESSION)).toEqual([])
  })

  test("a registry that cannot be read is an error naming the cause, never an empty list", async () => {
    const receipts = store()
    await addClone(receipts, SESSION, A, () => false)
    const file = registryFile(receipts, SESSION)
    chmodSync(file, 0o000) // check-test-executables: registry file permission, not a script
    try {
      let failure: unknown
      try {
        readClones(receipts, SESSION)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(((failure as Error).cause as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES")
    } finally {
      chmodSync(file, 0o600) // check-test-executables: registry file permission, not a script
    }
  })

  test("a registry that is not JSON is an error with the parse failure as its cause, never an empty list", () => {
    const receipts = store()
    const file = registryFile(receipts, SESSION)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "{not json")
    expect(() => readClones(receipts, SESSION)).toThrow(/cannot be parsed/)
    let failure: unknown
    try {
      readClones(receipts, SESSION)
    } catch (error) {
      failure = error
    }
    expect((failure as Error).cause).toBeInstanceOf(SyntaxError)
  })

  test("a registry that is JSON but not a list is an error, never an empty list", () => {
    const receipts = store()
    const file = registryFile(receipts, SESSION)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "{}")
    expect(() => readClones(receipts, SESSION)).toThrow(/cannot be parsed as a JSON list/)
  })
})

describe("registry lock failure", () => {
  const updates = [
    ["addClone", (receipts: NodeJS.ProcessEnv, session: string) => addClone(receipts, session, A, () => false)],
    ["settleReceipts", (receipts: NodeJS.ProcessEnv, session: string) => settleReceipts(receipts, session, A.key, new Set(["r1"]))],
  ] as const
  test.each(updates)("%s keeps the original failure as the cause", async (_name, update) => {
    const root = mkdtempSync(join(tmpdir(), "delivery-clones-lock-"))
    const receipts = { DELIVERY_RECEIPTS_DIR: join(root, "receipts") }
    const session = "c".repeat(16)
    const directory = dirname(registryFile(receipts, session))
    mkdirSync(directory, { recursive: true })
    chmodSync(directory, 0o555) // check-test-executables: directory permission, not a script
    try {
      const failure = await update(receipts, session).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain("could not be updated")
      expect(((failure as Error).cause as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES")
    } finally {
      chmodSync(directory, 0o755) // check-test-executables: directory permission, not a script
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("removeClone", () => {
  test("drops one repository and deletes the file when none is left", async () => {
    const root = mkdtempSync(join(tmpdir(), "delivery-clones-remove-"))
    const receipts = { DELIVERY_RECEIPTS_DIR: join(root, "receipts") }
    const session = "c".repeat(16)
    try {
      await addClone(receipts, session, A, () => false)
      await addClone(receipts, session, B, () => false)
      await removeClone(receipts, session, A.key)
      expect(readClones(receipts, session)).toEqual([B])
      await removeClone(receipts, session, B.key)
      expect(readClones(receipts, session)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
