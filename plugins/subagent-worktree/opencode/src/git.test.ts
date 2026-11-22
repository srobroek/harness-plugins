import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { env } from "node:process"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { createGit, spawnRunner } from "./git.ts"
import { mergeArgs, parseWorktrees } from "./lane.ts"

// Real git repositories: 1.6 s at load average 49; 30 s leaves headroom for a loaded machine (AGENTS.md, Testing).
setDefaultTimeout(30_000)

describe("createGit().isUnborn on real repositories", () => {
  let root: string
  const git = createGit(spawnRunner)
  const sh = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await child.exited).toBe(0)
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-unborn-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  test("is true after git init and false after the first commit", async () => {
    const repo = join(root, "repo")
    await sh(root, "init", "--quiet", repo)
    expect(await git.isUnborn(repo)).toBe(true)
    expect(await git.commit(repo, "HEAD")).toBeUndefined()
    await sh(repo, "commit", "--quiet", "--allow-empty", "-m", "init")
    expect(await git.isUnborn(repo)).toBe(false)
    expect(await git.commit(repo, "HEAD")).toBeTruthy()
  })

  test("is false outside a repository", async () => {
    const plain = await mkdtemp(join(root, "plain-"))
    expect(await git.isUnborn(plain)).toBe(false)
  })

  test("worktrees lists a checkout whose path holds a newline as one entry", async () => {
    const repo = await mkdtemp(join(root, "listing-"))
    await sh(repo, "init", "--quiet", "--initial-branch=main")
    await sh(repo, "commit", "--quiet", "--allow-empty", "-m", "init")
    const odd = join(root, "odd\nname")
    await sh(repo, "worktree", "add", "--quiet", "-b", "lane", odd)
    // A line-based listing would split the newline in the path into a second record that lacks its branch.
    const entries = parseWorktrees((await git.worktrees(repo)) ?? "")
    expect(entries?.map((entry) => entry.branch).sort()).toEqual(["lane", "main"])
    expect(entries?.some((entry) => entry.directory.endsWith("odd\nname"))).toBe(true)
  })

  test("trackedDirty includes staged and unstaged changes but excludes untracked files", async () => {
    const repo = await mkdtemp(join(root, "dirty-"))
    await sh(repo, "init", "--quiet")
    await writeFile(join(repo, "tracked.txt"), "first")
    await sh(repo, "add", "tracked.txt")
    await sh(repo, "commit", "--quiet", "-m", "init")
    expect(await git.trackedDirty(repo)).toBe(false)
    await writeFile(join(repo, "untracked.txt"), "new")
    expect(await git.trackedDirty(repo)).toBe(false)
    await writeFile(join(repo, "tracked.txt"), "second")
    expect(await git.trackedDirty(repo)).toBe(true)
    await sh(repo, "add", "tracked.txt")
    expect(await git.trackedDirty(repo)).toBe(true)
    await sh(repo, "commit", "--quiet", "-m", "update")
    expect(await git.trackedDirty(repo)).toBe(false)
  })

  test("unpushed counts commits the upstream lacks, and is undefined without an upstream", async () => {
    const remote = join(root, "remote.git")
    const repo = join(root, "pushed")
    await sh(root, "init", "--quiet", "--bare", remote)
    await sh(root, "init", "--quiet", "-b", "main", repo)
    await sh(repo, "commit", "--quiet", "--allow-empty", "-m", "init")
    expect(await git.unpushed(repo)).toBeUndefined()
    await sh(repo, "remote", "add", "origin", remote)
    await sh(repo, "push", "--quiet", "-u", "origin", "main")
    expect(await git.unpushed(repo)).toBe(0)
    await sh(repo, "commit", "--quiet", "--allow-empty", "-m", "local")
    expect(await git.unpushed(repo)).toBe(1)
  })

  test("trackedDirty ignores the tracked Beads export, from any subdirectory", async () => {
    const repo = await mkdtemp(join(root, "beads-"))
    await sh(repo, "init", "--quiet")
    await mkdir(join(repo, ".beads"))
    await mkdir(join(repo, "sub"))
    await writeFile(join(repo, ".beads", "issues.jsonl"), "{}\n")
    await writeFile(join(repo, "sub", "tracked.txt"), "first")
    await writeFile(join(repo, "top.txt"), "first")
    await sh(repo, "add", ".")
    await sh(repo, "commit", "--quiet", "-m", "init")
    await writeFile(join(repo, ".beads", "issues.jsonl"), "{}\n{}\n")
    expect(await git.trackedDirty(repo)).toBe(false)
    expect(await git.trackedDirty(join(repo, "sub"))).toBe(false)
    await writeFile(join(repo, "top.txt"), "second")
    expect(await git.trackedDirty(join(repo, "sub"))).toBe(true)
  })
})

