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
const withFs = (over: Partial<ClaimFs>): ClaimFs => ({ closeSync: real.closeSync, linkSync: real.linkSync, mkdirSync: real.mkdirSync, openSync: real.openSync, rmSync: real.rmSync, writeSync: (fd, buffer, offset, length) => real.writeSync(fd, buffer, offset, length), ...over })
const errno = (code: string) => Object.assign(new Error(code), { code })
const failed = (result: ReturnType<typeof takeClaims>) => {
  if (result.ok || "taken" in result) throw new Error("expected an error result")
  return result
}

describe("takeClaims", () => {
  test("takes every claim, writes the owner and leaves no temporary file", () => {
    expect(takeClaims(root, ["a", "b"], "me")).toEqual({ ok: true })
    expect(files()).toEqual(["a", "b"])
    expect(JSON.parse(readFileSync(join(root, CLAIM_DIR, "a"), "utf8"))).toMatchObject({ owner: "me" })
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
      writeSync: ((fd: number, buffer: Uint8Array, offset: number) => {
        real.writeSync(fd, buffer, offset, 3)
        throw boom
      }) as ClaimFs["writeSync"],
    })
    const result = failed(takeClaims(root, ["a"], "me", fs))
    expect(result.error).toBe(boom)
    expect(result.cleanup).toEqual([])
    expect(files()).toEqual([])
  })

  test("a successful short write is continued, so the published claim is never truncated", () => {
    const fs = withFs({
      writeSync: ((fd: number, buffer: Uint8Array, offset: number, length: number) => real.writeSync(fd, buffer, offset, Math.min(length, 5))) as ClaimFs["writeSync"],
    })
    expect(takeClaims(root, ["a"], "me", fs)).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(join(root, CLAIM_DIR, "a"), "utf8"))).toMatchObject({ owner: "me" })
  })

  test("a write that makes no progress is refused and publishes nothing", () => {
    const fs = withFs({ writeSync: (() => 0) as ClaimFs["writeSync"] })
    const result = failed(takeClaims(root, ["a"], "me", fs))
    expect(String(result.error)).toContain("no progress")
    expect(files()).toEqual([])
  })

  test("an exclusive create that collides leaves the competing file at that exact path in place", () => {
    const fs = withFs({
      openSync: ((path: string, flags: string) => {
        writeFileSync(path, "someone else")
        return real.openSync(path, flags)
      }) as ClaimFs["openSync"],
    })
    const result = failed(takeClaims(root, ["a"], "me", fs))
    expect((result.error as NodeJS.ErrnoException).code).toBe("EEXIST")
    const [left] = files()
    expect(files()).toHaveLength(1)
    expect(left).toStartWith(".tmp-")
    expect(readFileSync(join(root, CLAIM_DIR, left as string), "utf8")).toBe("someone else")
  })

  test("a close error does not mask the write error; it is reported in cleanup", () => {
    const boom = errno("ENOSPC")
    const busy = errno("EIO")
    const fs = withFs({
      writeSync: (() => {
        throw boom
      }) as ClaimFs["writeSync"],
      closeSync: ((fd: number) => {
        real.closeSync(fd)
        throw busy
      }) as ClaimFs["closeSync"],
    })
    const result = failed(takeClaims(root, ["a"], "me", fs))
    expect(result.error).toBe(boom)
    expect(result.cleanup).toEqual([{ target: expect.stringContaining("not closed"), error: busy }])
    expect(files()).toEqual([])
  })

  test("a rollback failure after a collision keeps the collision as the error", () => {
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
    expect((result.error as NodeJS.ErrnoException).code).toBe("EEXIST")
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
