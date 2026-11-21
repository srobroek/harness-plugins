import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { formatScan, readScanInput, registerScanTool, SCAN_DESCRIPTION, SCAN_TOOL } from "./index.ts"
import { RECIPES } from "./recipes.ts"
import { type Exec, runScan } from "./run.ts"

// Real-process case: a /bin/sh fixture that prints and one that outlives a 2 s deadline.
// Measured 2.2 s alone (the hung fixture waits out its deadline); 30 s leaves headroom for a loaded machine (AGENTS.md, Commands).
setDefaultTimeout(30_000)

const dirs: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "challenge-scan-"))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const exited = (stdout: string, exitCode = 0, stderr = ""): SupervisedRun => ({
  kind: "exited",
  exitCode,
  signalCode: null,
  stdout,
  stderr,
})

const RUFF_HIT = JSON.stringify([
  { code: "PERF401", filename: "a.py", location: { row: 5 }, message: "use a list comprehension" },
  { code: "T201", filename: "a.py", location: { row: 9 }, message: "print found" },
])

function pythonRepo(): string {
  const root = temp()
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname='x'\n")
  writeFileSync(join(root, "a.py"), "print(1)\n")
  return root
}

/** A fake exec answering by a fragment of the tool's argv; records every argv. */
function fakeExec(answers: Record<string, SupervisedRun>, calls: string[][] = []): Exec {
  return async (argv) => {
    calls.push(argv)
    const key = Object.keys(answers).find((k) => argv.join(" ").includes(k))
    return key ? (answers[key] as SupervisedRun) : exited("", 0)
  }
}

const withTools =
  (...names: string[]) =>
  (binary: string) =>
    names.includes(binary) ? `/bin/${binary}` : null

