import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as real from "node:fs"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLAIM_DIR, type ClaimFs, describeClaimFailure, takeClaims } from "./review-claim.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claims-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const files = () => (existsSync(join(root, CLAIM_DIR)) ? readdirSync(join(root, CLAIM_DIR)).sort() : [])
const withFs = (over: Partial<ClaimFs>): ClaimFs => ({ closeSync: real.closeSync, linkSync: real.linkSync, mkdirSync: real.mkdirSync, openSync: real.openSync, rmSync: real.rmSync, writeSync: real.writeSync, ...over })
const errno = (code: string) => Object.assign(new Error(code), { code })
const failed = (result: ReturnType<typeof takeClaims>) => {
  if (result.ok || "taken" in result) throw new Error("expected an error result")
  return result
}

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

  test("a write that fails partway removes the temporary file this attempt created", () => {
    const boom = errno("ENOSPC")
    const fs = withFs({
      writeSync: ((fd: number) => {
        real.writeSync(fd, "partial")
        throw boom
      }) as ClaimFs["writeSync"],
    })
    const result = failed(takeClaims(root, ["a"], "me", fs))
    expect(result.error).toBe(boom)
    expect(result.cleanup).toEqual([])
    expect(files()).toEqual([])
  })

  test("an exclusive create that collides leaves the pre-existing file in place", () => {
    mkdirSync(join(root, CLAIM_DIR), { recursive: true })
    const existing = join(root, CLAIM_DIR, ".tmp-fixed")
    writeFileSync(existing, "someone else")
    const fs = withFs({ openSync: ((_path: string, flags: string) => real.openSync(existing, flags)) as ClaimFs["openSync"] })
    const result = failed(takeClaims(root, ["a"], "me", fs))
    expect((result.error as NodeJS.ErrnoException).code).toBe("EEXIST")
    expect(readFileSync(existing, "utf8")).toBe("someone else")
    expect(files()).toEqual([".tmp-fixed"])
  })

  test("a rollback that cannot remove a claim keeps the original error, is not thrown, and the claim stays held", () => {
    mkdirSync(join(root, CLAIM_DIR), { recursive: true })
    writeFileSync(join(root, CLAIM_DIR, "b"), "x")
    const eperm = errno("EPERM")
    const fs = withFs({
      rmSync: ((path: string, options?: object) => {
        if (String(path).endsWith("/a")) throw eperm
        return real.rmSync(path, options)
      }) as ClaimFs["rmSync"],
    })
    const result = failed(takeClaims(root, ["a", "b"], "me", fs))
    expect(result.cleanup).toEqual([{ target: "claim a not released", error: eperm }])
    expect(describeClaimFailure(result)).toContain("claim a not released: EPERM")
    expect(files()).toEqual(["a", "b"])
  })

  test("a temporary file that cannot be removed fails the start and releases the claim", () => {
    const eperm = errno("EPERM")
    const fs = withFs({
      rmSync: ((path: string, options?: object) => {
        if (String(path).includes(".tmp-")) throw eperm
        return real.rmSync(path, options)
      }) as ClaimFs["rmSync"],
    })
    const result = failed(takeClaims(root, ["a"], "me", fs))
    expect(result.cleanup).toEqual([{ target: expect.stringContaining("temporary file"), error: eperm }])
    expect(files().filter((name) => !name.startsWith(".tmp-"))).toEqual([])
  })
})
