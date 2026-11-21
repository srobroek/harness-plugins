import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Exec } from "./exec.ts"
import { cleanup, exited, fakeExec, pythonRepo, RUFF_HIT, temp, withTools } from "./fixtures.ts"
import { runScan } from "./run.ts"

afterAll(cleanup)

const settings = (...codes: string[]) => `linter.rules.enabled = [\n${codes.map((c) => `\tname (${c}),`).join("\n")}\n]\nother = 1\n`
const ruffHit = (file: string, code: string) => ({ code, filename: file, location: { row: 1 }, message: "m" })

describe("config probes", () => {
  test("the abort signal reaches the ruff and golangci-lint probes", async () => {
    const controller = new AbortController()
    const seen: Array<AbortSignal | undefined> = []
    const exec: Exec = async (argv, options) => {
      if (argv.includes("--show-settings")) seen.push(options.signal)
      return argv.includes("--isolated") ? exited(RUFF_HIT, 1) : exited(settings("T201"))
    }
    await runScan({ root: pythonRepo(), languages: ["python"] }, { exec, which: withTools("ruff") }, controller.signal)
    expect(seen).toEqual([controller.signal])

    const goRoot = temp()
    writeFileSync(join(goRoot, "go.mod"), "module x\n")
    const goSeen: Array<AbortSignal | undefined> = []
    const goExec: Exec = async (argv, options) => {
      if (argv.includes("linters")) goSeen.push(options.signal)
      return argv.includes("linters")
        ? exited('{"Enabled":[]}')
        : exited(JSON.stringify({ Issues: [{ FromLinter: "unused", Text: "t", Pos: { Filename: "m.go", Line: 1 } }] }), 1)
    }
    await runScan({ root: goRoot }, { exec: goExec, which: withTools("golangci-lint"), consent: true }, controller.signal)
    expect(goSeen).toEqual([controller.signal])
  })

  test.each([
    ["exits non-zero", exited("", 2, "boom")],
    ["times out", { kind: "timeout", stdout: "", stderr: "" } as const],
    ["prints no settings", exited("nothing useful")],
    ["overflows", { kind: "overflow", stream: "stdout", stdout: "", stderr: "" } as const],
  ])("a ruff probe that %s leaves ruleEnabledInRepo null, not false", async (_name, probeAnswer) => {
    const exec: Exec = async (argv) => (argv.includes("--show-settings") ? probeAnswer : exited(RUFF_HIT, 1))
    const report = await runScan({ root: pythonRepo(), languages: ["python"] }, { exec, which: withTools("ruff") })
    expect(report.candidates.map((c) => c.ruleEnabledInRepo)).toEqual([null, null])
  })

  test.each([
    ["is not JSON", exited("not json")],
    ["has no Enabled list", exited("{}")],
    ["exits non-zero", exited('{"Enabled":[]}', 3)],
  ])("a golangci-lint probe that %s leaves ruleEnabledInRepo null", async (_name, probeAnswer) => {
    const root = temp()
    writeFileSync(join(root, "go.mod"), "module x\n")
    const issues = JSON.stringify({ Issues: [{ FromLinter: "unused", Text: "t", Pos: { Filename: "m.go", Line: 1 } }] })
    const exec: Exec = async (argv) => (argv.includes("linters") ? probeAnswer : exited(issues, 1))
    const report = await runScan({ root }, { exec, which: withTools("golangci-lint"), consent: true })
    expect(report.candidates.map((c) => c.ruleEnabledInRepo)).toEqual([null])
  })

  test("ruff settings are probed once per config and each hit uses its own config", async () => {
    const root = temp()
    mkdirSync(join(root, "one"))
    mkdirSync(join(root, "two"))
    mkdirSync(join(root, "three"))
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname='x'\n")
    writeFileSync(join(root, "one", "ruff.toml"), "")
    writeFileSync(join(root, "two", "pyproject.toml"), "[tool.ruff]\n")
    writeFileSync(join(root, "three", "pyproject.toml"), "[project]\nname='no-ruff-table'\n")
    for (const f of ["a.py", "one/x.py", "one/y.py", "two/z.py", "three/w.py"]) writeFileSync(join(root, f), "")
    const hits = ["a.py", "one/x.py", "one/y.py", "two/z.py", "three/w.py"].map((f) => ruffHit(f, "T201"))
    const probed: string[] = []
    const exec: Exec = async (argv) => {
      if (!argv.includes("--show-settings")) return exited(JSON.stringify(hits), 1)
      const file = argv[argv.length - 1] ?? ""
      probed.push(file.slice(realpathSync(root).length + 1))
      // Only the config under one/ enables T201.
      return exited(file.includes("/one/") ? settings("T201") : settings("F401"))
    }
    const report = await runScan({ root, languages: ["python"] }, { exec, which: withTools("ruff") })
    // a.py and three/w.py share "no config below the root" (the root pyproject has no [tool.ruff]); one/ and two/ have their own.
    expect(probed.sort()).toEqual(["a.py", "one/x.py", "two/z.py"])
    expect(report.candidates.map((c) => [c.file, c.ruleEnabledInRepo])).toEqual([
      ["a.py", false],
      ["one/x.py", true],
      ["one/y.py", true],
      ["three/w.py", false],
      ["two/z.py", false],
    ])
  })
})

