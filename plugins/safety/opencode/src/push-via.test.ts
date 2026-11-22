import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hardGate, MESSAGES } from "./guards.ts"
import { hostOf, pushVia, type RemoteResolver, readPushVia } from "./push-via.ts"
import { walkShell } from "./shell.ts"

// Real-git tests spawn `git init`, `git remote` and `git config`; each case takes well under 1 s locally.
setDefaultTimeout(30_000)

const CONFIG = { host: "github.com", command: "dgit" }
const GITHUB = "https://github.com/acme/repo.git"
const GITLAB = "https://gitlab.example.com/acme/repo.git"

/** Resolver double: every remote, named or default, points at `urls`. */
const at =
  (...urls: string[]): RemoteResolver =>
  () =>
    urls.length === 0 ? undefined : urls

/** Resolver double for URL-like remotes: git hands a URL or path back unchanged. */
const echoing: RemoteResolver = (_cwd, remote) => [remote ?? GITHUB]

/** The directory a refused push would be redirected to, or `undefined` when the push passes. */
const run = (source: string, resolve: RemoteResolver = at(GITHUB), cwd = "/work/repo") =>
  pushVia(walkShell(source).commands, cwd, CONFIG, resolve)?.dir

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
    ["chained after ;", "echo hi; git push origin main"],
    ["pipeline stage", "git push 2>&1 | tail -3"],
    ["nested shell script", "bash -c 'git push origin'"],
    ["command substitution", "echo $(git push)"],
    ["path to git", "/usr/bin/git push"],
    ["an unrelated -c override", "git -c user.name=a -c core.pager=cat push"],
  ])("%s", (_name, source) => {
    expect(run(source)).toBeDefined()
  })

  test.each([
    ["git -C /elsewhere push", "/elsewhere"],
    ["git push", "/work/repo"],
    ["git -C sub push", "/work/repo/sub"],
    ["git -C /a -C b push", "/a/b"],
    ["env -C /via git push", "/via"],
    ["cd sub && git push", "/work/repo"],
  ])("%s runs in %s", (source, dir) => {
    expect(run(source)).toBe(dir)
  })

  test("a URL remote is judged by what git makes of it", () => {
    expect(run("git push git@github.com:a/b.git main", echoing)).toBeDefined()
    expect(run("git push https://github.com/a/b.git", echoing)).toBeDefined()
  })

  test("any one of several push URLs on the host refuses", () => {
    expect(run("git push", at(GITLAB, GITHUB))).toBeDefined()
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
    expect(run("git push origin", at(GITLAB))).toBeUndefined()
  })

  test("a local-path remote", () => {
    expect(run("git push ../mirror.git", echoing)).toBeUndefined()
  })

  test("several push URLs, none on the host", () => {
    expect(run("git push", at(GITLAB, "https://h2.example.com/b"))).toBeUndefined()
  })

  test("a remote whose host cannot be resolved (fails open)", () => {
    expect(run("git push origin", at())).toBeUndefined()
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

  test.each([
    ["-h", "git push -h"],
    ["--help", "git push --help"],
    ["help after the remote", "git push origin --help"],
  ])("a help-only call (%s)", (_name, source) => {
    expect(run(source)).toBeUndefined()
  })

  test.each([
    ["cd then push", "cd sub; git push"],
    ["cd after the first command", "echo hi; cd sub && git push"],
    ["pushd", "pushd sub && git push"],
    ["popd", "popd; git push"],
    ["a subshell cd", "(cd sub && git push)"],
    ["a nested shell after cd", "cd sub; bash -c 'git push'"],
    ["a wrapper directory around a nested shell", "env -C /elsewhere bash -c 'git push'"],
  ])("a directory that changes before the push (%s) fails open", (_name, source) => {
    expect(run(source)).toBeUndefined()
  })

  test.each([
    ["-c remote url", `git -c remote.origin.url=${GITLAB} push`],
    ["-c remote pushurl", `git -c remote.origin.pushurl=${GITLAB} push origin`],
    ["-c url insteadOf", "git -c url.https://gitlab.example.com/.insteadOf=https://github.com/ push"],
    ["-c url pushInsteadOf", "git -c url.x.pushInsteadOf=y push"],
    ["-c remote.pushDefault", "git -c remote.pushDefault=mirror push"],
    ["-c uppercase key", "git -c Remote.Origin.URL=x push"],
    ["--config-env remote url", "git --config-env=remote.origin.url=MIRROR push"],
    ["--config-env split", "git --config-env remote.origin.url=MIRROR push"],
    ["GIT_CONFIG_COUNT", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=x git push"],
    ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_PARAMETERS=x git push"],
  ])("a config override that can move the destination (%s) fails open", (_name, source) => {
    expect(run(source)).toBeUndefined()
  })
})

describe("pushVia asks the resolver for the pushed remote", () => {
  const remoteOf = (source: string): string | undefined => {
    let seen: string | undefined = "<not asked>"
    run(source, (_cwd, remote) => {
      seen = remote
      return undefined
    })
    return seen
  }

  test.each([
    ["git push upstream main", "upstream"],
    ["git push", undefined],
    ["git push -u", undefined],
    ["git push -o ci.skip", undefined],
    ["git push -o ci.skip origin", "origin"],
    ["git push -ofoo origin", "origin"],
    ["git push --push-option=a origin", "origin"],
    ["git push --push-option a origin", "origin"],
    ["git push --receive-pack=/x origin", "origin"],
    ["git push --exec /x origin", "origin"],
    ["git push -- origin", "origin"],
    ["git push --repo=https://a.example/b", "https://a.example/b"],
    ["git push --repo https://a.example/b", "https://a.example/b"],
    ["git push --rep=https://a.example/b", "https://a.example/b"],
    ["git push -o --repo=https://a.example/b", undefined],
    ["git push --push-option --repo=x origin", "origin"],
    ["git push --repo=https://a.example/b mirror", "mirror"],
  ])("%s asks about %s", (source, remote) => {
    expect(remoteOf(source)).toBe(remote)
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

  test("refuses with the push-via guard, naming host, command and directory", () => {
    const refusal = hardGate("git push", "/work/repo", options)
    expect(refusal?.guard).toBe("push-via")
    expect(refusal?.reason).toBe(MESSAGES["push-via"]("github.com", "dgit", "/work/repo"))
    expect(refusal?.reason).toContain("`dgit -C /work/repo push`")
  })

  test("quotes a directory with a space in the hint", () => {
    expect(MESSAGES["push-via"]("github.com", "dgit", "/work/my repo")).toContain("`dgit -C '/work/my repo' push`")
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

  // An empty HOME, so the developer's own global git config (insteadOf rules) cannot change the outcome.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "push-via-home-")))
  afterAll(() => rmSync(home, { recursive: true }))

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
    hardGate(source, dir, { pushVia: CONFIG, env: { PATH: Bun.env.PATH, HOME: home, XDG_CONFIG_HOME: home } })?.guard

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
      (dir) => git(dir, "config", "remote.origin.pushurl", GITLAB),
      (dir) => expect(guardOf(dir, "git push origin")).toBeUndefined(),
    )
  })

  test("every push URL of a remote is checked", () => {
    withRepo(
      GITLAB,
      (dir) => {
        git(dir, "config", "--add", "remote.origin.pushurl", GITLAB)
        git(dir, "config", "--add", "remote.origin.pushurl", GITHUB)
      },
      (dir) => expect(guardOf(dir, "git push")).toBe("push-via"),
    )
  })

  test("branch.<name>.pushRemote picks the remote for a bare push", () => {
    withRepo(
      GITHUB,
      (dir) => {
        git(dir, "remote", "add", "mirror", GITLAB)
        git(dir, "config", "branch.main.pushRemote", "mirror")
      },
      (dir) => expect(guardOf(dir, "git push")).toBeUndefined(),
    )
  })

  test("a rewrite rule maps an explicit URL onto the host", () => {
    withRepo(
      GITLAB,
      (dir) => git(dir, "config", "url.git@github.com:.insteadOf", "https://mirror.example.com/"),
      (dir) => expect(guardOf(dir, "git push https://mirror.example.com/a/b.git")).toBe("push-via"),
    )
  })

  test("a rewrite rule can move an explicit URL off the host", () => {
    withRepo(
      GITLAB,
      (dir) => git(dir, "config", "url.https://gitlab.example.com/.insteadOf", "https://github.com/"),
      (dir) => expect(guardOf(dir, "git push https://github.com/a/b.git")).toBeUndefined(),
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
