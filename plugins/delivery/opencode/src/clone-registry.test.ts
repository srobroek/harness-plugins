import { describe, expect, test } from "bun:test"
import { MAX_CLONES, parseClones, withClone } from "./clone-registry.ts"

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
