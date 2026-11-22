import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hardGate } from "./guards.ts"
import { hostOf, pushVia, type RemoteResolver, readPushVia } from "./push-via.ts"
import { walkShell } from "./shell.ts"

// Real-git tests spawn `git init`, `git remote` and `git config`; each case takes well under 1 s locally.
setDefaultTimeout(30_000)

const CONFIG = { host: "github.com", command: "dgit" }
const GITHUB = "https://github.com/acme/repo.git"

/** Resolver double: every remote, named or default, points at `url`. */
const at =
  (url: string | undefined): RemoteResolver =>
  () =>
    url

const run = (source: string, resolve: RemoteResolver = at(GITHUB), cwd = "/work/repo") =>
  pushVia(walkShell(source).commands, cwd, CONFIG, resolve)

describe("hostOf", () => {
  test.each([
    ["https://github.com/a/b.git", "github.com"],
    ["https://user:tok@GitHub.com:443/a/b", "github.com"],
    ["ssh://git@github.com/a/b.git", "github.com"],
    ["git@github.com:a/b.git", "github.com"],
    ["github.com:a/b.git", "github.com"],
    ["/srv/git/b.git", undefined],
    ["../b.git", undefined],
    ["file:///srv/b.git", undefined],
    ["origin", undefined],
  ])("%s", (url, host) => {
    expect(hostOf(url)).toBe(host)
  })
})

describe("pushVia refuses a plain git push to the host", () => {
  test.each([
    ["bare push", "git push"],
    ["named remote", "git push origin main"],
    ["options before the remote", "git push -u --force-with-lease origin HEAD"],
    ["-C directory", "git -C /elsewhere push"],
    ["env assignment prefix", "GIT_TERMINAL_PROMPT=0 git push origin"],
    ["env wrapper", "env FOO=1 git push"],
    ["chained after &&", "git add -A && git commit -m x && git push"],
    ["chained after ;", "cd /x; git push origin main"],
    ["pipeline stage", "git push 2>&1 | tail -3"],
    ["nested shell script", "bash -c 'git push origin'"],
    ["command substitution", "echo $(git push)"],
    ["path to git", "/usr/bin/git push"],
  ])("%s", (_name, source) => {
    expect(run(source)).toContain("dgit -C")
  })

  test("the hint names the directory the push would run in", () => {
    expect(run("git -C /elsewhere push")).toContain("dgit -C /elsewhere push")
    expect(run("git push")).toContain("dgit -C /work/repo push")
  })

  test("a relative -C resolves against the call's directory", () => {
    expect(run("git -C sub push")).toContain("dgit -C /work/repo/sub push")
  })

  test("a remote given as a URL is judged without asking git", () => {
    const never: RemoteResolver = () => {
      throw new Error("must not resolve")
    }
    expect(run("git push git@github.com:a/b.git main", never)).toContain("dgit -C")
    expect(run("git push --repo=https://github.com/a/b.git", never)).toContain("dgit -C")
    expect(run("git push --repo https://github.com/a/b.git", never)).toContain("dgit -C")
  })
})

describe("pushVia allows", () => {
  test.each([
    ["the configured command", "dgit -C /work/repo push"],
    ["the configured command by path", "/opt/bin/dgit push origin"],
    ["another git subcommand", "git pull"],
    ["a git command that only mentions push", "git commit -m 'git push later'"],
    ["echo of a push", "echo git push"],
  ])("%s", (_name, source) => {
    expect(run(source)).toBeUndefined()
  })

  test("a remote on another host", () => {
    expect(run("git push origin", at("https://gitlab.example.com/a/b.git"))).toBeUndefined()
  })

  test("a local-path remote", () => {
    expect(run("git push ../mirror.git")).toBeUndefined()
  })

  test("a remote whose host cannot be resolved (fails open)", () => {
    expect(run("git push origin", at(undefined))).toBeUndefined()
  })

  test("a resolver that throws (fails open)", () => {
    const boom: RemoteResolver = () => {
      throw new Error("git missing")
    }
    expect(run("git push", boom)).toBeUndefined()
  })

  test("--git-dir, whose repository this reader cannot place", () => {
    expect(run("git --git-dir=/x/.git push")).toBeUndefined()
  })
})

