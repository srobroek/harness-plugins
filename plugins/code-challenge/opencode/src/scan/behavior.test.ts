import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, temp } from "./fixtures.ts"
import { runScan } from "./run.ts"

// Real analyzers on throwaway repositories: biome and ruff start in about 0.1 s, golangci-lint compiles
// a Go module (about 3 s cold on a loaded machine). 60 s leaves headroom (AGENTS.md, Commands).
setDefaultTimeout(60_000)
afterAll(cleanup)

const installed = (binary: string) => Bun.which(binary) !== null
const git = (root: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" })

function repo(files: Record<string, string>): string {
  const root = temp()
  git(root, "init", "-q")
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
  return root
}

const where = (report: Awaited<ReturnType<typeof runScan>>) => report.candidates.map((c) => c.file)
const only = (report: Awaited<ReturnType<typeof runScan>>, tool: string) => report.candidates.filter((c) => c.tool === tool)

// Every case pairs the protection under test with a control file that must still be reported, so
// removing the protection (or the analysis) fails the test either way.

describe.skipIf(!installed("biome"))("biome (isolated lens profile)", () => {
  const SPREAD = "export const f = (xs: number[]) => xs.reduce((a, x) => ({ ...a, [x]: 1 }), {} as Record<number, number>)\n"
  const SUPPRESSED = `export const g = (xs: number[]) =>\n  // biome-ignore lint/performance/noAccumulatingSpread: fixture\n  xs.reduce((a, x) => ({ ...a, [x]: 1 }), {} as Record<number, number>)\n`
  const files = {
    "bad.ts": SPREAD,
    "ignored.ts": SPREAD,
    "suppressed.ts": SUPPRESSED,
    ".gitignore": "ignored.ts\n",
    // The repo turns the rule off; the lens profile must report it regardless.
    "biome.json": JSON.stringify({ linter: { rules: { performance: { noAccumulatingSpread: "off" } } } }),
  }

  test("reports a rule the repo disabled, but honours .gitignore and inline suppressions", async () => {
    const root = repo(files)
    const report = await runScan({ root, languages: ["ts"], lenses: ["performance"] }, { consent: false })
    const biome = only(report, "biome")
    expect(biome.map((c) => [c.file, c.rule, c.ruleEnabledInRepo])).toEqual([["bad.ts", "performance/noAccumulatingSpread", null]])
    expect(where(report)).not.toContain("ignored.ts")
    expect(where(report)).not.toContain("suppressed.ts")
  })
})

describe.skipIf(!installed("ruff"))("ruff (isolated lens profile)", () => {
  const files = {
    "bad.py": "print(1)\n",
    "ignored.py": "print(2)\n",
    "suppressed.py": "print(3)  # noqa: T201\n",
    ".gitignore": "ignored.py\n",
    // The repo selects only E; T201 must still be reported, and tagged as not enabled there.
    "pyproject.toml": '[tool.ruff.lint]\nselect = ["E"]\n',
  }

  test("reports a rule the repo did not select, but honours .gitignore and noqa", async () => {
    const root = repo(files)
    const report = await runScan({ root, languages: ["python"], lenses: ["observability"] }, { consent: false })
    expect(only(report, "ruff").map((c) => [c.file, c.rule, c.ruleEnabledInRepo])).toEqual([["bad.py", "T201", false]])
  })

  test("a gitignored file named explicitly is still excluded", async () => {
    const root = repo(files)
    const report = await runScan(
      { root, files: ["bad.py", "ignored.py", "suppressed.py"], lenses: ["observability"] },
      { consent: false },
    )
    expect(only(report, "ruff").map((c) => c.file)).toEqual(["bad.py"])
  })
})

describe.skipIf(!installed("golangci-lint") || !installed("go"))("golangci-lint (isolated lens profile)", () => {
  const files = {
    "go.mod": "module fixture\n\ngo 1.22\n",
    "main.go": "package main\n\nfunc main() {}\n\nfunc unusedBad() {}\n",
    "other.go": "package main\n\n//nolint:unused\nfunc unusedSuppressed() {}\n",
    // The repo enables only govet and excludes unusedBad; the lens profile must still report it, tagged as not enabled there.
    ".golangci.yml":
      'version: "2"\nlinters:\n  default: none\n  enable:\n    - govet\n  exclusions:\n    rules:\n      - linters: [unused]\n        text: unusedBad\n',
  }

  test("reports a linter the repo did not enable, but honours //nolint", async () => {
    const root = repo(files)
    const report = await runScan({ root, languages: ["go"], lenses: ["dead-code"] }, { consent: true })
    const hits = only(report, "golangci-lint")
    expect(hits.map((c) => [c.file, c.rule, c.ruleEnabledInRepo])).toEqual([["main.go", "unused", false]])
    expect(hits[0]?.message).toContain("unusedBad")
  })
})
