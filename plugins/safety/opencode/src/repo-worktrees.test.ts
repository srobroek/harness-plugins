import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allowWorktreeReads, createWorktreeLister, type GitRun, parseWorktrees, runGit } from "./repo-worktrees.ts"

// Real git processes on a loaded machine.
setDefaultTimeout(30_000)

const base = join(realpathSync(tmpdir()), "opencode")
let dir: string
let main: string
let lane: string
let elsewhere: string

beforeAll(() => {
  mkdirSync(base, { recursive: true })
  dir = realpathSync(mkdtempSync(join(base, "worktrees-")))
  main = join(dir, "main")
  lane = join(dir, "lane")
  elsewhere = join(dir, "elsewhere")
  for (const path of [main, lane, elsewhere]) mkdirSync(path)
  symlinkSync(elsewhere, join(lane, "escape"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const evaluation = (resources: string[], effect = "ask", action = "external_directory") => ({ action, resources, effect })

describe("parseWorktrees", () => {
  test("reads NUL-separated porcelain records and skips a bare repository", () => {
    const out = ["worktree /a", "HEAD abc", "branch refs/heads/main", "", "worktree /b.git", "bare", "", "worktree /c", "detached", "", ""].join("\0")
    expect(parseWorktrees(out)).toEqual(["/a", "/c"])
  })

  test("keeps a path with a newline whole", () => {
    expect(parseWorktrees("worktree /a\nb\0HEAD x\0\0")).toEqual(["/a\nb"])
  })
})

describe("createWorktreeLister", () => {
  const output = () => `worktree ${main}\0HEAD x\0\0worktree ${lane}\0HEAD y\0\0worktree ${join(dir, "gone")}\0HEAD z\0\0`

  test("lists the existing worktrees and asks git once inside the TTL", async () => {
    const calls: string[][] = []
    let now = 1_000
    const run: GitRun = async (args, cwd) => {
      calls.push([cwd, ...args])
      return output()
    }
    const list = createWorktreeLister({ run, ttlMs: 30_000, now: () => now })
    expect(await list(main)).toEqual([main, lane])
    now += 29_000
    await list(main)
    expect(calls).toEqual([[main, "worktree", "list", "--porcelain", "-z"]])
    now += 2_000
    await list(main)
    expect(calls.length).toBe(2)
    await list(lane)
    expect(calls.length).toBe(3)
  })

  test("a git failure gives no roots and is retried next time", async () => {
    let calls = 0
    const list = createWorktreeLister({
      run: async () => {
        calls++
        return undefined
      },
    })
    expect(await list(main)).toEqual([])
    await list(main)
    expect(calls).toBe(2)
  })
})

describe("allowWorktreeReads", () => {
  const roots = () => [main, lane]

  test("allows a path and a directory pattern in a worktree", () => {
    for (const resource of [join(lane, "src/a.ts"), `${main}/*`, lane]) {
      const e = evaluation([resource])
      allowWorktreeReads(e, roots())
      expect(e.effect).toBe("allow")
    }
  })

  test("leaves a path outside every worktree and a ..-escape asking", () => {
    for (const resource of [join(elsewhere, "a"), `${lane}/../elsewhere/a`, dir]) {
      const e = evaluation([resource])
      allowWorktreeReads(e, roots())
      expect(e.effect).toBe("ask")
    }
  })

  test("leaves a symlink out of the worktree asking", () => {
    const e = evaluation([join(lane, "escape/file")])
    allowWorktreeReads(e, roots())
    expect(e.effect).toBe("ask")
  })

  test("leaves mixed resources asking", () => {
    const e = evaluation([join(lane, "a"), join(elsewhere, "b")])
    allowWorktreeReads(e, roots())
    expect(e.effect).toBe("ask")
  })

  test("never overrides a deny and ignores other actions and no roots", () => {
    const denied = evaluation([join(lane, "a")], "deny")
    allowWorktreeReads(denied, roots())
    expect(denied.effect).toBe("deny")
    const shell = evaluation([join(lane, "a")], "ask", "shell")
    allowWorktreeReads(shell, roots())
    expect(shell.effect).toBe("ask")
    const none = evaluation([join(lane, "a")])
    allowWorktreeReads(none, [])
    expect(none.effect).toBe("ask")
  })
})

describe("runGit", () => {
  test("lists the linked worktrees of a real repository, and fails soft outside one", async () => {
    const repo = join(dir, "repo")
    const linked = join(dir, "repo-linked")
    mkdirSync(repo)
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" })
      expect(await p.exited).toBe(0)
    }
    await git("init", "-q")
    await git("commit", "-q", "--allow-empty", "-m", "init")
    await git("worktree", "add", "-q", "--detach", linked)
    const list = createWorktreeLister({ run: runGit })
    expect(new Set(await list(repo))).toEqual(new Set([realpathSync(repo), realpathSync(linked)]))
    expect(await runGit(["worktree", "list"], join(dir, "elsewhere"))).toBeUndefined()
  })
})