describe("automatic git calls", () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-auto-"))
    const init = Bun.spawn(["git", "init", "--quiet", root], { stdout: "ignore", stderr: "ignore" })
    expect(await init.exited).toBe(0)
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  test("git runs with GIT_NO_LAZY_FETCH=1", async () => {
    // An alias that prints the variable shows what the child sees.
    const result = await spawnRunner(["git", "-C", root, "-c", 'alias.lazy=!printf %s "$GIT_NO_LAZY_FETCH"', "lazy"])
    expect(result.stdout).toBe("1")
  })

  test("changedFiles refuses a target that git would read as an option, and writes no file", async () => {
    const output = join(root, "diff-output")
    expect(await createGit(spawnRunner).changedFiles(root, `--output=${output}`)).toBeUndefined()
    expect(await Bun.file(output).exists()).toBe(false)
  })

  test("unsupported reports git older than 2.45 with the exact message", async () => {
    const old = createGit(async () => ({ code: 0, stdout: "git version 2.44.0\n", stderr: "" }))
    expect(await old.unsupported()).toBe("subagent-worktree needs git 2.45+ for safe automatic merges")
    const current = createGit(async () => ({ code: 0, stdout: "git version 2.45.0\n", stderr: "" }))
    expect(await current.unsupported()).toBeUndefined()
  })
})

// Needs a real worktrunk: it is what reads .config/wt.toml.
describe.skipIf(!Bun.which("wt"))("automatic merge against a repository with a committed wt project hook (CWE-78)", () => {
  let root: string
  const saved: Record<string, string | undefined> = {}
  const sandbox = (name: string) => join(root, name)
  const git = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await child.exited).toBe(0)
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-wthook-"))
    // Keep wt's user config and approvals out of the real home.
    for (const [name, value] of Object.entries({
      HOME: sandbox("home"),
      XDG_CONFIG_HOME: sandbox("xdg-config"),
      XDG_DATA_HOME: sandbox("xdg-data"),
      XDG_STATE_HOME: sandbox("xdg-state"),
      WORKTRUNK_CONFIG_PATH: sandbox("wt-config.toml"),
    })) {
      saved[name] = process.env[name]
      process.env[name] = value
    }
  })
  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  })

  test("merges the lane and runs none of the project's hooks", async () => {
    const main = sandbox("main")
    const lane = sandbox("lane")
    // pre-* hooks run in the foreground, so their marker is final when wt returns. post-merge runs in the
    // background and writes its own marker, which signals completion.
    const marker = sandbox("hook-ran")
    const postMarker = sandbox("post-merge-done")
    await mkdir(main, { recursive: true })
    await git(main, "init", "--quiet", "-b", "main")
    await mkdir(join(main, ".config"))
    await writeFile(join(main, ".config", "wt.toml"), `pre-merge = "touch ${marker}"\npre-commit = "touch ${marker}"\npost-merge = "touch ${postMarker}"\n`)
    await git(main, "add", "-A")
    await git(main, "commit", "--quiet", "-m", "init")
    await git(main, "worktree", "add", "--quiet", "-b", "lane", lane)
    await writeFile(join(lane, "work.txt"), "work")
    await git(lane, "add", "-A")
    await git(lane, "commit", "--quiet", "-m", "work")

    // Positive control: without --no-hooks (and with -y, which approves the project hooks) the same wt run fires them.
    const control = await spawnRunner([...mergeArgs(lane, "main").filter((a) => a !== "--no-hooks"), "-y"])
    expect({ code: control.code, stderr: control.stderr }).toEqual({ code: 0, stderr: expect.any(String) })
    expect(await Bun.file(marker).exists()).toBe(true)
    const end = Date.now() + 15_000
    while (!(await Bun.file(postMarker).exists()) && Date.now() < end) await Bun.sleep(25)
    expect(await Bun.file(postMarker).exists()).toBe(true)
    await rm(marker)
    // The control merged the lane; give the guarded run new work to merge.
    await writeFile(join(lane, "more.txt"), "more")
    await git(lane, "add", "-A")
    await git(lane, "commit", "--quiet", "-m", "more")

    const result = await spawnRunner(mergeArgs(lane, "main"))

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: expect.any(String) })
    expect(await Bun.file(join(main, "more.txt")).exists()).toBe(true)
    expect(await Bun.file(marker).exists()).toBe(false)
  })
})

