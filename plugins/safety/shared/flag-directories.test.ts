import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { callFlagDirectoryReport, externalFlagDirectories, flagCheckRoots, shellFlagDirectories } from "./flag-directories.ts"

// The worktree fixture runs git eight times: the file took 1.4 s alone, so 30 s leaves headroom on a loaded machine.
setDefaultTimeout(30_000)

const CWD = "/work/repo"

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: ENV })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
}

describe("shellFlagDirectories", () => {
  test.each([
    ["git -C /other status", ["/other"]],
    ["git -C ../sib log", ["/work/sib"]],
    ["git -C /a -C b status", ["/a", "/a/b"]],
    ["git --git-dir=/x/.git --work-tree /x status", ["/x/.git", "/x"]],
    ["GIT_DIR=/y/.git git log", ["/y/.git"]],
    ["git -C /z push", ["/z"]],
    ["git -c core.x=1 -C /q status", ["/q"]],
    ["sudo git -C /root/r status", ["/root/r"]],
    ["make -C /m all", ["/m"]],
    ["make -C/m -C sub", ["/m", "/m/sub"]],
    ["make --directory=/m", ["/m"]],
    ["npm --prefix /n install", ["/n"]],
    ["npm install --prefix=/n", ["/n"]],
    ["pnpm -C /p build", ["/p"]],
    ["pnpm --dir /p build", ["/p"]],
    ["yarn --cwd /y test", ["/y"]],
    ["bun --cwd /b test", ["/b"]],
    ["cargo build --manifest-path /c/Cargo.toml", ["/c"]],
    ["cargo test --manifest-path=crates/x/Cargo.toml", ["/work/repo/crates/x"]],
    ["go -C /g build ./...", ["/g"]],
    ["go build -C=/g", ["/g"]],
    ["uv --directory /u run x", ["/u"]],
    ["cd x && echo; bash -c 'git -C /deep status'", ["/deep"]],
    ["git -C ~/r status", [join(homedir(), "r")]],
  ])("%s", (command, dirs) => {
    expect(shellFlagDirectories(command, CWD)).toEqual(dirs)
  })

  test("custom git wrappers are opt-in", () => {
    expect(shellFlagDirectories("dgit -C /x status", "/work")).toEqual([])
    expect(shellFlagDirectories("dgit -C /x status", "/work", ["git", "dgit"])).toEqual(["/x"])
  })

  test.each([
    "git status",
    "git log -C",
    "git -C $DIR status",
    'git -C "$(pwd)/x" status',
    "echo git -C /other status",
    "npm run x -- --prefix /n",
    "make all",
    "constructor -C /x",
    "grep 'git -C /x' file",
  ])("none: %s", (command) => {
    expect(shellFlagDirectories(command, CWD)).toEqual([])
  })
})

describe("callFlagDirectoryReport", () => {
  test.each([
    ["bun install --cwd infra", ["/work/repo/infra"]],
    ["cd /wt && bun install --cwd infra", ["/wt/infra"]],
    ["cd sub && git -C x status", ["/work/repo/sub/x"]],
    ["cd /wt", []],
    // The rest runs in /wt when the cd succeeds and in the session directory when it fails.
    ["cd /wt; bun install --cwd infra", ["/wt/infra", "/work/repo/infra"]],
    ["cd /wt ;timeout 300 bun install --cwd infra 2>&1 | tail -2; cd infra && bun run test", ["/wt/infra", "/work/repo/infra"]],
    ["cd /wt\ngit -C sub status", ["/wt/sub", "/work/repo/sub"]],
    ["cd /wt; git -C /abs status", ["/abs"]],
  ])("%s", (command, dirs) => {
    expect(callFlagDirectoryReport(command, CWD)).toEqual({ dirs, unresolved: [] })
  })

  test.each([
    'cd "$X"; bun install --cwd x',
    'cd "$X" && bun install --cwd x',
    "cd $X; bun install --cwd x",
    "cd ~/wt; bun install --cwd x",
    "cd ../wt; bun install --cwd x",
    "cd -; bun install --cwd x",
    "cd /wt 2>/dev/null; bun install --cwd x",
    "cd /wt || exit; bun install --cwd x",
    "cd /wt & bun install --cwd x",
    "pushd /wt; bun install --cwd x",
    'cd "/wt;x"; bun install --cwd x',
    "cd /wt x; bun install --cwd x",
  ])("unresolved: %s", (command) => {
    expect(callFlagDirectoryReport(command, CWD)).toEqual({ dirs: [], unresolved: ["x"] })
  })
})

describe("flagCheckRoots and externalFlagDirectories", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flag-roots-")))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const main = join(root, "repo")
  const linked = join(root, "worktrees", "linked")
  const relative = join(root, "worktrees", "relative")
  const replaced = join(root, "worktrees", "replaced")
  const outside = join(root, "outside")
  mkdirSync(main)
  mkdirSync(outside)
  git(main, "init", "-q", "-b", "main")
  git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base")
  git(main, "worktree", "add", "-q", "-b", "linked", linked)
  git(main, "worktree", "add", "-q", "--relative-paths", "-b", "relative", relative)
  // Deleted without `git worktree prune`: its admin entry stays, and another repository now sits at its path.
  git(main, "worktree", "add", "-q", "-b", "replaced", replaced)
  rmSync(replaced, { recursive: true })
  mkdirSync(replaced)
  git(replaced, "init", "-q")

  test("hold the main checkout and each linked worktree that names the repository back, from any of them", () => {
    expect(flagCheckRoots(main).sort()).toEqual([main, linked, relative].sort())
    expect(flagCheckRoots(linked).sort()).toEqual([linked, main, relative].sort())
    mkdirSync(join(relative, "sub"))
    expect(flagCheckRoots(join(relative, "sub")).sort()).toEqual([join(relative, "sub"), relative, main, linked].sort())
    expect(flagCheckRoots(outside)).toEqual([outside])
  })

  test("compare by real path: another spelling of a root matches, a symlink out of one does not", () => {
    const alias = join(root, "alias")
    symlinkSync(root, alias)
    symlinkSync(outside, join(main, "out"))
    symlinkSync(join(main, "loop"), join(main, "loop"))
    expect(externalFlagDirectories([join(alias, "worktrees", "linked", "infra"), join(relative, "not", "yet")], main)).toEqual([])
    expect(externalFlagDirectories([join(main, "out", "x"), join(main, "loop"), join(replaced, "x"), join(outside, "y")], main)).toEqual([
      { resource: `${main}/out/x/*`, save: `${main}/*` },
      { resource: `${main}/loop/*`, save: `${main}/*` },
      { resource: `${replaced}/x/*`, save: `${replaced}/*` },
      { resource: `${outside}/y/*`, save: `${outside}/y/*` },
    ])
  })
})