describe("runScan", () => {
  test("normalises hits, assigns lenses and tags rules enabled in the repo", async () => {
    const root = pythonRepo()
    const exec = fakeExec({
      "check --isolated": exited(RUFF_HIT, 1),
      "--show-settings": exited("linter.rules.enabled = [\n\tprint (T201),\n]\n"),
    })
    const report = await runScan({ root, languages: ["python"] }, { exec, which: withTools("ruff") })
    expect(report.candidates).toEqual([
      { lens: "performance", tool: "ruff", rule: "PERF401", file: "a.py", line: 5, message: "use a list comprehension", ruleEnabledInRepo: false },
      { lens: "observability", tool: "ruff", rule: "T201", file: "a.py", line: 9, message: "print found", ruleEnabledInRepo: true },
    ])
    expect(report.coverage.find((c) => c.recipe === "ruff:lenses")).toMatchObject({ status: "ran" })
    expect(report.timings.map((t) => t.recipe)).toContain("ruff:lenses")
  })

  test("keeps only candidates of the requested lenses and skips recipes serving none", async () => {
    const root = pythonRepo()
    const exec = fakeExec({ "check --isolated": exited(RUFF_HIT, 1), "--show-settings": exited("") })
    const report = await runScan({ root, languages: ["python"], lenses: ["observability"] }, { exec, which: withTools("ruff") })
    expect(report.candidates.map((c) => c.rule)).toEqual(["T201"])
    expect(report.coverage.find((c) => c.recipe === "vulture:dead")).toEqual({
      recipe: "vulture:dead",
      tool: "vulture",
      language: "python",
      status: "skipped",
      reason: "serves none of the requested lenses",
    })
  })

  test("a tool that is not installed is a coverage gap, not an error", async () => {
    const root = pythonRepo()
    const report = await runScan({ root, languages: ["python"] }, { exec: fakeExec({}), which: () => null })
    expect(report.coverage.find((c) => c.recipe === "ruff:lenses")).toMatchObject({
      status: "gap",
      reason: "ruff is not installed and no uvx runner is on PATH",
    })
    expect(report.candidates).toEqual([])
  })

  test("quick depth skips analyzers that need a build", async () => {
    const root = temp()
    writeFileSync(join(root, "go.mod"), "module x\n")
    const calls: string[][] = []
    const which = withTools("golangci-lint", "go", "git")
    const report = await runScan({ root, depth: "quick" }, { exec: fakeExec({}, calls), which })
    expect(report.coverage.filter((c) => c.status === "skipped").map((c) => c.recipe)).toEqual(["golangci:lenses", "deadcode:go"])
    expect(calls.some((c) => c.includes("/bin/golangci-lint"))).toBe(false)
  })

  test("an exit code outside the accepted set is a gap carrying the first error line", async () => {
    const root = pythonRepo()
    const exec = fakeExec({ "check --isolated": exited("", 2, "error: invalid value\nmore") })
    const report = await runScan({ root, languages: ["python"] }, { exec, which: withTools("ruff") })
    expect(report.coverage.find((c) => c.recipe === "ruff:lenses")).toMatchObject({
      status: "gap",
      reason: "exit 2: error: invalid value",
    })
  })

  test("a timed-out analyzer is a gap and the scan carries on", async () => {
    const root = pythonRepo()
    const exec: Exec = async (argv) => (argv.includes("--isolated") ? { kind: "timeout", stdout: "", stderr: "" } : exited(""))
    const report = await runScan({ root, languages: ["python"], timeoutSeconds: 7 }, { exec, which: withTools("ruff", "vulture") })
    expect(report.coverage.find((c) => c.recipe === "ruff:lenses")).toMatchObject({ status: "gap", reason: "timed out after 7s" })
    expect(report.coverage.find((c) => c.recipe === "vulture:dead")).toMatchObject({ status: "ran" })
  })

  test("an analyzer that floods its output is a gap naming the stream", async () => {
    const root = pythonRepo()
    const exec: Exec = async (argv) =>
      argv.includes("--isolated") ? { kind: "overflow", stream: "stdout", stdout: "", stderr: "" } : exited("")
    const report = await runScan({ root, languages: ["python"] }, { exec, which: withTools("ruff") })
    expect(report.coverage.find((c) => c.recipe === "ruff:lenses")).toMatchObject({
      status: "gap",
      reason: "stdout exceeded 16 MiB; the tool was ended",
    })
    expect(report.candidates).toEqual([])
  })

  test("the per-analyzer timeout is capped", async () => {
    const root = pythonRepo()
    const seen: number[] = []
    const exec: Exec = async (_argv, options) => {
      seen.push(options.timeoutMs)
      return exited("")
    }
    await runScan({ root, languages: ["python"], timeoutSeconds: 86_400 }, { exec, which: withTools("ruff") })
    expect(Math.max(...seen)).toBe(900_000)
  })

  test("a file list scopes the scan and filters whole-repo recipes to those files", async () => {
    const root = temp()
    writeFileSync(join(root, "go.mod"), "module x\n")
    writeFileSync(join(root, "main.go"), "package main\n")
    writeFileSync(join(root, "other.go"), "package main\n")
    const hits = JSON.stringify({
      Issues: [
        { FromLinter: "unused", Text: "a", Pos: { Filename: "main.go", Line: 1 } },
        { FromLinter: "unused", Text: "b", Pos: { Filename: "other.go", Line: 1 } },
      ],
    })
    const exec = fakeExec({ "--no-config": exited(hits, 1), "linters --json": exited('{"Enabled":[{"name":"unused"}]}') })
    const report = await runScan({ root, files: ["main.go"] }, { exec, which: withTools("golangci-lint") })
    expect(report.languages).toEqual(["go"])
    expect(report.candidates.map((c) => [c.file, c.ruleEnabledInRepo])).toEqual([["main.go", true]])
  })

  test("a symlinked root still yields root-relative files", async () => {
    const real = pythonRepo()
    const link = join(temp(), "link")
    symlinkSync(real, link)
    const abs = JSON.stringify([{ code: "T201", filename: join(realpathSync(real), "a.py"), location: { row: 1 }, message: "m" }])
    const exec = fakeExec({ "check --isolated": exited(abs, 1), "--show-settings": exited("") })
    const report = await runScan({ root: link, languages: ["python"] }, { exec, which: withTools("ruff") })
    expect(report.candidates.map((c) => c.file)).toEqual(["a.py"])
  })

  test("a recipe that needs a repo marker is skipped without one", async () => {
    const root = pythonRepo()
    const report = await runScan({ root, languages: ["python"] }, { exec: fakeExec({}), which: withTools("lint-imports") })
    expect(report.coverage.find((c) => c.recipe === "import-linter:contracts")).toMatchObject({ status: "skipped" })
  })

  test("with a run id the raw output lands under the git dir", async () => {
    const root = pythonRepo()
    const gitDir = join(temp(), ".git")
    mkdirSync(gitDir)
    const exec = fakeExec({
      "rev-parse": exited(`${gitDir}\n`),
      "check --isolated": exited(RUFF_HIT, 1),
      "--show-settings": exited(""),
    })
    const report = await runScan({ root, languages: ["python"], runId: "run-1" }, { exec, which: withTools("ruff", "git") })
    expect(report.rawDir).toBe(join(gitDir, "code-challenge", "run-1", "scan"))
    expect(readFileSync(join(report.rawDir as string, "ruff_lenses.stdout"), "utf8")).toBe(RUFF_HIT)
  })

  test("without a run id rawDir is null", async () => {
    const root = pythonRepo()
    const report = await runScan({ root, languages: ["python"] }, { exec: fakeExec({}), which: withTools("ruff") })
    expect(report.rawDir).toBeNull()
  })

  test("the isolated config is written, and biome's vcs block only with a .gitignore", async () => {
    const root = temp()
    writeFileSync(join(root, "tsconfig.json"), "{}")
    writeFileSync(join(root, "x.ts"), "export {}\n")
    const gitDir = join(temp(), ".git")
    mkdirSync(gitDir)
    const exec = fakeExec({ "rev-parse": exited(gitDir) })
    const which = withTools("oxlint", "biome", "git")
    const without = await runScan({ root, languages: ["ts"], runId: "cfg" }, { exec, which })
    const raw = without.rawDir as string
    expect(existsSync(join(raw, "cfg", "oxlint_perf", "oxlintrc.json"))).toBe(true)
    expect(JSON.parse(readFileSync(join(raw, "cfg", "biome_lenses", "biome.json"), "utf8"))).not.toHaveProperty("vcs")
    writeFileSync(join(root, ".gitignore"), "dist\n")
    const withIgnore = await runScan({ root, languages: ["ts"], runId: "cfg2" }, { exec, which })
    const biome = JSON.parse(readFileSync(join(withIgnore.rawDir as string, "cfg", "biome_lenses", "biome.json"), "utf8"))
    expect(biome.vcs).toEqual({ enabled: true, clientKind: "git", useIgnoreFile: true })
  })
})