describe("createGit() in a checkout whose config and attributes select a filter driver", () => {
  let root: string
  const git = createGit(spawnRunner)
  const sh = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "ignore", stderr: "ignore" })
    expect(await child.exited).toBe(0)
  }
  /**
   * A committed repository whose `a.txt` was rewritten with content of the same size and dated to the past, so git must
   * hash it (and so run a clean filter) to see the change. `attributes` go to `.git/info/attributes`: unlike a work-tree
   * `.gitattributes`, the empty `GIT_ATTR_SOURCE` of the hardened environment does not cover that file.
   */
  const repoWithEditedFile = async (attributes: string | Buffer = "") => {
    const repo = await mkdtemp(join(root, "repo-"))
    await sh(repo, "init", "--quiet", "--initial-branch=main")
    await writeFile(join(repo, "a.txt"), "first\n")
    await sh(repo, "add", ".")
    await sh(repo, "commit", "--quiet", "-m", "init")
    if (attributes.length > 0) await writeFile(join(repo, ".git", "info", "attributes"), attributes)
    await writeFile(join(repo, "a.txt"), "other\n")
    await utimes(join(repo, "a.txt"), 946_684_800, 946_684_800)
    return { repo, marker: join(repo, "..", `${repo.split("/").at(-1)}.ran`) }
  }
  const ran = (marker: string) => Bun.file(marker).exists()
  const globalConfig = () => join(root, "global.gitconfig")
  let savedGlobal: string | undefined

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-hostile-"))
    // The user's own global config is trusted; each test writes the one it needs.
    savedGlobal = env.GIT_CONFIG_GLOBAL
    env.GIT_CONFIG_GLOBAL = globalConfig()
    await writeFile(globalConfig(), "")
  })
  afterAll(async () => {
    if (savedGlobal === undefined) delete env.GIT_CONFIG_GLOBAL
    else env.GIT_CONFIG_GLOBAL = savedGlobal
    await rm(root, { recursive: true, force: true })
  })

  // Each read that compares the work tree with the index or HEAD hashes changed files, which runs clean filters.
  // Each returns what shows that it saw the exact change: the dirty flag, the porcelain line, or the file name.
  const reads = [
    ["status", (repo: string) => git.status(repo, "HEAD").then((s) => s?.dirty)],
    ["porcelain", (repo: string) => git.porcelain(repo)],
    ["trackedDirty", (repo: string) => git.trackedDirty(repo)],
    ["localFiles", (repo: string) => git.localFiles(repo)],
  ] as const
  const sawTheChange: Record<(typeof reads)[number][0], unknown> = { status: true, porcelain: "M a.txt", trackedDirty: true, localFiles: ["a.txt"] }

  test("the fixture is live: the hardened environment alone does not stop the filter", async () => {
    const { repo, marker } = await repoWithEditedFile("a.txt filter=evil\n")
    await sh(repo, "config", "filter.evil.clean", `touch '${marker}'; cat`)
    const result = await spawnRunner(["git", "-C", repo, "status", "--porcelain"])
    expect({ code: result.code, out: result.stdout.trim(), ran: await ran(marker) }).toEqual({ code: 0, out: "M a.txt", ran: true })
  })

  test.each(reads)("%s does not run the clean filter .git/info/attributes selects, and still sees the change", async (name, read) => {
    const { repo, marker } = await repoWithEditedFile("a.txt filter=evil\n")
    await sh(repo, "config", "filter.evil.clean", `touch '${marker}'; cat`)
    await sh(repo, "config", "filter.evil.required", "true")
    expect(await read(repo)).toEqual(sawTheChange[name] as never)
    expect(await ran(marker)).toBe(false)
  })

  test.each(reads)("%s does not run a clean filter whose driver name is empty", async (name, read) => {
    const { repo, marker } = await repoWithEditedFile("a.txt filter=\n")
    await appendFile(join(repo, ".git", "config"), `[filter ""]\n\tclean = touch '${marker}'; cat\n`)
    expect(await read(repo)).toEqual(sawTheChange[name] as never)
    expect(await ran(marker)).toBe(false)
  })

  // A driver name that is not UTF-8 cannot be passed back to git as a `-c` key, so every read refuses.
  const refusals = [
    ["status", (repo: string) => git.status(repo, "HEAD")],
    ["porcelain", (repo: string) => git.porcelain(repo)],
    ["trackedDirty", (repo: string) => git.trackedDirty(repo).catch(() => undefined)],
    ["localFiles", (repo: string) => git.localFiles(repo)],
  ] as const

  test.each(refusals)("%s refuses, without running it, a filter whose driver name is not UTF-8", async (_, read) => {
    const name = Buffer.from([0xff, 0xfe])
    const { repo, marker } = await repoWithEditedFile(Buffer.concat([Buffer.from("a.txt filter="), name, Buffer.from("\n")]))
    await appendFile(join(repo, ".git", "config"), Buffer.concat([Buffer.from('[filter "'), name, Buffer.from(`"]\n\tclean = touch '${marker}'; cat\n`)]))
    expect(await read(repo)).toBeUndefined()
    expect(await ran(marker)).toBe(false)
  })

  test.each([
    ["a dotted, mixed-case driver name", "Ev.il", "filter.Ev.il.process"],
    ["a long-running process filter", "evil", "filter.evil.process"],
  ])("status does not run %s", async (_, driver, key) => {
    const { repo, marker } = await repoWithEditedFile(`a.txt filter=${driver}\n`)
    await sh(repo, "config", key, `touch '${marker}'; cat`)
    expect((await git.status(repo, "HEAD"))?.dirty).toBe(true)
    expect(await ran(marker)).toBe(false)
  })

  test("status does not run a clean filter that a conditional include defines", async () => {
    const { repo, marker } = await repoWithEditedFile("a.txt filter=evil\n")
    const included = join(repo, "..", `${repo.split("/").at(-1)}.inc`)
    await writeFile(included, `[filter "evil"]\n\tclean = touch '${marker}'; cat\n`)
    await sh(repo, "config", "includeIf.onbranch:main.path", included)
    expect((await git.status(repo, "HEAD"))?.dirty).toBe(true)
    expect(await ran(marker)).toBe(false)
  })

  test("status does not run a global filter driver whose program the checkout supplies", async () => {
    const { repo, marker } = await repoWithEditedFile("a.txt filter=mine\n")
    // git runs a filter from the work tree root, so a relative command is the checkout's own file.
    writeExecutable(join(repo, "clean.sh"), `#!/bin/sh\ntouch '${marker}'\ncat\n`)
    await writeFile(globalConfig(), `[filter "mine"]\n\tclean = ./clean.sh\n`)
    try {
      expect((await git.status(repo, "HEAD"))?.dirty).toBe(true)
      expect(await ran(marker)).toBe(false)
    } finally {
      await writeFile(globalConfig(), "")
    }
  })

  test.each([
    ["git failed to list them", { code: 128, stdout: "", stderr: "fatal: bad config line 1" }],
    ["the listing was cut off", { code: 0, stdout: "filter.evil.clean\0filter.evil.requ", stderr: "" }],
  ])("status does not run when the filter drivers cannot be read because %s", async (_, listing) => {
    const commands: string[][] = []
    const fake = createGit(async (argv) => {
      commands.push(argv)
      return argv.includes("config") ? listing : { code: 0, stdout: "", stderr: "" }
    })
    expect(await fake.status("/repo", "HEAD")).toBeUndefined()
    expect(commands.some((argv) => argv.includes("status"))).toBe(false)
  })

  test("status refuses, without running it, a filter whose driver name cannot be overridden", async () => {
    const { repo, marker } = await repoWithEditedFile("a.txt filter=a=b\n")
    await sh(repo, "config", "filter.a=b.clean", `touch '${marker}'; cat`)
    expect(await git.status(repo, "HEAD")).toBeUndefined()
    expect(await ran(marker)).toBe(false)
  })

  /** Run `work` with `vars` in the host environment that spawnRunner inherits, then restore it. */
  const withEnv = async <T>(vars: Record<string, string>, work: () => Promise<T>): Promise<T> => {
    const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, env[name]]))
    Object.assign(env, vars)
    try {
      return await work()
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete env[name]
        else env[name] = value
      }
    }
  }

  test.each(reads)("%s runs no repository filter when the inherited GIT_CONFIG names an empty file", async (name, read) => {
    const { repo, marker } = await repoWithEditedFile("a.txt filter=evil\n")
    await sh(repo, "config", "filter.evil.clean", `touch '${marker}'; cat`)
    const empty = join(repo, "..", `${repo.split("/").at(-1)}.empty-config`)
    await writeFile(empty, "")
    expect(await withEnv({ GIT_CONFIG: empty }, () => read(repo) as Promise<unknown>)).toEqual(sawTheChange[name] as never)
    expect(await ran(marker)).toBe(false)
  })

  // A clean checkout must read as clean whatever repository, work tree or index an inherited variable names.
  test.each([
    ["GIT_DIR", async (other: string) => join(other, ".git")],
    ["GIT_WORK_TREE", async (other: string) => other],
    ["GIT_INDEX_FILE", async (other: string) => join(other, "missing-index")],
    ["GIT_COMMON_DIR", async (other: string) => join(other, ".git")],
  ])("porcelain reads the checkout's own repository when %s is inherited", async (name, value) => {
    const { repo } = await repoWithEditedFile()
    await sh(repo, "checkout", "--quiet", "--", "a.txt")
    const other = await mkdtemp(join(root, "other-"))
    await sh(other, "init", "--quiet")
    await writeFile(join(other, "b.txt"), "b\n")
    await sh(other, "add", "b.txt")
    await sh(other, "commit", "--quiet", "-m", "other")
    expect(await withEnv({ [name]: await value(other) }, () => git.porcelain(repo))).toBe("")
  })

  test("trackedDirty sees a change when GIT_LITERAL_PATHSPECS is inherited", async () => {
    const { repo } = await repoWithEditedFile()
    expect(await withEnv({ GIT_LITERAL_PATHSPECS: "1" }, () => git.trackedDirty(repo))).toBe(true)
  })

  test("porcelain writes no trace file when GIT_TRACE is inherited", async () => {
    const { repo, marker } = await repoWithEditedFile()
    await withEnv({ GIT_TRACE: marker }, () => git.porcelain(repo))
    expect(await ran(marker)).toBe(false)
  })

  test("deleteBranchAt does not run the repository's hooks", async () => {
    const { repo, marker } = await repoWithEditedFile()
    await sh(repo, "branch", "doomed")
    const oid = await git.commit(repo, "doomed")
    writeExecutable(join(repo, ".git", "hooks", "reference-transaction"), `#!/bin/sh\ntouch '${marker}'\n`)
    expect(await git.deleteBranchAt(repo, "doomed", oid ?? "")).toBe(true)
    expect(await ran(marker)).toBe(false)
  })
})

