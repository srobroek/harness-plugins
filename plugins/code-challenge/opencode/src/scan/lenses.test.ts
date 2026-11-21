import { afterAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, exited, fakeExec, temp, withTools } from "./fixtures.ts"
import { RECIPES } from "./recipes.ts"
import { runScan } from "./run.ts"

afterAll(cleanup)

describe("advertised lenses", () => {
  // A hit takes the lens of the first matching rule, else the recipe's first lens, so these are all it can produce.
  test.each(RECIPES.map((r) => [r.id, r] as const))("%s advertises only lenses its rules or fallback can produce", (_id, recipe) => {
    const reachable = new Set<string>([recipe.lenses[0] ?? "simplification", ...(recipe.lensRules ?? []).map(([, lens]) => lens)])
    expect(recipe.lenses.filter((lens) => !reachable.has(lens))).toEqual([])
  })
})

function tsRepo(): string {
  const root = temp()
  writeFileSync(join(root, "package.json"), "{}")
  writeFileSync(join(root, "a.ts"), "")
  return root
}

const status = (report: Awaited<ReturnType<typeof runScan>>, recipe: string) => report.coverage.find((c) => c.recipe === recipe)

describe("selecting a lens a recipe cannot produce", () => {
  test.each([
    ["oxlint:perf", "efficiency", ["oxlint"]],
    ["eslint:e18e", "efficiency", ["eslint"]],
  ] as const)("%s is skipped for %s, not run with every hit dropped", async (recipe, lens, tools) => {
    const root = tsRepo()
    const calls: Parameters<typeof fakeExec>[1] = []
    const report = await runScan({ root, files: ["a.ts"], lenses: [lens] }, { exec: fakeExec({}, calls), which: withTools(...tools) })
    expect(status(report, recipe)).toMatchObject({ status: "skipped", reason: "serves none of the requested lenses" })
    expect(calls.some((c) => c.argv.some((a) => a.endsWith(tools[0])))).toBe(false)
  })

  test("clippy is skipped for stability", async () => {
    const root = temp()
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname="x"\nversion="0.1.0"\n')
    const calls: Parameters<typeof fakeExec>[1] = []
    const report = await runScan(
      { root, languages: ["rust"], lenses: ["stability"] },
      { exec: fakeExec({}, calls), which: withTools("cargo"), approved: new Set(["clippy:lenses"]) },
    )
    expect(status(report, "clippy:lenses")).toMatchObject({ status: "skipped", reason: "serves none of the requested lenses" })
    expect(calls.some((c) => c.argv.includes("clippy"))).toBe(false)
  })

  test("oxlint still yields a stability hit for an eslint( or oxc( rule", async () => {
    const root = tsRepo()
    const out = JSON.stringify({ diagnostics: [{ code: "eslint(no-unused-vars)", message: "m", filename: "a.ts", labels: [{ span: { line: 3 } }] }] })
    const report = await runScan(
      { root, files: ["a.ts"], lenses: ["stability"] },
      { exec: fakeExec({ oxlint: exited(out, 1) }), which: withTools("oxlint") },
    )
    expect(report.candidates.map((c) => [c.tool, c.lens, c.rule])).toEqual([["oxlint", "stability", "eslint(no-unused-vars)"]])
  })
})
