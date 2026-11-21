import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { VALIDATE_TOOL } from "./index.ts"
import { MAX_RUN_FILE_BYTES, validateRun } from "./validate.ts"

// git init + rev-parse measured at ~60 ms each on a loaded machine; 30 s leaves ample headroom.
setDefaultTimeout(30_000)

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: { ok: boolean; errors?: string[] } }>
const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal }

const report = {
  run_id: "20261120-101200-http",
  target: "src/http.ts",
  depth: "standard",
  mode: "autonomous",
  created: "2026-11-20T10:12:00Z",
  lenses: ["stability"],
  summary: { found: 1, accepted: 0, deferred: 1, rejected: 0, dropped: 0 },
  findings: [
    {
      id: "F1",
      lens: "stability",
      title: "unbounded retry",
      location: { path: "src/http.ts", line: 40 },
      also_at: [{ path: "src/client.ts", line: 12 }],
      recurs: 2,
      claim: "the retry loop has no cap",
      evidence: { tier: "proven", detail: "src/http.ts:40-60" },
      impact: "medium",
      blast_radius: "low",
      test_protection: "not-applicable",
      status: "deferred",
    },
  ],
  gaps: [],
}
const line = {
  ts: "2026-11-20T10:15:00Z",
  run_id: "20261120-101200-http",
  phase: "INTAKE",
  kind: "inference",
  subject: "pluggability expected",
  choice: "no",
  reason: "no second provider",
  by: "agent",
}
const good = { "report.json": JSON.stringify(report), "decisions.jsonl": `${JSON.stringify(line)}\n${JSON.stringify(line)}\n` }

let base: string
let repo: string
let runs: string
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "challenge-validate-")))
  repo = join(base, "repo")
  mkdirSync(repo)
  execFileSync("git", ["init", "-q"], { cwd: repo })
  runs = join(repo, ".git", "code-challenge")
  mkdirSync(runs)
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

