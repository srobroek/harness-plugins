import { afterAll, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Exec } from "./exec.ts"
import { cleanup, exited, temp, withTools } from "./fixtures.ts"
import { runScan } from "./run.ts"

afterAll(cleanup)

test("a reused runId never lets the previous run's report stand in for a report the tool did not write", async () => {
  const root = temp()
  writeFileSync(join(root, "package.json"), "{}")
  mkdirSync(join(root, ".git"))
  const gitDir = join(root, ".git")
  let write = true
  const exec: Exec = async (argv) => {
    if (argv.includes("rev-parse")) return exited(`${gitDir}\n`)
    if (argv.includes("jscpd") || argv[0]?.endsWith("jscpd")) {
      const out = argv[argv.indexOf("--output") + 1] ?? ""
      if (write) writeFileSync(join(out, "jscpd-report.json"), JSON.stringify({ duplicates: [] }))
      return exited("")
    }
    return exited("")
  }
  const deps = { exec, which: withTools("jscpd", "git") }
  const first = await runScan({ root, languages: ["ts"], runId: "reused" }, deps)
  expect(first.coverage.find((c) => c.recipe === "jscpd:duplication")).toMatchObject({ status: "ran" })

  write = false
  const second = await runScan({ root, languages: ["ts"], runId: "reused" }, deps)
  expect(second.coverage.find((c) => c.recipe === "jscpd:duplication")).toMatchObject({
    status: "gap",
    reason: "the report file jscpd-report.json was not written",
  })
})
