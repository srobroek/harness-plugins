import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import type { Exec } from "./exec.ts"
import { spawnTool } from "./exec.ts"
import { cleanup, exited, fakeExec, temp, withTools } from "./fixtures.ts"
import { gitListing, gitState } from "./git.ts"
import { MAX_ARGV_BYTES, runScan } from "./run.ts"

// Real git processes: each call takes about 10 ms alone; 30 s leaves headroom for a loaded machine (AGENTS.md, Commands).
setDefaultTimeout(30_000)
afterAll(cleanup)

const GIT = Bun.which("git") ?? "git"
const which = (b: string) => (b === "git" ? GIT : null)
function git(root: string, ...args: string[]): void {
  const run = Bun.spawnSync([GIT, "-c", "user.email=a@b", "-c", "user.name=n", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
}
function repo(files: Record<string, string> = {}): string {
  const root = realpathSync(temp())
  git(root, "init", "-q")
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  return root
}

describe("no repository code runs without allowCode", () => {
  test("a configured fsmonitor command is not run by the scan's git calls", async () => {
    const root = repo({ "a.py": "x = 1\n" })
    git(root, "add", "a.py")
    git(root, "commit", "-qm", "x")
    const marker = join(temp(), "fsmonitor-ran")
    const hook = join(temp(), "hook")
    writeExecutable(hook, `touch '${marker}'\nprintf '\\0'\n`)
    git(root, "config", "core.fsmonitor", hook)

    // Control: without the scan's flags, git runs the hook on ls-files, so the test can fail.
    Bun.spawnSync([GIT, "ls-files", "-z", "--others"], { cwd: root })
    expect(await Bun.file(marker).exists()).toBe(true)
    Bun.spawnSync(["rm", marker])

    await runScan({ root, languages: ["python"], files: ["a.py"] }, { which })
    expect(await Bun.file(marker).exists()).toBe(false)
  })
})

describe("git state", () => {
  test("a plain directory is none; a repository is repo", async () => {
    expect(await gitState(realpathSync(temp()), spawnTool, which)).toEqual({ kind: "none" })
    const root = repo()
    expect(await gitState(root, spawnTool, which)).toEqual({ kind: "repo", dir: join(root, ".git") })
  })

  test("a git failure that is not 'not a repository' is an error, not none", async () => {
    const exec: Exec = async () => exited("", 1, "fatal: detected dubious ownership")
    expect(await gitState(temp(), exec, which)).toEqual({ kind: "error", reason: "git rev-parse exited 1" })
    const timeout: Exec = async () => ({ kind: "timeout", stdout: "", stderr: "" })
    expect((await gitState(temp(), timeout, which)).kind).toBe("error")
  })

  test("a missing git binary is an error inside a .git directory and none outside one", async () => {
    const root = repo()
    expect((await gitState(root, spawnTool, () => null)).kind).toBe("error")
    expect(await gitState(realpathSync(temp()), spawnTool, () => null)).toEqual({ kind: "none" })
  })
})

describe("git listing", () => {
  test("lists tracked and untracked files, minus ignored files and tracked files an ignore rule now matches", async () => {
    const root = repo({ "keep.ts": "", "tracked-ignored.ts": "", "new.ts": "", "skip.ts": "" })
    git(root, "add", "keep.ts", "tracked-ignored.ts")
    git(root, "commit", "-qm", "x")
    writeFileSync(join(root, ".gitignore"), "skip.ts\ntracked-ignored.ts\n")
    const state = await gitState(root, spawnTool, which)
    const listing = await gitListing(root, state, spawnTool, which)
    expect(listing.kind === "files" && [...listing.files].sort()).toEqual([".gitignore", "keep.ts", "new.ts"])
  })

  test("a symlink and a path through a symlink that leaves the root are dropped", async () => {
    const outside = realpathSync(temp())
    writeFileSync(join(outside, "secret.ts"), "")
    const root = repo({ "ok.ts": "" })
    symlinkSync(join(outside, "secret.ts"), join(root, "link.ts"))
    symlinkSync(outside, join(root, "dir"))
    git(root, "add", "-A")
    const listing = await gitListing(root, await gitState(root, spawnTool, which), spawnTool, which)
    expect(listing.kind === "files" && listing.files).toEqual(["ok.ts"])
  })

  test.each([
    ["exits non-zero", exited("", 1, "boom")],
    ["times out", { kind: "timeout", stdout: "", stderr: "" } as const],
    ["overflows", { kind: "overflow", stream: "stdout", stdout: "", stderr: "" } as const],
  ])("a listing that %s is an error, never an empty list", async (_name, answer) => {
    const exec: Exec = async () => answer
    const listing = await gitListing(temp(), { kind: "repo", dir: "/x/.git" }, exec, which)
    expect(listing.kind).toBe("error")
  })

  test("the abort signal reaches every git call", async () => {
    const controller = new AbortController()
    const seen: Array<AbortSignal | undefined> = []
    const exec: Exec = async (_argv, options) => {
      seen.push(options.signal)
      return exited("")
    }
    await gitListing(temp(), { kind: "repo", dir: "/x/.git" }, exec, which, controller.signal)
    await gitState(temp(), exec, which, controller.signal)
    expect(seen).toEqual([controller.signal, controller.signal, controller.signal])
  })
})

describe("ignore enforcement in biome's explicit-file mode", () => {
  const biomeRepo = () => {
    const root = realpathSync(temp())
    writeFileSync(join(root, "biome.json"), "{}")
    writeFileSync(join(root, "a.ts"), "export {}\n")
    return root
  }
  const answers = (root: string) => ({
    "rev-parse": exited(`${join(root, ".git")}\n`),
  })

  test("a failed listing is a gap and biome does not run", async () => {
    const root = biomeRepo()
    const calls: Parameters<typeof fakeExec>[1] = []
    const exec = fakeExec({ ...answers(root), "ls-files": exited("", 128, "fatal") }, calls)
    const report = await runScan({ root, languages: ["ts"] }, { exec, which: withTools("biome", "git") })
    expect(report.coverage.find((c) => c.recipe === "biome:lenses")).toMatchObject({
      status: "gap",
      reason: "the repository's ignore files could not be applied: git ls-files exited 128",
    })
    expect(calls.some((c) => c.argv.includes("/bin/biome"))).toBe(false)
  })

  test("a directory that is not a repository is walked and biome runs", async () => {
    const root = biomeRepo()
    const calls: Parameters<typeof fakeExec>[1] = []
    const report = await runScan({ root, languages: ["ts"] }, { exec: fakeExec({ "/bin/biome": exited('{"diagnostics":[]}') }, calls), which: withTools("biome", "git") })
    expect(report.coverage.find((c) => c.recipe === "biome:lenses")?.status).toBe("ran")
    expect(calls.find((c) => c.argv.includes("/bin/biome"))?.argv.at(-1)).toBe(join(root, "a.ts"))
  })

  test("named files whose listing failed are a gap for file recipes", async () => {
    const root = biomeRepo()
    writeFileSync(join(root, "a.py"), "")
    const exec = fakeExec({ ...answers(root), "ls-files": exited("", 1) })
    const report = await runScan({ root, files: ["a.py"] }, { exec, which: withTools("ruff", "git") })
    expect(report.coverage.find((c) => c.recipe === "ruff:lenses")).toMatchObject({ status: "gap" })
    expect(report.coverage.find((c) => c.recipe === "ruff:lenses")?.reason).toMatch(/^the repository's ignore files could not be applied/)
  })
})

describe("command-line length in isolated mode", () => {
  // Each name costs root.length + name.length + 2 bytes against MAX_ARGV_BYTES.
  function filesFor(count: number, root: string): string[] {
    return Array.from({ length: count }, (_, i) => `${String(i).padStart(6, "0")}${"x".repeat(180)}.ts`).map((f) => {
      writeFileSync(join(root, f), "")
      return f
    })
  }
  const perFile = (root: string) => root.length + 6 + 180 + 3 + 2

  async function scanWith(count: number) {
    const root = realpathSync(temp())
    writeFileSync(join(root, "biome.json"), "{}")
    const names = filesFor(count, root)
    const calls: Parameters<typeof fakeExec>[1] = []
    const exec = fakeExec({ "rev-parse": exited(`${join(root, ".git")}\n`), "--others": exited(`${names.join("\0")}\0`), "/bin/biome": exited('{"diagnostics":[]}') }, calls)
    const report = await runScan({ root, languages: ["ts"] }, { exec, which: withTools("biome", "git") })
    return { report, ranBiome: calls.some((c) => c.argv.includes("/bin/biome")), perFile: perFile(root) }
  }

  test("just under the threshold runs biome; one file more is a gap that names the count", async () => {
    const probe = await scanWith(1)
    const fits = Math.floor(MAX_ARGV_BYTES / probe.perFile)
    const under = await scanWith(fits)
    expect(under.report.coverage.find((c) => c.recipe === "biome:lenses")?.status).toBe("ran")
    expect(under.ranBiome).toBe(true)
    const over = await scanWith(fits + 1)
    expect(over.report.coverage.find((c) => c.recipe === "biome:lenses")).toMatchObject({
      status: "gap",
      reason: `too many files to name on one command line in isolated mode (${fits + 1}); pass a narrower file list`,
    })
    expect(over.ranBiome).toBe(false)
  })
})
