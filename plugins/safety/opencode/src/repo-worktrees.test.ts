import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  allowWorktreeReads,
  createGitRunner,
  createWorktreeLister,
  type GitRun,
  gitEnv,
  parseWorktrees,
  runGit,
} from "./repo-worktrees.ts"

// Real git processes on a loaded machine.
setDefaultTimeout(30_000)

const base = join(realpathSync(tmpdir()), "opencode")
let dir: string
let n = 0

beforeAll(() => {
  mkdirSync(base, { recursive: true })
  dir = realpathSync(mkdtempSync(join(base, "worktrees-")))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const evaluation = (resources: string[], effect = "ask", action = "external_directory") => ({ action, resources, effect })

/** A repository laid out on disk the way git does: main/.git is the common dir, each lane links back reciprocally. */
function repo(lanes: string[] = ["lane"]) {
  const root = join(dir, `r${n++}`)
  const main = join(root, "main")
  const common = join(main, ".git")
  mkdirSync(join(common, "worktrees"), { recursive: true })
  const paths: Record<string, string> = {}
  for (const name of lanes) {
    const path = join(root, name)
    const admin = join(common, "worktrees", name)
    mkdirSync(path)
    mkdirSync(admin)
    writeFileSync(join(path, ".git"), `gitdir: ${admin}\n`)
    writeFileSync(join(admin, "gitdir"), `${join(path, ".git")}\n`)
    paths[name] = path
  }
  return { root, main, common, paths }
}

const record = (path: string) => `worktree ${path}\0HEAD x\0\0`

/** A git double: `rev-parse` gives the common dir, `worktree list` the given records. */
function fakeGit(common: string, listed: string[], calls: string[][] = []): GitRun {
  return async (args) => {
    calls.push(args)
    if (args[0] === "rev-parse") return `${common}\n`
    return listed.map(record).join("")
  }
}

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
  test("lists the main worktree and reciprocal linked worktrees, and asks git once inside the TTL", async () => {
    const r = repo(["lane", "lane2"])
    const calls: string[][] = []
    let now = 1_000
    const list = createWorktreeLister({ run: fakeGit(r.common, [r.main, r.paths.lane!, r.paths.lane2!], calls), ttlMs: 30_000, now: () => now })
    expect(await list(r.main)).toEqual([r.main, r.paths.lane!, r.paths.lane2!])
    expect(calls.map((c) => c[0])).toEqual(["rev-parse", "worktree"])
    now += 29_000
    await list(r.main)
    expect(calls.length).toBe(2)
    now += 2_000
    await list(r.main)
    expect(calls.length).toBe(4)
  })

  test("drops a listed path that is gone", async () => {
    const r = repo()
    const list = createWorktreeLister({ run: fakeGit(r.common, [r.main, r.paths.lane!, join(r.root, "gone")]) })
    expect(await list(r.main)).toEqual([r.main, r.paths.lane!])
  })

  test("a git failure gives no roots and is retried next time", async () => {
    let calls = 0
    const list = createWorktreeLister({
      run: async () => {
        calls++
        return undefined
      },
    })
    expect(await list("/nowhere")).toEqual([])
    await list("/nowhere")
    expect(calls).toBe(2)
  })

  describe("forged records", () => {
    test("rejects a listed path with no .git", async () => {
      const r = repo()
      const bare = join(r.root, "plain")
      mkdirSync(bare)
      const list = createWorktreeLister({ run: fakeGit(r.common, [r.main, bare]) })
      expect(await list(r.main)).toEqual([r.main])
    })

    test("rejects a .git file that points at another repository's admin directory", async () => {
      const r = repo()
      const other = repo()
      const forged = join(r.root, "forged")
      mkdirSync(forged)
      writeFileSync(join(forged, ".git"), `gitdir: ${join(other.common, "worktrees", "lane")}\n`)
      const list = createWorktreeLister({ run: fakeGit(r.common, [r.main, forged]) })
      expect(await list(r.main)).toEqual([r.main])
    })

    test("rejects a worktree whose admin directory does not point back", async () => {
      const r = repo()
      writeFileSync(join(r.common, "worktrees", "lane", "gitdir"), `${join(r.root, "elsewhere", ".git")}\n`)
      const list = createWorktreeLister({ run: fakeGit(r.common, [r.main, r.paths.lane!]) })
      expect(await list(r.main)).toEqual([r.main])
    })

    test("rejects a symlinked .git file and a .git directory in a linked entry", async () => {
      const r = repo(["a", "b"])
      rmSync(join(r.paths.a!, ".git"))
      writeFileSync(join(r.root, "real-git-file"), `gitdir: ${join(r.common, "worktrees", "a")}\n`)
      symlinkSync(join(r.root, "real-git-file"), join(r.paths.a!, ".git"))
      rmSync(join(r.paths.b!, ".git"))
      mkdirSync(join(r.paths.b!, ".git"))
      const list = createWorktreeLister({ run: fakeGit(r.common, [r.main, r.paths.a!, r.paths.b!]) })
      expect(await list(r.main)).toEqual([r.main])
    })

    test("rejects a main entry whose .git is not the common directory", async () => {
      const r = repo()
      const fake = join(r.root, "fakemain")
      mkdirSync(join(fake, ".git"), { recursive: true })
      const list = createWorktreeLister({ run: fakeGit(r.common, [fake]) })
      expect(await list(r.main)).toEqual([])
    })

    test("rejects a root the current user does not own", async () => {
      const r = repo()
      const list = createWorktreeLister({ run: fakeGit(r.common, [r.main, r.paths.lane!]), uid: () => (process.getuid?.() ?? 0) + 1 })
      expect(await list(r.main)).toEqual([])
    })
  })

  describe("a root swapped after it was cached", () => {
    test("a root replaced by a symlink drops the entry; the next call lists again", async () => {
      const r = repo()
      const calls: string[][] = []
      const list = createWorktreeLister({ run: fakeGit(r.common, [r.main, r.paths.lane!], calls) })
      expect(await list(r.main)).toEqual([r.main, r.paths.lane!])
      const moved = join(r.root, "lane-moved")
      renameSync(r.paths.lane!, moved)
      symlinkSync(moved, r.paths.lane!)
      expect(await list(r.main)).toEqual([])
      expect(calls.length).toBe(2)
      await list(r.main)
      expect(calls.length).toBe(4)
    })

    test("a root replaced by another directory (new inode) drops the entry", async () => {
      const r = repo()
      const list = createWorktreeLister({ run: fakeGit(r.common, [r.main, r.paths.lane!]) })
      expect(await list(r.main)).toEqual([r.main, r.paths.lane!])
      const moved = join(r.root, "lane-moved")
      renameSync(r.paths.lane!, moved)
      mkdirSync(r.paths.lane!)
      expect(await list(r.main)).toEqual([])
    })
  })

  test("concurrent cold lookups share one git run per directory", async () => {
    const r = repo()
    let started = 0
    const run: GitRun = async (args) => {
      if (args[0] === "worktree") started++
      await new Promise((resolve) => setTimeout(resolve, 20))
      return args[0] === "rev-parse" ? `${r.common}\n` : record(r.main)
    }
    const list = createWorktreeLister({ run })
    const results = await Promise.all([list(r.main), list(r.main), list(r.main)])
    expect(started).toBe(1)
    expect(results).toEqual([[r.main], [r.main], [r.main]])
  })

  test("concurrent lookups after the TTL expired also share one run", async () => {
    const r = repo()
    let started = 0
    let now = 0
    const run: GitRun = async (args) => {
      if (args[0] === "worktree") started++
      await new Promise((resolve) => setTimeout(resolve, 20))
      return args[0] === "rev-parse" ? `${r.common}\n` : record(r.main)
    }
    const list = createWorktreeLister({ run, ttlMs: 10, now: () => now })
    await list(r.main)
    now = 100
    await Promise.all([list(r.main), list(r.main)])
    expect(started).toBe(2)
  })
})

