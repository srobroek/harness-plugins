import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { challengePrompt } from "./command.ts"
import { FORMULAS, runSetup } from "./formulas.ts"
import { runLibFacts } from "./lib-facts/index.ts"
import { cleanup, exited, fakeExec, withTools } from "./scan/fixtures.ts"
import { consentMessage, runScanTool, type ScanConsent } from "./scan/index.ts"
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

describe("runScanTool consent", () => {
  const rustRepo = () => {
    const root = temp()
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname="x"\nversion="0.1.0"\n')
    return root
  }

  test("a plan with a risky recipe asks once, naming it, and runs only after approval", async () => {
    const root = rustRepo()
    const calls: Parameters<typeof fakeExec>[1] = []
    const asked: ScanConsent[] = []
    const outcome = await runScanTool(
      { languages: ["rust"] },
      {
        ...callAt(root),
        consent: async (consent) => {
          asked.push(consent)
        },
      },
      { exec: fakeExec({ clippy: exited("") }, calls), which: withTools("cargo") },
    )
    expect(asked.map((c) => c.risks.map((r) => r.recipe))).toEqual([["clippy:lenses"]])
    expect(asked[0]?.resource).toBe(`${root} [clippy:lenses]`)
    expect(outcome.metadata.ok).toBe(true)
    expect(calls.some((c) => c.argv.includes("clippy"))).toBe(true)
  })

  test("a refused consent propagates and no analyzer runs", async () => {
    const root = rustRepo()
    const calls: Parameters<typeof fakeExec>[1] = []
    const scan = runScanTool(
      { languages: ["rust"] },
      {
        ...callAt(root),
        consent: async () => {
          throw new Error("refused")
        },
      },
      { exec: fakeExec({}, calls), which: withTools("cargo") },
    )
    await expect(scan).rejects.toThrow("refused")
    expect(calls.some((c) => c.argv.includes("clippy"))).toBe(false)
  })

  test("staticOnly asks nothing", async () => {
    const root = rustRepo()
    let asked = false
    const outcome = await runScanTool(
      { languages: ["rust"], staticOnly: true },
      {
        ...callAt(root),
        consent: async () => {
          asked = true
        },
      },
      { exec: fakeExec({}), which: withTools("cargo") },
    )
    expect(asked).toBe(false)
    expect(outcome.metadata.ok).toBe(true)
  })

  test("consentMessage names the root and each recipe with its reasons", () => {
    const message = consentMessage("/repo", [{ recipe: "clippy:lenses", tool: "clippy", reasons: ["builds the crate", "writes target/"] }])
    expect(message).toStartWith("challenge_scan in /repo will run code that is not static analysis.")
    expect(message).toEndWith("\n- clippy:lenses: builds the crate; writes target/")
  })
})

describe("challengePrompt", () => {
  test("a Pi-API host reads the skill (skill:// in OMP); OpenCode keeps the skill tool; the rest is the same", () => {
    expect(challengePrompt("auto quick src", "pi").split("\n\n")[0]).toBe("Read the `code-challenge` skill (`skill://code-challenge` in OMP) and follow it.")
    expect(challengePrompt("auto quick src").split("\n\n")[0]).toBe("Load the `code-challenge` skill with the skill tool and follow it.")
    expect(challengePrompt("auto quick src", "pi").split("\n\n").slice(1)).toEqual(challengePrompt("auto quick src").split("\n\n").slice(1))
  })
})
