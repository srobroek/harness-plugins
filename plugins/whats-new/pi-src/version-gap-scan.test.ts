import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanVersionGaps } from "./version-gap-scan.js"

describe("version_gap_scan", () => {
  test("returns dependency rows from a scratch npm project without network access", async () => {
    const project = mkdtempSync(join(tmpdir(), "whats-new-scan-"))
    try {
      writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { leftpad: "1.3.0" } }))
      const result = await scanVersionGaps(project)
      expect(result.text).toContain("npm\tleftpad\t1.3.0\t?\tdirect")
      expect(result.details).toMatchObject({ count: 1, deps: [{ ecosystem: "npm", name: "leftpad", declared: "1.3.0", resolved: null, direct: true }] })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
