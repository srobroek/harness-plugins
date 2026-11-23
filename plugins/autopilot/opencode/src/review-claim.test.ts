import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as real from "node:fs"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLAIM_DIR, type ClaimFs, takeClaims } from "./review-claim.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claims-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const files = () => (existsSync(join(root, CLAIM_DIR)) ? readdirSync(join(root, CLAIM_DIR)).sort() : [])
const withFs = (over: Partial<ClaimFs>): ClaimFs => ({ linkSync: real.linkSync, mkdirSync: real.mkdirSync, rmSync: real.rmSync, writeFileSync: real.writeFileSync, ...over })
const errno = (code: string) => Object.assign(new Error(code), { code })

describe("takeClaims", () => {
  test("takes every claim and leaves no temporary file", () => {
    expect(takeClaims(root, ["a", "b"], "me")).toEqual({ ok: true })
    expect(files()).toEqual(["a", "b"])
  })

  test("a taken name rolls back the claims taken before it", () => {
    mkdirSync(join(root, CLAIM_DIR), { recursive: true })
    writeFileSync(join(root, CLAIM_DIR, "b"), "x")
    expect(takeClaims(root, ["a", "b"], "me")).toEqual({ ok: false, taken: "b" })
    expect(files()).toEqual(["b"])
  })

  test("a write that fails partway removes its own temporary file and reports an error", () => {
    const fs = withFs({
      writeFileSync: ((path: string) => {
        writeFileSync(path, "partial")
        throw errno("ENOSPC")
      }) as ClaimFs["writeFileSync"],
    })
    expect(takeClaims(root, ["a"], "me", fs)).toMatchObject({ ok: false, error: expect.stringContaining("ENOSPC") })
    expect(files()).toEqual([])
  })

  test("a rollback that cannot remove a claim is reported, not thrown, and the claim stays held", () => {
    mkdirSync(join(root, CLAIM_DIR), { recursive: true })
    writeFileSync(join(root, CLAIM_DIR, "b"), "x")
    const fs = withFs({
      rmSync: ((path: string, options?: object) => {
        if (String(path).endsWith("/a")) throw errno("EPERM")
        return real.rmSync(path, options)
      }) as ClaimFs["rmSync"],
    })
    expect(takeClaims(root, ["a", "b"], "me", fs)).toMatchObject({ ok: false, error: expect.stringContaining("claim a not released") })
    expect(files()).toEqual(["a", "b"])
  })

  test("a temporary file that cannot be removed fails the start and releases the claim", () => {
    const fs = withFs({
      rmSync: ((path: string, options?: object) => {
        if (String(path).includes(".tmp-")) throw errno("EPERM")
        return real.rmSync(path, options)
      }) as ClaimFs["rmSync"],
    })
    expect(takeClaims(root, ["a"], "me", fs)).toMatchObject({ ok: false, error: expect.stringContaining("not removed") })
    expect(files().filter((name) => !name.startsWith(".tmp-"))).toEqual([])
  })
})