describe("allowWorktreeReads", () => {
  let r: ReturnType<typeof repo>
  let outside: string
  beforeAll(() => {
    r = repo()
    outside = join(r.root, "outside")
    mkdirSync(outside)
    symlinkSync(outside, join(r.paths.lane!, "escape"))
  })
  const roots = () => [r.main, r.paths.lane!]

  test("allows a path and a directory pattern in a worktree", () => {
    for (const resource of [join(r.paths.lane!, "src/a.ts"), `${r.main}/*`, r.paths.lane!]) {
      const e = evaluation([resource])
      allowWorktreeReads(e, roots())
      expect(e.effect).toBe("allow")
    }
  })

  test("leaves a path outside every worktree and a ..-escape asking", () => {
    for (const resource of [join(outside, "a"), `${r.paths.lane!}/../outside/a`, r.root]) {
      const e = evaluation([resource])
      allowWorktreeReads(e, roots())
      expect(e.effect).toBe("ask")
    }
  })

  test("leaves a symlink out of the worktree asking", () => {
    const e = evaluation([join(r.paths.lane!, "escape/file")])
    allowWorktreeReads(e, roots())
    expect(e.effect).toBe("ask")
  })

  test("leaves mixed resources and an empty resource list asking", () => {
    const mixed = evaluation([join(r.paths.lane!, "a"), join(outside, "b")])
    allowWorktreeReads(mixed, roots())
    expect(mixed.effect).toBe("ask")
    const empty = evaluation([])
    allowWorktreeReads(empty, roots())
    expect(empty.effect).toBe("ask")
  })

  test("never overrides a deny and ignores other actions and no roots", () => {
    const denied = evaluation([join(r.paths.lane!, "a")], "deny")
    allowWorktreeReads(denied, roots())
    expect(denied.effect).toBe("deny")
    const shell = evaluation([join(r.paths.lane!, "a")], "ask", "shell")
    allowWorktreeReads(shell, roots())
    expect(shell.effect).toBe("ask")
    const none = evaluation([join(r.paths.lane!, "a")])
    allowWorktreeReads(none, [])
    expect(none.effect).toBe("ask")
  })
})

