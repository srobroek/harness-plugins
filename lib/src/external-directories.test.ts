import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { externalDirectories, repositoryRoot, sessionRoots } from "./external-directories.ts"

describe("externalDirectories", () => {
  test("keeps only directories outside the roots, as cd-style resources", () => {
    const out = externalDirectories(["/work/repo/sub", "/work/repo", "/other", "/other"], ["/work/repo"])
    expect(out).toEqual([{ resource: "/other/*", save: "/other/*" }])
  })

  test("saves the repository root of an external directory", () => {
    const root = mkdtempSync(join(tmpdir(), "external-directories-"))
    mkdirSync(join(root, ".git"))
    mkdirSync(join(root, "a", "b"), { recursive: true })
    expect(repositoryRoot(join(root, "a", "b"))).toBe(root)
    expect(externalDirectories([join(root, "a")], ["/work"])).toEqual([
      { resource: `${join(root, "a")}/*`, save: `${root}/*` },
    ])
    expect(sessionRoots(join(root, "a"))).toEqual([join(root, "a"), root])
  })
})
