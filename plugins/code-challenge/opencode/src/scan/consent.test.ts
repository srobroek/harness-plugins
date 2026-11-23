import { afterAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { cleanup, exited, fakeExec, pythonRepo, RUFF_HIT, temp, withTools } from "./fixtures.ts"
import { registerScanTool, SCAN_TOOL } from "./index.ts"
import { PINS } from "./pins.ts"
import { runScan } from "./run.ts"

afterAll(cleanup)

function rustRepo(): string {
  const root = temp()
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname="x"\nversion="0.1.0"\n')
  return root
}

const CLIPPY_LINE = JSON.stringify({
  reason: "compiler-message",
  message: { code: { code: "clippy::needless_range_loop" }, message: "m", spans: [{ is_primary: true, file_name: "src/main.rs", line_start: 4 }] },
})

describe("allowCode", () => {
  test("a recipe that runs repository code is a gap by default and runs with allowCode", async () => {
    const root = rustRepo()
    const calls: Parameters<typeof fakeExec>[1] = []
    const exec = fakeExec({ clippy: exited(CLIPPY_LINE) }, calls)
    const gated = await runScan({ root, languages: ["rust"] }, { exec, which: withTools("cargo") })
    expect(gated.coverage.find((c) => c.recipe === "clippy:lenses")).toMatchObject({ status: "gap" })
    expect(gated.coverage.find((c) => c.recipe === "clippy:lenses")?.reason).toMatch(/^not run without allowCode: .*build scripts and procedural macros/)
    expect(calls.some((c) => c.argv.includes("clippy"))).toBe(false)
    const allowed = await runScan({ root, languages: ["rust"], allowCode: true }, { exec, which: withTools("cargo") })
    expect(allowed.coverage.find((c) => c.recipe === "clippy:lenses")).toMatchObject({ status: "ran" })
    expect(allowed.candidates.map((c) => c.rule)).toEqual(["clippy::needless_range_loop"])
  })

  test("a downloaded one-off needs allowCode, a local binary of the same tool does not", async () => {
    const root = pythonRepo()
    const oneOff = await runScan({ root, languages: ["python"] }, { exec: fakeExec({ x: exited("[]") }), which: withTools("uvx") })
    const gap = oneOff.coverage.find((c) => c.recipe === "ruff:lenses")
    expect(gap).toMatchObject({ status: "gap" })
    expect(gap?.reason).toStartWith(`not run without allowCode: downloads and runs ruff==${PINS.ruff} with uvx`)
    expect(gap?.reason).toEndWith("; pass allowCode: true to run it")
    const local = await runScan({ root, languages: ["python"] }, { exec: fakeExec({ x: exited("[]") }), which: withTools("ruff") })
    expect(local.coverage.find((c) => c.recipe === "ruff:lenses")).toMatchObject({ status: "ran" })
  })

  test("every recipe that would run code is a gap that says what it runs and writes", async () => {
    const root = rustRepo()
    writeFileSync(join(root, "package.json"), "{}")
    const report = await runScan({ root, languages: ["rust", "ts"] }, { exec: fakeExec({}), which: withTools("cargo", "knip", "bunx") })
    const gaps = report.coverage.filter((c) => c.reason?.startsWith("not run without allowCode: "))
    expect(gaps.map((c) => c.recipe).sort()).toEqual(["biome:lenses", "clippy:lenses", "depcruise:cycles", "jscpd:duplication", "knip:unused", "oxlint:perf"])
    expect(gaps.find((c) => c.recipe === "clippy:lenses")?.reason).toContain("writes target/")
  })
})

describe("the OpenCode tool", () => {
  async function runTool(input: object) {
    const root = rustRepo()
    writeFileSync(join(root, "pyproject.toml"), "")
    writeFileSync(join(root, "a.py"), "")
    const fake = createFakeContext({ sessions: [{ id: "s", location: { directory: tmpdir() } }] })
    const exec = fakeExec({ clippy: exited(CLIPPY_LINE), "check --isolated": exited(RUFF_HIT, 1), "--show-settings": exited("") })
    await registerScanTool(fake.context as never, { exec, which: withTools("cargo", "ruff") })
    type Execute = (i: unknown, c: unknown) => Promise<{ content: string }>
    const execute = fake.tools.get(SCAN_TOOL)?.execute as Execute
    const result = await execute({ root, languages: ["rust", "python"], ...input }, { sessionID: "s", agent: "a", messageID: "m", id: "t" })
    const report = JSON.parse(result.content) as { coverage: Array<{ recipe: string; status: string }> }
    return { fake, status: (recipe: string) => report.coverage.find((c) => c.recipe === recipe)?.status }
  }

  test("by default it asks nothing, runs the static recipes and leaves the risky ones as gaps", async () => {
    const { fake, status } = await runTool({})
    expect(fake.asserts).toEqual([])
    expect([status("ruff:lenses"), status("clippy:lenses")]).toEqual(["ran", "gap"])
  })

  test("with allowCode it asks nothing and runs every recipe", async () => {
    const { fake, status } = await runTool({ allowCode: true })
    expect(fake.asserts).toEqual([])
    expect([status("ruff:lenses"), status("clippy:lenses")]).toEqual(["ran", "ran"])
  })
})