function runDir(name: string, files: Record<string, string>): string {
  const dir = join(runs, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  return dir
}

async function tool(sessions = [{ id: "ses_1", location: { directory: repo } }]) {
  const fake = createFakeContext({ directory: repo, sessions })
  await plugin.setup(fake.context)
  return fake.tools.get(VALIDATE_TOOL)?.execute as Execute
}

describe("validateRun", () => {
  test("a valid report with recurring locations and a valid decisions log pass", () => {
    expect(validateRun(runDir("ok", good))).toEqual([])
  })

  test("errors name the file and, for the log, the line", () => {
    const dir = runDir("bad", {
      "report.json": JSON.stringify({ ...report, depth: "thorough" }),
      "decisions.jsonl": `${JSON.stringify(line)}\n${JSON.stringify({ ...line, kind: "guess" })}\nnot json\n`,
    })
    const errors = validateRun(dir)
    expect(errors).toHaveLength(3)
    expect(errors[0]).toStartWith("report.json $.depth:")
    expect(errors[1]).toStartWith("decisions.jsonl:2 $.kind:")
    expect(errors[2]).toStartWith("decisions.jsonl:3:")
  })

  test("a missing file keeps the error code, and an empty log is reported", () => {
    const errors = validateRun(runDir("missing", { "decisions.jsonl": "\n" }))
    expect(errors).toEqual(["report.json: ENOENT: no such file or directory", "decisions.jsonl: has no lines"])
  })

  test("an unreadable file keeps its code", () => {
    const dir = runDir("denied", good)
    // A directory where the file belongs: not a regular file, so the code names why.
    rmSync(join(dir, "report.json"))
    mkdirSync(join(dir, "report.json"))
    expect(validateRun(dir)).toEqual(["report.json: not a regular file"])
  })

  test("a symlinked file is refused, never followed", () => {
    const dir = runDir("link-file", { "decisions.jsonl": good["decisions.jsonl"] })
    writeFileSync(join(base, "outside.json"), JSON.stringify(report))
    symlinkSync(join(base, "outside.json"), join(dir, "report.json"))
    expect(validateRun(dir)).toEqual(["report.json: not a regular file"])
  })

  test("a file over the byte cap is refused without being parsed", () => {
    const dir = runDir("big", { ...good, "report.json": " ".repeat(MAX_RUN_FILE_BYTES + 1) })
    expect(validateRun(dir)).toEqual([`report.json: larger than ${MAX_RUN_FILE_BYTES} bytes`])
  })

  test("a FIFO is refused and never blocks the read", () => {
    const dir = runDir("fifo", { "decisions.jsonl": good["decisions.jsonl"] })
    execFileSync("mkfifo", [join(dir, "report.json")])
    expect(validateRun(dir)).toEqual(["report.json: not a regular file"])
  })
})

describe("challenge_validate through the registered tool", () => {
  test("accepts a run directory under the git directory", async () => {
    const result = await (await tool())({ run_dir: runDir("tool-ok", good) }, call)
    expect(result.metadata.ok).toBe(true)
  })

  test.each([
    ["no input", undefined],
    ["a relative path", { run_dir: "code-challenge/x" }],
    ["an empty path", { run_dir: "" }],
    ["a number", { run_dir: 3 }],
    ["an extra property", { run_dir: "/x", extra: 1 }],
  ])("%s returns failure metadata", async (_name, input) => {
    const result = await (await tool())(input, call)
    expect(result.metadata.ok).toBe(false)
  })

  test("a malformed report.json fails with its error", async () => {
    const dir = runDir("tool-bad-report", { ...good, "report.json": "{ nope" })
    const result = await (await tool())({ run_dir: dir }, call)
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toStartWith("report.json:")
  })

  test("a malformed decisions.jsonl fails with its line", async () => {
    const dir = runDir("tool-bad-log", { ...good, "decisions.jsonl": `${JSON.stringify(line)}\n{ nope\n` })
    const result = await (await tool())({ run_dir: dir }, call)
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toStartWith("decisions.jsonl:2:")
  })

  test("a session it cannot read fails closed", async () => {
    await expect((await tool([]))({ run_dir: runDir("tool-nosession", good) }, call)).rejects.toThrow(/cannot read session/)
  })

  test("a directory outside <git-dir>/code-challenge is denied", async () => {
    const outside = join(base, "elsewhere")
    mkdirSync(outside)
    for (const [file, text] of Object.entries(good)) writeFileSync(join(outside, file), text)
    for (const dir of [outside, join(repo, ".git"), runs]) {
      const result = await (await tool())({ run_dir: dir }, call)
      expect({ dir, ok: result.metadata.ok }).toEqual({ dir, ok: false })
      expect(result.content).toContain("run_dir must be inside")
    }
  })

  test("a .. path that climbs out is denied", async () => {
    const inside = runDir("tool-dotdot", good)
    const result = await (await tool())({ run_dir: join(inside, "..", "..", "..") }, call)
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("run_dir must be inside")
    const sneaky = await (await tool())({ run_dir: `${runs}/tool-dotdot/../tool-dotdot` }, call)
    expect(sneaky.metadata.ok).toBe(false)
  })

  test("a symlinked run directory that points outside is denied", async () => {
    const outside = join(base, "elsewhere2")
    mkdirSync(outside)
    for (const [file, text] of Object.entries(good)) writeFileSync(join(outside, file), text)
    symlinkSync(outside, join(runs, "link-dir"))
    const result = await (await tool())({ run_dir: join(runs, "link-dir") }, call)
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("run_dir must be inside")
  })

  test("a symlinked report.json is reported as not a regular file", async () => {
    const dir = runDir("tool-link-file", { "decisions.jsonl": good["decisions.jsonl"] })
    symlinkSync(join(base, "outside.json"), join(dir, "report.json"))
    const result = await (await tool())({ run_dir: dir }, call)
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("report.json: not a regular file")
  })

  test("a linked worktree validates runs under its own git directory", async () => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo })
    const wt = join(base, "wt")
    execFileSync("git", ["worktree", "add", "-q", wt], { cwd: repo })
    const gitDir = realpathSync(execFileSync("git", ["rev-parse", "--git-dir"], { cwd: wt, encoding: "utf8" }).trim().replace(/^(?!\/)/, `${wt}/`))
    const dir = join(gitDir, "code-challenge", "wt-run")
    mkdirSync(dir, { recursive: true })
    for (const [file, text] of Object.entries(good)) writeFileSync(join(dir, file), text)
    const result = await (await tool([{ id: "ses_1", location: { directory: wt } }]))({ run_dir: dir }, call)
    expect(result.metadata.ok).toBe(true)
  })
})