describe("pushVia asks the resolver for the pushed remote", () => {
  test("passes the named remote, or undefined for the default; a push option's value is not a remote", () => {
    const seen: Array<string | undefined> = []
    const spy: RemoteResolver = (_cwd, remote) => {
      seen.push(remote)
      return undefined
    }
    run("git push upstream main", spy)
    run("git push", spy)
    run("git push -o ci.skip", spy)
    expect(seen).toEqual(["upstream", undefined, undefined])
  })
})

describe("readPushVia", () => {
  test("is off when absent", () => {
    expect(readPushVia({})).toBeUndefined()
    expect(readPushVia(undefined)).toBeUndefined()
  })

  test("reads host and command, lower-casing the host", () => {
    expect(readPushVia({ pushVia: { host: "GitHub.com", command: "dgit" } })).toEqual(CONFIG)
  })

  test.each([
    [{ host: "github.com" }],
    [{ command: "dgit" }],
    [{ host: "", command: "dgit" }],
    [{ host: "github.com", command: "dgit push; rm" }],
    [{ host: "git hub", command: "dgit" }],
    ["github.com"],
  ])("ignores a malformed value %j", (value) => {
    expect(readPushVia({ pushVia: value })).toBeUndefined()
  })
})

describe("hardGate integration", () => {
  const options = { pushVia: CONFIG, resolveRemote: at(GITHUB) }

  test("refuses with the push-via guard", () => {
    const refusal = hardGate("git push", "/work/repo", options)
    expect(refusal?.guard).toBe("push-via")
    expect(refusal?.reason).toContain("dgit -C /work/repo push")
  })

  test("is off without the option", () => {
    expect(hardGate("git push", "/work/repo", { resolveRemote: at(GITHUB) })).toBeUndefined()
  })

  test("can be disabled by id", () => {
    expect(hardGate("git push", "/work/repo", { ...options, disabled: new Set(["push-via"]) })).toBeUndefined()
  })
})

describe("default resolver with real git", () => {
  const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })

  const withRepo = (url: string, setup: (dir: string) => void, check: (dir: string) => void) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "push-via-")))
    try {
      git(dir, "init", "-q", "-b", "main")
      git(dir, "remote", "add", "origin", url)
      setup(dir)
      check(dir)
    } finally {
      rmSync(dir, { recursive: true })
    }
  }
  const guardOf = (dir: string, source: string) =>
    hardGate(source, dir, { pushVia: CONFIG, env: { PATH: Bun.env.PATH, HOME: Bun.env.HOME } })?.guard

  test("reads origin's URL for a bare push", () => {
    withRepo(
      "git@github.com:a/b.git",
      () => {},
      (dir) => expect(guardOf(dir, "git push")).toBe("push-via"),
    )
  })

  test("a pushurl on another host wins over the fetch URL", () => {
    withRepo(
      GITHUB,
      (dir) => git(dir, "config", "remote.origin.pushurl", "https://gitlab.example.com/a/b.git"),
      (dir) => expect(guardOf(dir, "git push origin")).toBeUndefined(),
    )
  })

  test("branch.<name>.pushRemote picks the remote for a bare push", () => {
    withRepo(
      GITHUB,
      (dir) => {
        git(dir, "remote", "add", "mirror", "https://gitlab.example.com/a/b.git")
        git(dir, "config", "branch.main.pushRemote", "mirror")
      },
      (dir) => expect(guardOf(dir, "git push")).toBeUndefined(),
    )
  })

  test("a directory that is not a repository fails open", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "push-via-")))
    try {
      expect(guardOf(dir, "git push")).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