describe("gitEnv", () => {
  test("clears every variable that selects a repository and keeps the rest", () => {
    const selecting = [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CEILING_DIRECTORIES",
      "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    ]
    const env = gitEnv({ ...Object.fromEntries(selecting.map((name) => [name, "/x"])), PATH: "/bin", HOME: "/h" })
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" })
  })
})

describe("createGitRunner", () => {
  test("spawns git with the shared hardening flags and a scrubbed environment", async () => {
    const seen: { argv: string[]; env: Record<string, string | undefined> }[] = []
    const run = createGitRunner({
      env: { GIT_DIR: "/evil", PATH: "/bin" },
      spawn: (argv, options) => {
        seen.push({ argv, env: options.env })
        return {
          pid: process.pid,
          exited: Promise.resolve(0),
          stdout: new Response("out").body,
          stderr: new Response("").body,
          kill() {},
        }
      },
    })
    expect(await run(["worktree", "list"], "/cwd")).toBe("out")
    expect(seen[0]?.argv).toEqual([
      "git",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "--no-optional-locks",
      "worktree",
      "list",
    ])
    expect(seen[0]?.env).toEqual({ PATH: "/bin" })
  })

  test("a lost exit event settles as a failure instead of hanging", async () => {
    const run = createGitRunner({
      spawn: () => ({
        pid: 2 ** 22 + 12345,
        exited: new Promise<number>(() => {}),
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        kill() {},
      }),
      alive: () => false,
      graceMs: 20,
      pollMs: 5,
    })
    const started = Date.now()
    expect(await run(["worktree", "list"], "/cwd")).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("a non-zero exit, a timeout and an abort give no output", async () => {
    const failing = createGitRunner({
      spawn: () => ({ pid: process.pid, exited: Promise.resolve(1), stdout: new Response("x").body, stderr: new Response("").body, kill() {} }),
    })
    expect(await failing(["x"], "/cwd")).toBeUndefined()
    const aborted = new AbortController()
    aborted.abort()
    const hanging = createGitRunner({
      spawn: () => ({
        pid: process.pid,
        exited: new Promise<number>(() => {}),
        stdout: new ReadableStream({}),
        stderr: new ReadableStream({}),
        kill() {},
      }),
      graceMs: 10,
    })
    expect(await hanging(["x"], "/cwd", aborted.signal)).toBeUndefined()
  })
})

describe("runGit (real git)", () => {
  test("lists the linked worktrees of a real repository, and fails soft outside one", async () => {
    const repoDir = join(dir, "real-repo")
    const linked = join(dir, "real-linked")
    mkdirSync(repoDir)
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repoDir, stdout: "ignore", stderr: "ignore" })
      expect(await p.exited).toBe(0)
    }
    await git("init", "-q")
    await git("commit", "-q", "--allow-empty", "-m", "init")
    await git("worktree", "add", "-q", "--detach", linked)
    const list = createWorktreeLister({ run: runGit })
    expect(new Set(await list(repoDir))).toEqual(new Set([realpathSync(repoDir), realpathSync(linked)]))
    // From inside the linked worktree the same repository is found.
    expect(new Set(await createWorktreeLister({ run: runGit })(linked))).toEqual(new Set([realpathSync(repoDir), realpathSync(linked)]))
    expect(await runGit(["rev-parse", "--git-dir"], join(dir, "not-a-repo-dir-missing"))).toBeUndefined()
  })
})
