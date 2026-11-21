import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, exited, fakeExec, pythonRepo, temp, withTools } from "./fixtures.ts"
import { readScanInput } from "./index.ts"
import { runScan } from "./run.ts"

afterAll(cleanup)

const ALL_TOOLS = withTools("ruff", "vulture", "lizard", "jscpd", "biome", "oxlint", "git")

describe("path containment", () => {
  test.each([["../outside.py"], ["sub/../../outside.py"], ["/etc/passwd"], ["../*.py"]])("%s is rejected", async (path) => {
    const root = pythonRepo()
    await expect(runScan({ root, files: [path] }, { exec: fakeExec({}), which: ALL_TOOLS })).rejects.toThrow(/outside the root/)
  })

  test("a symlink that leaves the root is rejected when named", async () => {
    const root = pythonRepo()
    const outside = temp()
    writeFileSync(join(outside, "secret.py"), "x = 1\n")
    symlinkSync(join(outside, "secret.py"), join(root, "link.py"))
    await expect(runScan({ root, files: ["link.py"] }, { exec: fakeExec({}), which: ALL_TOOLS })).rejects.toThrow(/outside the root/)
  })

  test("a directory walk and a glob skip symlinks that leave the root instead of following them", async () => {
    const root = pythonRepo()
    const outside = temp()
    writeFileSync(join(outside, "secret.py"), "x = 1\n")
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "ok.py"), "x = 1\n")
    symlinkSync(join(outside, "secret.py"), join(root, "src", "link.py"))
    const calls: Parameters<typeof fakeExec>[1] = []
    const report = await runScan({ root, files: ["src"] }, { exec: fakeExec({}, calls), which: ALL_TOOLS })
    const ruff = calls.find((c) => c.argv.includes("--isolated"))?.argv ?? []
    expect(ruff.slice(ruff.indexOf("--") + 1)).toEqual([join(report.root, "src", "ok.py")])
    const globbed = await runScan({ root, files: ["src/*.py"] }, { exec: fakeExec({}, calls), which: ALL_TOOLS })
    expect(globbed.coverage.find((c) => c.recipe === "ruff:lenses")?.status).toBe("ran")
  })

  test.each([[""], ["."], [".."], ["a/b"], ["a b"], ["-rf"], ["x".repeat(65)]])("run id %p is rejected", async (runId) => {
    const root = pythonRepo()
    await expect(runScan({ root, runId }, { exec: fakeExec({}), which: ALL_TOOLS })).rejects.toThrow(/runId/)
    expect(readScanInput({ runId }, "/base")).toMatch(/runId/)
  })

  test("a run id with dots and dashes inside is accepted", () => {
    expect(readScanInput({ runId: "run-2026.11_21" }, "/base")).toMatchObject({ runId: "run-2026.11_21" })
  })
})

describe("hostile file names", () => {
  test("a file named like an option reaches every tool as an absolute path after --", async () => {
    const root = temp()
    writeFileSync(join(root, "pyproject.toml"), "")
    writeFileSync(join(root, "package.json"), "{}")
    for (const name of ["--config=evil.py", "-x.py", "--fix.ts"]) writeFileSync(join(root, name), "x = 1\n")
    const calls: Parameters<typeof fakeExec>[1] = []
    const report = await runScan(
      { root, files: ["--config=evil.py", "-x.py", "--fix.ts"], languages: ["python", "ts"] },
      { exec: fakeExec({}, calls), which: ALL_TOOLS },
    )
    const toolRuns = calls.filter((c) => c.argv.some((a) => a.includes("evil.py") || a.includes("-x.py") || a.includes("--fix.ts")))
    expect(toolRuns.length).toBeGreaterThanOrEqual(5)
    for (const { argv } of toolRuns) {
      const marker = argv.indexOf("--")
      expect(marker).toBeGreaterThan(0)
      // Nothing the file name could be mistaken for sits before the terminator.
      expect(argv.slice(0, marker).some((a) => a.includes("evil.py") || a.includes("-x.py") || a.includes("--fix.ts"))).toBe(false)
      for (const file of argv.slice(marker + 1)) expect(file.startsWith(`${report.root}/`)).toBe(true)
    }
  })
})

describe("an empty file selection", () => {
  test("a list that matches nothing skips the scan instead of scanning the repository", async () => {
    const root = pythonRepo()
    const calls: Parameters<typeof fakeExec>[1] = []
    const report = await runScan({ root, files: ["nothing/*.py", "missing.py"] }, { exec: fakeExec({}, calls), which: ALL_TOOLS })
    expect(calls.filter((c) => !c.argv.includes("rev-parse"))).toEqual([])
    expect(report.candidates).toEqual([])
    expect(report.coverage).toEqual([
      { recipe: "*", tool: "-", language: "-", status: "skipped", reason: "the file list matched no files" },
    ])
  })
})

describe("marker files", () => {
  test("a marker that is a directory or a huge file is treated as absent instead of read", async () => {
    const root = pythonRepo()
    mkdirSync(join(root, "setup.cfg"))
    writeFileSync(join(root, "pyproject.toml"), `[tool.importlinter]\n${"#".repeat(2 * 1024 * 1024)}`)
    const report = await runScan({ root, languages: ["python"] }, { exec: fakeExec({ x: exited("") }), which: withTools("lint-imports") })
    expect(report.coverage.find((c) => c.recipe === "import-linter:contracts")).toMatchObject({ status: "skipped" })
  })
})
