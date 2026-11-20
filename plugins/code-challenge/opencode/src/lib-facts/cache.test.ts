import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CACHE_TTL_MS, DiskCache, MAX_ENTRY_BYTES } from "./cache.ts"

const dirs: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "lib-facts-cache-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const T0 = Date.UTC(2026, 10, 1)
const value = { body: { n: 1 }, link: null }

describe("DiskCache", () => {
  test("deletes an expired entry when it reads it", () => {
    const dir = scratch()
    new DiskCache(dir, () => T0).put("k", value)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(new DiskCache(dir, () => T0 + CACHE_TTL_MS).get("k")).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })

  test("the first write of an instance sweeps expired files and keeps fresh ones", () => {
    const dir = scratch()
    new DiskCache(dir, () => T0).put("old", value)
    new DiskCache(dir, () => T0 + CACHE_TTL_MS - 1000).put("fresh", value)
    writeFileSync(join(dir, "stale.tmp"), "x")
    new DiskCache(dir, () => T0 + CACHE_TTL_MS + 1000).put("new", value)
    const later = new DiskCache(dir, () => T0 + CACHE_TTL_MS + 1000)
    expect(later.get("old")).toBeUndefined()
    expect(later.get("fresh")).toEqual(value)
    expect(later.get("new")).toEqual(value)
  })

  test("does not store an entry over the size cap", () => {
    const dir = scratch()
    new DiskCache(dir, () => T0).put("big", { body: "x".repeat(MAX_ENTRY_BYTES), link: null })
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })
})