describe("malformed or missing output", () => {
  test("output that is not the tool's format under an accepted exit code is a gap, not zero findings", async () => {
    const exec = fakeExec({ "check --isolated": exited("Traceback (most recent call last):", 1) })
    const report = await runScan({ root: pythonRepo(), languages: ["python"] }, { exec, which: withTools("ruff") })
    expect(report.coverage.find((c) => c.recipe === "ruff:lenses")).toMatchObject({ status: "gap" })
    expect(report.coverage.find((c) => c.recipe === "ruff:lenses")?.reason).toMatch(/^unparseable output: expected a JSON array/)
    expect(report.candidates).toEqual([])
  })

  test("a report file the tool did not write is a gap", async () => {
    const root = temp()
    writeFileSync(join(root, "a.ts"), "")
    const report = await runScan({ root, languages: ["ts"] }, { exec: fakeExec({}), which: withTools("jscpd") })
    expect(report.coverage.find((c) => c.recipe === "jscpd:duplication")).toMatchObject({
      status: "gap",
      reason: "the report file jscpd-report.json was not written",
    })
  })

  test("a report file past the size cap is a gap and is not read", async () => {
    const root = temp()
    writeFileSync(join(root, "a.ts"), "")
    const exec: Exec = async (argv) => {
      const out = argv[argv.indexOf("--output") + 1] as string
      writeFileSync(join(out, "jscpd-report.json"), Buffer.alloc(17 * 1024 * 1024, 0x20))
      return exited("")
    }
    const report = await runScan({ root, languages: ["ts"] }, { exec, which: withTools("jscpd") })
    expect(report.coverage.find((c) => c.recipe === "jscpd:duplication")?.reason).toBe("the report file jscpd-report.json is over 16 MiB")
  })
})

describe("recipe configuration", () => {
  test("eslint's config lives in the tools directory so its plugin resolves from there", async () => {
    const root = temp()
    writeFileSync(join(root, "a.ts"), "")
    const toolsDir = temp()
    mkdirSync(join(toolsDir, "node_modules", ".bin"), { recursive: true })
    writeFileSync(join(toolsDir, "node_modules", ".bin", "eslint"), "")
    const calls: Parameters<typeof fakeExec>[1] = []
    await runScan({ root, languages: ["ts"] }, { exec: fakeExec({ x: exited("[]") }, calls), which: withTools(), toolsDir })
    const argv = calls.find((c) => c.argv[0]?.endsWith("/eslint"))?.argv ?? []
    expect(argv[argv.indexOf("-c") + 1]).toBe(join(toolsDir, "eslint.config.mjs"))
    expect(readFileSync(join(toolsDir, "eslint.config.mjs"), "utf8")).toContain('from "@e18e/eslint-plugin"')
  })

  test("biome's vcs block names the target root", async () => {
    const root = temp()
    writeFileSync(join(root, "a.ts"), "")
    writeFileSync(join(root, ".gitignore"), "dist\n")
    const gitDir = join(temp(), ".git")
    mkdirSync(gitDir)
    const exec = fakeExec({ "rev-parse": exited(gitDir), x: exited("{}") })
    const report = await runScan({ root, languages: ["ts"], runId: "b" }, { exec, which: withTools("biome", "git") })
    const biome = JSON.parse(readFileSync(join(report.rawDir as string, "cfg", "biome_lenses", "biome.json"), "utf8"))
    expect(biome.vcs).toEqual({ enabled: true, clientKind: "git", useIgnoreFile: true, root: realpathSync(root) })
  })

  test("ruff runs with --force-exclude and the terminator before the files", async () => {
    const calls: Parameters<typeof fakeExec>[1] = []
    await runScan({ root: pythonRepo(), languages: ["python"] }, { exec: fakeExec({ x: exited("[]") }, calls), which: withTools("ruff") })
    const argv = calls.find((c) => c.argv.includes("--isolated"))?.argv ?? []
    expect(argv.indexOf("--force-exclude")).toBeGreaterThan(0)
    expect(argv.indexOf("--force-exclude")).toBeLessThan(argv.indexOf("--"))
  })
})
