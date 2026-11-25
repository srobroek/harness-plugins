import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { GIT_READ, GIT_READ_MAX_BYTES, type GitReadResult, gitRead } from "./git-read.ts"
import agentReviewer from "./index.ts"

// Real git in temporary repositories: the file runs in about 2.3 s on an M-series Mac (measured 2026-11-25).
setDefaultTimeout(30_000)

let root = ""
let repo = ""
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "git-read-")))
  repo = join(root, "repo")
  await git(root, "init", "--quiet", "--initial-branch=main", repo)
  await writeFile(join(repo, "README.md"), "base\n")
  await git(repo, "add", "README.md")
  await git(repo, "commit", "--quiet", "-m", "base commit")
  await git(repo, "switch", "--quiet", "-c", "feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  await git(repo, "commit", "--quiet", "-m", "add the feature")
  await git(repo, "switch", "--quiet", "main")
})
afterAll(() => rm(root, { recursive: true, force: true }))

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  return out.trim()
}

const read = (subcommand: string, ...args: string[]) => gitRead({ subcommand, args }, repo)

describe("git_read runs the reads a reviewer needs", () => {
  test("logs and diffs a branch range", async () => {
    const log = await read("log", "--format=%s", "main..feature")
    expect(log).toMatchObject({ text: "add the feature\n", isError: false })
    const diff = await read("diff", "--name-only", "main..feature")
    expect(diff).toMatchObject({ text: "feature.txt\n", isError: false })
    expect(diff.details).toEqual({ args: ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "main..feature"], exitCode: 0, truncated: false })
  })

  test("lists branches and resolves a merge base", async () => {
    expect((await read("branch", "--list", "--format=%(refname:short)")).text).toBe("feature\nmain\n")
    const base = await git(repo, "rev-parse", "main")
    expect((await read("merge-base", "main", "feature")).text).toBe(`${base}\n`)
  })

  test("runs in the directory `path` names, relative to the session directory", async () => {
    const result = await gitRead({ subcommand: "rev-parse", args: ["--show-toplevel"], path: "repo" }, root)
    expect(result.text).toBe(`${repo}\n`)
  })

  test("reports a failing read with its stderr and exit code", async () => {
    const result = await read("rev-parse", "--verify", "missing")
    expect(result.isError).toBe(true)
    expect(result.text).toContain("[exit 128]")
  })
})

describe("git_read refuses before git starts", () => {
  test("a branch deletion leaves the branch in place", async () => {
    const result = await read("branch", "-D", "feature")
    expect(result).toEqual({
      text: "git_read refused: branch runs only with --list. Nothing ran.",
      isError: true,
      details: { refused: "branch runs only with --list" },
    })
    expect(await git(repo, "branch", "--list", "--format=%(refname:short)")).toBe("feature\nmain")
  })

  test("an output file is never written", async () => {
    const result = await read("log", `--output=${join(root, "written")}`)
    expect(result.isError).toBe(true)
    expect(await Bun.file(join(root, "written")).exists()).toBe(false)
  })
})

test("cuts stdout at the cap and says so", async () => {
  await writeFile(join(root, "big.txt"), "x".repeat(GIT_READ_MAX_BYTES * 3))
  const blob = (await git(repo, "hash-object", "-w", join(root, "big.txt"))).trim()
  const result = await read("cat-file", "-p", blob)
  expect(result.isError).toBe(false)
  expect(result.details).toMatchObject({ truncated: true, exitCode: null })
  expect(result.text.startsWith("x".repeat(GIT_READ_MAX_BYTES))).toBe(true)
  expect(result.text).toContain("output cut at 50 KB")
  expect(result.text.length).toBeLessThan(GIT_READ_MAX_BYTES + 200)
})

describe("git_read runs no program a hostile repository configures", () => {
  let hostile = ""
  const marker = () => join(root, "program-ran")
  const ran = () => Bun.file(marker()).exists()
  beforeAll(async () => {
    hostile = join(root, "hostile")
    await git(root, "clone", "--quiet", repo, hostile)
    const program = join(root, "program")
    // Records that it ran, then passes its input through so a filter or textconv still produces output.
    writeExecutable(program, `#!/bin/sh\necho ran >> ${marker()}\nif [ -n "$1" ] && [ -f "$1" ]; then cat "$1"; else cat; fi\n`)
    for (const [key, value] of [
      ["core.fsmonitor", program],
      ["diff.external", program],
      ["diff.evil.textconv", program],
      ["filter.evil.clean", program],
      ["filter.evil.smudge", program],
      ["log.showSignature", "true"],
      ["gpg.program", program],
    ] as const) {
      await git(hostile, "config", key, value)
    }
    // `.git/info/attributes` is read even with GIT_ATTR_SOURCE set to the empty tree.
    await writeFile(join(hostile, ".git", "info", "attributes"), "* diff=evil filter=evil\n")
    await writeFile(join(hostile, "README.md"), "changed in the work tree\n")
  })

  test("work-tree diff, history with patches, and show stay inert", async () => {
    const results: GitReadResult[] = []
    for (const [subcommand, ...args] of [
      ["diff"],
      ["diff", "HEAD"],
      ["log", "-p", "--all"],
      ["show", "origin/feature"],
      ["ls-files", "-m"],
    ]) {
      results.push(await gitRead({ subcommand: subcommand as string, args }, hostile))
    }
    expect({ errors: results.filter((result) => result.isError).map((result) => result.text), ran: await ran() }).toEqual({ errors: [], ran: false })
    expect(results[0]?.text).toContain("+changed in the work tree")
    // The control: plain git in the same checkout reaches the configured program, so the fixture is live.
    await Bun.spawn(["git", "-C", hostile, "diff"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited
    expect(await ran()).toBe(true)
  })
})

test("the extension registers git_read inactive, for a child's tools list to enable", () => {
  const tools: Array<{ name: string; defaultActive?: boolean }> = []
  const pi = { registerTool: (tool: { name: string; defaultActive?: boolean }) => tools.push(tool), on: () => undefined }
  agentReviewer(pi as unknown as ExtensionAPI)
  expect(tools.map(({ name, defaultActive }) => ({ name, defaultActive }))).toEqual([{ name: GIT_READ, defaultActive: false }])
})
