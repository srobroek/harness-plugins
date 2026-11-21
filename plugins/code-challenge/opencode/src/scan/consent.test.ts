import { afterAll, describe, expect, test } from "bun:test"
import { realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { cleanup, exited, fakeExec, pythonRepo, RUFF_HIT, temp, withTools } from "./fixtures.ts"
import { confirmScan, registerScanTool, SCAN_TOOL } from "./index.ts"
import { consentRisks, runScan } from "./run.ts"

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

describe("consent", () => {
  test("a recipe that runs repository code is a gap without consent and runs with it", async () => {
    const root = rustRepo()
    const calls: Parameters<typeof fakeExec>[1] = []
    const exec = fakeExec({ clippy: exited(CLIPPY_LINE) }, calls)
    const denied = await runScan({ root, languages: ["rust"] }, { exec, which: withTools("cargo") })
    expect(denied.coverage.find((c) => c.recipe === "clippy:lenses")).toMatchObject({ status: "gap" })
    expect(denied.coverage.find((c) => c.recipe === "clippy:lenses")?.reason).toMatch(/^not run without consent: .*build scripts and procedural macros/)
    expect(calls.some((c) => c.argv.includes("clippy"))).toBe(false)
    const allowed = await runScan({ root, languages: ["rust"] }, { exec, which: withTools("cargo"), consent: true })
    expect(allowed.coverage.find((c) => c.recipe === "clippy:lenses")).toMatchObject({ status: "ran" })
    expect(allowed.candidates.map((c) => c.rule)).toEqual(["clippy::needless_range_loop"])
  })

  test("a downloaded one-off needs consent, a local binary of the same tool does not", async () => {
    const root = pythonRepo()
    const oneOff = await runScan({ root, languages: ["python"] }, { exec: fakeExec({ x: exited("[]") }), which: withTools("uvx") })
    const gap = oneOff.coverage.find((c) => c.recipe === "ruff:lenses")
    expect(gap).toMatchObject({ status: "gap" })
    expect(gap?.reason).toMatch(/^not run without consent: downloads and runs ruff==0\.17\.6 with uvx/)
    const local = await runScan({ root, languages: ["python"] }, { exec: fakeExec({ x: exited("[]") }), which: withTools("ruff") })
    expect(local.coverage.find((c) => c.recipe === "ruff:lenses")).toMatchObject({ status: "ran" })
  })

  test("consentRisks lists each recipe that would run code, with what it runs and writes", async () => {
    const root = rustRepo()
    writeFileSync(join(root, "package.json"), "{}")
    const risks = await consentRisks({ root, languages: ["rust", "ts"] }, { exec: fakeExec({}), which: withTools("cargo", "knip", "bunx") })
    expect(risks.map((r) => r.recipe).sort()).toEqual([
      "biome:lenses",
      "clippy:lenses",
      "depcruise:cycles",
      "jscpd:duplication",
      "knip:unused",
      "oxlint:perf",
    ])
    const clippy = risks.find((r) => r.recipe === "clippy:lenses")
    expect(clippy?.reasons.join(" ")).toContain("writes target/")
  })

  test("no risk, no question: only local, static recipes", async () => {
    const root = pythonRepo()
    expect(await consentRisks({ root, languages: ["python"] }, { exec: fakeExec({}), which: withTools("ruff", "vulture") })).toEqual([])
  })
})

describe("the permission prompt", () => {
  test("confirmScan turns an allowed scan with risky recipes into a prompt that names them", () => {
    const evaluation = {
      action: SCAN_TOOL,
      resources: ["/repo"],
      effect: "allow",
      message: undefined as string | undefined,
      metadata: { recipes: [{ recipe: "clippy:lenses", tool: "clippy", reasons: ["builds the crate: runs its build scripts"] }] },
    }
    confirmScan(evaluation)
    expect(evaluation.effect).toBe("ask")
    expect(evaluation.message).toContain("/repo")
    expect(evaluation.message).toContain("clippy:lenses: builds the crate: runs its build scripts")
  })

  test.each([
    ["another action", { action: "shell", effect: "allow", metadata: { recipes: [{ recipe: "r", tool: "t", reasons: ["x"] }] } }],
    ["a denied scan", { action: SCAN_TOOL, effect: "deny", metadata: { recipes: [{ recipe: "r", tool: "t", reasons: ["x"] }] } }],
    ["a scan with no risky recipes", { action: SCAN_TOOL, effect: "allow", metadata: { recipes: [] } }],
  ])("confirmScan leaves %s alone", (_name, partial) => {
    const evaluation = { resources: ["/repo"], message: undefined as string | undefined, ...partial }
    const before = evaluation.effect
    confirmScan(evaluation)
    expect(evaluation.effect).toBe(before)
    expect(evaluation.message).toBeUndefined()
  })

  async function runTool(root: string, reject: boolean) {
    const fake = createFakeContext({
      assert: reject
        ? async () => {
            throw new Error("rejected")
          }
        : undefined,
    })
    const exec = fakeExec({ clippy: exited(CLIPPY_LINE), "check --isolated": exited(RUFF_HIT, 1), "--show-settings": exited("") })
    await registerScanTool(fake.context as never, { exec, which: withTools("cargo", "ruff") })
    type Execute = (i: unknown, c: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>
    const execute = fake.tools.get(SCAN_TOOL)?.execute as Execute
    const result = await execute({ root, languages: ["rust", "python"] }, { sessionID: "s", agent: "a", messageID: "m", id: "t" })
    return { fake, report: JSON.parse(result.content) as { coverage: Array<{ recipe: string; status: string }> } }
  }

  test("the tool asks once for the root, listing the risky recipes, and runs them when approved", async () => {
    const root = rustRepo()
    writeFileSync(join(root, "pyproject.toml"), "")
    writeFileSync(join(root, "a.py"), "")
    const { fake, report } = await runTool(root, false)
    expect(fake.asserts).toHaveLength(1)
    expect(fake.asserts[0]).toMatchObject({ action: SCAN_TOOL, resources: [realpathSync(root)] })
    const listed = (fake.asserts[0] as { metadata?: { recipes?: Array<{ recipe: string }> } }).metadata?.recipes
    expect(listed?.map((r) => r.recipe)).toEqual(["clippy:lenses"])
    expect(report.coverage.find((c) => c.recipe === "clippy:lenses")?.status).toBe("ran")
  })

  test("when the user declines, only the recipes that run no repository code are run", async () => {
    const root = rustRepo()
    writeFileSync(join(root, "pyproject.toml"), "")
    writeFileSync(join(root, "a.py"), "")
    const { report } = await runTool(root, true)
    expect(report.coverage.find((c) => c.recipe === "clippy:lenses")?.status).toBe("gap")
    expect(report.coverage.find((c) => c.recipe === "ruff:lenses")?.status).toBe("ran")
  })

  test("a scan with nothing risky asks nothing", async () => {
    const fake = createFakeContext()
    const root = pythonRepo()
    await registerScanTool(fake.context as never, { exec: fakeExec({ "check --isolated": exited("[]") }), which: withTools("ruff") })
    type Execute = (i: unknown, c: unknown) => Promise<unknown>
    const execute = fake.tools.get(SCAN_TOOL)?.execute as Execute
    await execute({ root, languages: ["python"], lenses: ["performance"] }, { sessionID: "s" })
    expect(fake.asserts).toEqual([])
  })
})