describe("real processes", () => {
  test("runs a tool binary, parses its output and keeps going after a hung one", async () => {
    const root = pythonRepo()
    const bin = temp()
    writeExecutable(join(bin, "ruff"), `case "$*" in *--show-settings*) echo '(T201)';; *) echo '${RUFF_HIT}'; exit 1;; esac\n`)
    writeExecutable(join(bin, "vulture"), "exec sleep 30\n")
    const which = (b: string) => (existsSync(join(bin, b)) ? join(bin, b) : null)
    const report = await runScan({ root, languages: ["python"], timeoutSeconds: 2 }, { which })
    expect(report.candidates.map((c) => c.rule)).toEqual(["PERF401", "T201"])
    expect(report.coverage.find((c) => c.recipe === "vulture:dead")).toMatchObject({
      status: "gap",
      reason: "timed out after 2s",
    })
  })
})

describe("recipe table", () => {
  test("recipe ids are unique", () => {
    const ids = RECIPES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("recipes that need a build are exactly the compile-backed analyzers", () => {
    expect(RECIPES.filter((r) => r.needsBuild).map((r) => r.id)).toEqual(["golangci:lenses", "deadcode:go", "clippy:lenses"])
  })

  test("recipes cover the four languages and the shared analyzers", () => {
    expect([...new Set(RECIPES.map((r) => r.language))].sort()).toEqual(["any", "go", "python", "rust", "ts"])
  })
})

describe("tool registration", () => {
  test("input is validated and defaults resolve against the session directory", () => {
    expect(readScanInput({ lenses: ["dead-code", "nope"], depth: "quick" }, "/base")).toMatchObject({
      root: "/base",
      lenses: ["dead-code"],
      depth: "quick",
    })
    expect(readScanInput({ root: "sub" }, "/base")).toMatchObject({ root: "/base/sub" })
    expect(readScanInput({ runId: "../x" }, "/base")).toBe("runId may only hold letters, digits, dot, underscore and dash")
    expect(readScanInput({ timeoutSeconds: 0 }, "/base")).toBe("timeoutSeconds must be a positive number")
  })

  test("formatScan caps the inline candidate list and says so", () => {
    const candidate = { lens: "dead-code", tool: "t", rule: "r", file: "f", line: 1, message: "m", ruleEnabledInRepo: null }
    const report = { root: "/r", languages: [], depth: "standard", candidates: Array.from({ length: 501 }, () => candidate), coverage: [], timings: [], rawDir: null }
    const parsed = JSON.parse(formatScan(report as never))
    expect([parsed.candidates.length, parsed.candidateCount, parsed.truncated]).toEqual([500, 501, true])
  })

  test("registers challenge_scan with a short first description line and disposes it", async () => {
    const fake = createFakeContext()
    const dispose = await registerScanTool(fake.context as never)
    expect(fake.tools.has(SCAN_TOOL)).toBe(true)
    expect((SCAN_DESCRIPTION.split("\n")[0] ?? "").length).toBeLessThanOrEqual(120)
    await dispose()
    expect(fake.tools.has(SCAN_TOOL)).toBe(false)
  })

  test("the tool asks permission, then returns the report as JSON", async () => {
    const fake = createFakeContext()
    const root = pythonRepo()
    const exec = fakeExec({ "check --isolated": exited(RUFF_HIT, 1), "--show-settings": exited("") })
    await registerScanTool(fake.context as never, { exec, which: withTools("ruff") })
    type Execute = (i: unknown, c: unknown) => Promise<{ content: string; metadata: { ok: boolean } }>
    const execute = fake.tools.get(SCAN_TOOL)?.execute as Execute
    const result = await execute({ root, languages: ["python"] }, { sessionID: "s", agent: "a", messageID: "m", id: "t" })
    expect(result.metadata.ok).toBe(true)
    expect(JSON.parse(result.content).candidates).toHaveLength(2)
    expect(fake.asserts.map((a) => [a.action, a.resources])).toEqual([[SCAN_TOOL, [root]]])
  })
})