describe("programs a repository's own config or hooks name do not run during automatic git calls", () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-programs-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  const raw = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return out.trim()
  }
  const fired = (marker: string) => Bun.file(marker).exists()
  /** A repository with one commit, and a script that writes `marker` when something runs it. */
  const repoWith = async (name: string) => {
    const repo = join(root, name)
    const marker = join(root, `${name}.fired`)
    const script = join(root, `${name}.sh`)
    await raw(root, "init", "--quiet", "--initial-branch=main", repo)
    await writeFile(join(repo, "a.txt"), "one")
    await raw(repo, "add", "a.txt")
    await raw(repo, "commit", "--quiet", "-m", "init")
    writeExecutable(script, `#!/bin/sh\ntouch ${marker}\nexit 1\n`)
    return { repo, marker, script }
  }
  /** A second repository to serve as a local remote. */
  const remoteRepo = async () => {
    const dir = await mkdtemp(join(root, "remote-"))
    await raw(dir, "init", "--quiet", "--initial-branch=main")
    return dir
  }
  /** Runs `argv` once without the hardening (the control, which must reach the program) and once through `spawnRunner`. */
  const bothWays = async (argv: string[], marker: string) => {
    const control = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    await control.exited
    const unhardened = await fired(marker)
    await rm(marker, { force: true })
    await spawnRunner(argv)
    return { unhardened, hardened: await fired(marker) }
  }

  describe("with SSH signing switched on in the repository", () => {
    /** A repository where signing a commit asks `gpg.ssh.defaultKeyCommand` for a key, and that command writes `marker`. */
    const signingRepo = async (name: string) => {
      const { repo, marker, script } = await repoWith(name)
      await raw(repo, "switch", "--quiet", "-c", "side")
      await writeFile(join(repo, "side.txt"), "side")
      await raw(repo, "add", "side.txt")
      await raw(repo, "commit", "--quiet", "-m", "side")
      await raw(repo, "switch", "--quiet", "main")
      await writeFile(join(repo, "main.txt"), "main")
      await raw(repo, "add", "main.txt")
      await raw(repo, "commit", "--quiet", "-m", "main")
      await raw(repo, "config", "gpg.format", "ssh")
      await raw(repo, "config", "commit.gpgsign", "true")
      await raw(repo, "config", "gpg.ssh.defaultKeyCommand", script)
      return { repo, marker, before: await raw(repo, "rev-parse", "HEAD") }
    }
    const git = (repo: string, ...args: string[]) => ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]

    test.each([
      ["commit", (repo: string) => git(repo, "commit", "--allow-empty", "-m", "x")],
      ["merge", (repo: string) => git(repo, "merge", "--no-ff", "--no-edit", "side")],
    ])("a %s runs no gpg.ssh.defaultKeyCommand through spawnRunner", async (name, argv) => {
      const { repo, marker, before } = await signingRepo(`ssh-${name}`)
      const hardened = await spawnRunner(argv(repo))
      const hardenedRan = await fired(marker)
      // The hardened run must have done the work: a refused or failed commit would also leave the marker absent.
      const moved = (await raw(repo, "rev-parse", "HEAD")) !== before
      await raw(repo, "reset", "--hard", before)
      await rm(marker, { force: true })
      // The control: the same call through plain git signs, so it asks the command for a key.
      const control = Bun.spawn(argv(repo), { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      await control.exited
      expect({ code: hardened.code, moved, hardened: hardenedRan, unhardened: await fired(marker) }).toEqual({ code: 0, moved: true, hardened: false, unhardened: true })
    })
  })

  // Restored from #79: the repository can allow a transport (`protocol.<name>.allow=always`) and name the program it
  // runs. An empty GIT_ALLOW_PROTOCOL refuses every transport, whatever the repository says.
  test.each([
    [
      "the upload-pack of a local remote",
      "file",
      async (marker: string) => ({ url: await remoteRepo(), config: [["remote.origin.uploadpack", `touch '${marker}'; git-upload-pack`]] as const }),
    ],
    ["an ext:: remote helper", "ext", async (marker: string) => ({ url: `ext::sh -c touch% ${marker}`, config: [] as const })],
  ])("git never reaches %s, whatever the repository allows", async (name, protocol, remote) => {
    const { repo, marker } = await repoWith(`transport-${protocol}`)
    const { url, config } = await remote(marker)
    await raw(repo, "config", `protocol.${protocol}.allow`, "always")
    await raw(repo, "remote", "add", "origin", url)
    for (const [key, value] of config) await raw(repo, "config", key, value)
    const argv = ["git", "-C", repo, "ls-remote", "origin"]
    const hardened = await spawnRunner(argv)
    const hardenedRan = await fired(marker)
    await rm(marker, { force: true })
    // The control: the same call through plain git reaches the program the repository named.
    await Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited
    expect({ name, refused: hardened.code !== 0, hardened: hardenedRan, unhardened: await fired(marker) }).toEqual({ name, refused: true, hardened: false, unhardened: true })
  })

  test("core.fsmonitor in the repository's config is not run by git status", async () => {
    const { repo, marker, script } = await repoWith("fsmonitor")
    await raw(repo, "config", "core.fsmonitor", script)
    expect(await bothWays(["git", "-C", repo, "status", "--porcelain"], marker)).toEqual({ unhardened: true, hardened: false })
  })

  test("a hook in the repository's .git/hooks is not run by a switch", async () => {
    const { repo, marker, script } = await repoWith("hook")
    writeExecutable(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\nexec ${script}\n`)
    const result = await bothWays(["git", "-C", repo, "switch", "--quiet", "main"], marker)
    expect(result).toEqual({ unhardened: true, hardened: false })
  })

  test("core.hooksPath in the repository's config is not honoured", async () => {
    const { repo, marker, script } = await repoWith("hookspath")
    const hooks = join(root, "hookspath-hooks")
    await mkdir(hooks)
    writeExecutable(join(hooks, "post-checkout"), `#!/bin/sh\nexec ${script}\n`)
    await raw(repo, "config", "core.hooksPath", hooks)
    expect(await bothWays(["git", "-C", repo, "switch", "--quiet", "main"], marker)).toEqual({ unhardened: true, hardened: false })
  })

  // Two layers stop it (log.showSignature=false and the blanked program), so each is removed together with the other to show the test notices.
  test.each(["gpg.program", "gpg.ssh.program", "gpg.x509.program"])("%s is not run to verify a signed commit that git log shows", async (key) => {
    const { repo, marker, script } = await repoWith(`signature-${key}`)
    // A commit that carries a signature header, so `log.showSignature` verifies it with the program for its format.
    const format = key === "gpg.ssh.program" ? "SSH SIGNATURE" : key === "gpg.x509.program" ? "SIGNED MESSAGE" : "PGP SIGNATURE"
    const tree = await raw(repo, "rev-parse", "HEAD^{tree}")
    const parent = await raw(repo, "rev-parse", "HEAD")
    const body = `tree ${tree}\nparent ${parent}\nauthor t <t@example.com> 1 +0000\ncommitter t <t@example.com> 1 +0000\ngpgsig -----BEGIN ${format}-----\n \n AAAA\n -----END ${format}-----\n\nsigned\n`
    await writeFile(join(root, `${key}.commit`), body)
    const signed = await raw(repo, "hash-object", "-t", "commit", "-w", join(root, `${key}.commit`))
    await raw(repo, "update-ref", "HEAD", signed)
    await raw(repo, "config", "log.showSignature", "true")
    await raw(repo, "config", key, script)
    if (key === "gpg.x509.program") await raw(repo, "config", "gpg.format", "x509")
    if (key === "gpg.ssh.program") {
      await raw(repo, "config", "gpg.format", "ssh")
      // With a signers file git asks the program for the signer first, which is the call that must not happen.
      await writeFile(join(root, "signers"), "")
      await raw(repo, "config", "gpg.ssh.allowedSignersFile", join(root, "signers"))
    }
    expect(await bothWays(["git", "-C", repo, "log", "-1"], marker)).toEqual({ unhardened: true, hardened: false })
  })
})

