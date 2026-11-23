import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { challengePrompt } from "./command.ts"
import { FORMULAS, runSetup } from "./formulas.ts"
import { runLibFacts } from "./lib-facts/index.ts"
import { cleanup, exited, fakeExec, withTools } from "./scan/fixtures.ts"
import { runScanTool } from "./scan/index.ts"
import type { ToolCall } from "./tool-call.ts"
import { runValidate } from "./validate.ts"

// git init + rev-parse measured at ~60 ms each on a loaded machine; 30 s leaves ample headroom.
setDefaultTimeout(30_000)

const dirs: string[] = []
const temp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "challenge-handlers-")))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  cleanup()
})

/** A ToolCall whose directory records whether the handler read it. */
function callAt(directory: string): ToolCall & { reads: number } {
  const call = {
    reads: 0,
    directory: async () => {
      call.reads++
      return directory
    },
  }
  return call
}

describe("runValidate", () => {
  test("refuses any input but exactly { run_dir } before reading the session directory", async () => {
    const call = callAt("/nowhere")
    expect(await runValidate({ run_dir: "/x", extra: 1 }, call)).toEqual({ content: "challenge_validate: expected exactly { run_dir }", metadata: { ok: false } })
    expect(call.reads).toBe(0)
  })

  test("checks a run directory under <git-dir>/code-challenge/ and lists each error", async () => {
    const repo = temp()
    execFileSync("git", ["init", "-q"], { cwd: repo })
    const run = join(repo, ".git", "code-challenge", "r1")
    mkdirSync(run, { recursive: true })
    writeFileSync(join(run, "report.json"), "{}")
    const outcome = await runValidate({ run_dir: run }, callAt(repo))
    expect(outcome.metadata.ok).toBe(false)
    expect(outcome.content).toContain("report.json")
    expect(outcome.content).toContain("decisions.jsonl: ENOENT")
  })

  test("refuses a run directory outside the repository's run root", async () => {
    const repo = temp()
    execFileSync("git", ["init", "-q"], { cwd: repo })
    const outcome = await runValidate({ run_dir: temp() }, callAt(repo))
    expect(outcome).toEqual({ content: "challenge_validate: run_dir must be inside <git-dir>/code-challenge/ of the session's repository", metadata: { ok: false } })
  })
})

describe("runSetup", () => {
  test("refuses an empty workspace before reading the session directory or authorizing", async () => {
    const call = callAt("/nowhere")
    let asked = false
    const outcome = await runSetup({ workspace: "" }, call, async () => {
      asked = true
    })
    expect(outcome).toEqual({ content: "challenge_setup: workspace must be a non-empty string", metadata: { ok: false } })
    expect(call.reads).toBe(0)
    expect(asked).toBe(false)
  })

  test("resolves the workspace against the session directory, authorizes it, then copies every formula", async () => {
    const root = temp()
    mkdirSync(join(root, "ws", ".beads"), { recursive: true })
    const asked: Array<[string, boolean]> = []
    const outcome = await runSetup({ workspace: "ws" }, callAt(root), async (target, force) => {
      asked.push([target, force])
    })
    expect(asked).toEqual([[join(root, "ws"), false]])
    expect(outcome.metadata.ok).toBe(true)
    for (const name of FORMULAS) expect(existsSync(join(root, "ws", ".beads", "formulas", `${name}.formula.toml`))).toBe(true)
  })

  test("a refused authorization copies nothing", async () => {
    const root = temp()
    mkdirSync(join(root, ".beads"))
    const refusal = runSetup({}, callAt(root), async () => {
      throw new Error("denied")
    })
    await expect(refusal).rejects.toThrow("denied")
    expect(existsSync(join(root, ".beads", "formulas"))).toBe(false)
  })
})

describe("runLibFacts", () => {
  test("an invalid request is a refusal, not a lookup", async () => {
    let fetched = false
    const fetch = (async () => {
      fetched = true
      return new Response("", { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const outcome = await runLibFacts({ ecosystem: "maven", packages: [{ name: "x" }] }, {}, { fetch })
    expect(outcome).toEqual({ content: "challenge_lib_facts: ecosystem must be one of npm, pypi, crates, go", metadata: { ok: false } })
    expect(fetched).toBe(false)
  })

  test("a valid request returns the facts as JSON text and as metadata", async () => {
    const fetch = (async () => new Response("", { status: 404 })) as unknown as typeof globalThis.fetch
    const outcome = await runLibFacts({ ecosystem: "npm", packages: [{ name: "left-pad" }] }, {}, { fetch, cacheDir: temp(), token: async () => undefined })
    expect(outcome.metadata.ok).toBe(true)
    const facts = outcome.metadata.facts as { ecosystem: string; packages: unknown[] }
    expect(facts.ecosystem).toBe("npm")
    expect(facts.packages).toHaveLength(1)
    expect(JSON.parse(outcome.content)).toEqual(facts)
  })
})

describe("runScanTool", () => {
  const rustRepo = () => {
    const root = temp()
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname="x"\nversion="0.1.0"\n')
    writeFileSync(join(root, "pyproject.toml"), "")
    writeFileSync(join(root, "a.py"), "")
    return root
  }
  const scan = async (input: object) => {
    const calls: Parameters<typeof fakeExec>[1] = []
    const outcome = await runScanTool({ languages: ["rust", "python"], ...input }, callAt(rustRepo()), {
      exec: fakeExec({ clippy: exited(""), "check --isolated": exited("[]") }, calls),
      which: withTools("cargo", "ruff"),
    })
    const coverage = outcome.metadata.coverage as Array<{ recipe: string; status: string; reason?: string }>
    return { outcome, status: (recipe: string) => coverage.find((c) => c.recipe === recipe), calls }
  }

  test("by default static recipes run and a recipe that runs repository code is a gap naming it and allowCode", async () => {
    const { outcome, status, calls } = await scan({})
    expect(outcome.metadata.ok).toBe(true)
    expect(status("ruff:lenses")?.status).toBe("ran")
    expect(status("clippy:lenses")?.status).toBe("gap")
    expect(status("clippy:lenses")?.reason).toMatch(/^not run without allowCode: .*build scripts and procedural macros.*; pass allowCode: true to run it$/)
    expect(calls.some((c) => c.argv.includes("clippy"))).toBe(false)
  })

  test("allowCode runs every recipe", async () => {
    const { status, calls } = await scan({ allowCode: true })
    expect([status("ruff:lenses")?.status, status("clippy:lenses")?.status]).toEqual(["ran", "ran"])
    expect(calls.some((c) => c.argv.includes("clippy"))).toBe(true)
  })

  test("a non-boolean allowCode is refused before anything runs", async () => {
    const { outcome, calls } = await scan({ allowCode: "yes" })
    expect(outcome).toEqual({ content: "challenge_scan: allowCode must be a boolean", metadata: { ok: false } })
    expect(calls).toEqual([])
  })
})

describe("challengePrompt", () => {
  test("a Pi-API host reads the skill (skill:// in OMP); OpenCode keeps the skill tool; the rest is the same", () => {
    expect(challengePrompt("auto quick src", "pi").split("\n\n")[0]).toBe("Read the `code-challenge` skill (`skill://code-challenge` in OMP) and follow it.")
    expect(challengePrompt("auto quick src").split("\n\n")[0]).toBe("Load the `code-challenge` skill with the skill tool and follow it.")
    expect(challengePrompt("auto quick src", "pi").split("\n\n").slice(1)).toEqual(challengePrompt("auto quick src").split("\n\n").slice(1))
  })
})