describe("spawnRunner refuses to run hardened-git programs under a git it cannot trust", () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-version-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  /**
   * The version check is cached for the life of the process, so each case runs `spawnRunner` in its own `bun`
   * process, with a directory of fake `git`, `wt` and `gh` first on PATH. Each fake answers `--version` with
   * `versionOutput` and, for any other call, writes `marker` and exits 0.
   */
  const run = async (name: string, versionOutput: string, program: string) => {
    const bin = join(root, `${name}-bin`)
    const marker = join(root, `${name}.ran`)
    await mkdir(bin)
    for (const tool of ["git", "wt", "gh"]) {
      writeExecutable(
        join(bin, tool),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s' '${versionOutput}'; exit 0; fi\ntouch ${marker}\nexit 0\n`,
      )
    }
    const script = join(root, `${name}.ts`)
    await writeFile(
      script,
      `import { spawnRunner } from ${JSON.stringify(join(import.meta.dir, "git.ts"))}\n` +
        `console.log(JSON.stringify(await spawnRunner([${JSON.stringify(program)}, "status"])))\n`,
    )
    const child = Bun.spawn([process.execPath, script], {
      env: { ...Bun.env, PATH: `${bin}:${Bun.env.PATH ?? ""}` },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return { result: JSON.parse(out) as { code: number; stderr: string }, ran: await Bun.file(marker).exists() }
  }

  test.each(["git", "wt", "gh"])("%s: git 2.44 is refused with exit 126 and the command never runs", async (program) => {
    const { result, ran } = await run(`old-${program}`, "git version 2.44.0", program)
    expect({ code: result.code, stderr: result.stderr, ran }).toEqual({ code: 126, stderr: "subagent-worktree needs git 2.45+ for safe automatic merges", ran: false })
  })

  test.each(["git", "wt", "gh"])("%s: unreadable version output is refused with exit 126 and the command never runs", async (program) => {
    const { result, ran } = await run(`garbled-${program}`, "zsh: command not found: git", program)
    expect({ code: result.code, stderr: result.stderr, ran }).toEqual({ code: 126, stderr: "subagent-worktree needs git 2.45+ for safe automatic merges", ran: false })
  })

  test("the control: git 2.45 runs the command", async () => {
    const { result, ran } = await run("current", "git version 2.45.0", "git")
    expect({ code: result.code, ran }).toEqual({ code: 0, ran: true })
  })
})
