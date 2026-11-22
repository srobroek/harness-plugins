import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { untrustedLocalGitEnv } from "@srobroek/opencode-lib/safe-git"
import { type GuardID, hardGate } from "./guards.ts"
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

describe("pushVia refuses a literal git push to the host", () => {
  test.each([
    ["bare push", "git push"],
    ["named remote", "git push origin main"],
    ["options before the remote", "git push -u --force-with-lease origin HEAD"],
    ["-C directory", "git -C /elsewhere push"],
    ["followed by more commands", "git push && echo pushed"],
    ["followed by a pipeline stage", "git push | tail -3"],
  ])("%s", (_name, source) => {
    expect(run(source)).toBeDefined()
  })

  test.each([
    ["git -C /elsewhere push", "/elsewhere"],
    ["git push", "/work/repo"],
    ["git -C sub push", "/work/repo/sub"],
    ["git -C /a -C b push", "/a/b"],
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

  test("a literal push to another host", () => {
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

  test.each([
    ["-h", "git push -h"],
    ["--help", "git push --help"],
    ["help after the remote", "git push origin --help"],
  ])("a help-only call (%s)", (_name, source) => {
    expect(run(source)).toBeUndefined()
  })
})

// By the user's decision the guard judges only a literal first `git push`; each of these shapes fails open
// even though the resolver would place the remote on the host.
describe("pushVia fails open for anything but a literal first git push", () => {
  test.each([
    ["env wrapper", "env FOO=1 git push"],
    ["env -C", "env -C /via git push"],
    ["env -u", "env -u HOME git push"],
    ["env -i", "env -i PATH=/usr/bin git push"],
    ["exec", "exec git push"],
    ["command", "command git push"],
    ["nohup", "nohup git push"],
    ["sudo", "sudo git push"],
    ["doas", "doas git push"],
    ["inline assignment", "GIT_TERMINAL_PROMPT=0 git push origin"],
    ["HOME assignment", "HOME=/x git push"],
    ["quoted env control", "'HOME'=/x git push"],
    ["quoted command word", "'git' push"],
    ["quoted subcommand", 'git "push"'],
    ["escaped word", "git pu\\sh"],
    ["path to git", "/usr/bin/git push"],
    ["variable in a directory", "git -C $HOME/repo push"],
    ["variable in the remote", "git push $REMOTE"],
    ["tilde directory", "git -C ~/repo push"],
    ["glob remote", "git push or*"],
    ["command substitution", "git push $(echo origin)"],
    ["backtick substitution", "git push `echo origin`"],
    ["a substitution elsewhere", "echo $(git push)"],
    ["-c override", "git -c remote.origin.url=x push"],
    ["--config-env", "git --config-env=remote.origin.url=X push"],
    ["--git-dir", "git --git-dir=/x/.git push"],
    ["--work-tree", "git --work-tree /x push"],
    ["-C with ..", "git -C link/.. push"],
    ["-C without a value", "git -C"],
    ["redirect on the push", "git push 2>&1"],
    ["subshell", "(git push)"],
    ["brace group", "{ git push; }"],
    ["negation", "! git push"],
    ["nested shell", "bash -c 'git push origin'"],
    ["eval", "eval 'git push'"],
    ["a leading cd", "cd sub && git push"],
    ["an earlier command", "echo hi; git push"],
    ["an earlier commit", "git add -A && git commit -m x && git push"],
    ["an export", "export GIT_DIR=/x/.git; git push"],
  ])("%s", (_name, source) => {
    expect(run(source)).toBeUndefined()
  })
})

describe("pushVia reads option abbreviations as git does", () => {
  test.each([
    ["git push --pu ci.skip origin", "origin"],
    ["git push --push ci.skip origin", "origin"],
    ["git push --ex /x origin", "origin"],
    ["git push --rece /x origin", "origin"],
    ["git push --recu=check origin", "origin"],
    ["git push --rep https://a.example/b", "https://a.example/b"],
    ["git push --force-with origin", "origin"],
  ])("%s asks about %s", (source, remote) => {
    let seen: string | undefined = "<not asked>"
    run(source, (_cwd, asked) => {
      seen = asked
      return [GITHUB]
    })
    expect(seen).toBe(remote)
  })

  test("a prefix of a value-taking option still refuses a push to the host", () => {
    expect(run("git push --pu ci.skip origin")).toBeDefined()
  })

  test.each([
    ["an ambiguous prefix", "git push --re origin"],
    ["a prefix git reports as ambiguous (receive-pack, recurse-submodules)", "git push --rec=check origin"],
    ["an ambiguous prefix shared by negations", "git push --no- origin"],
    ["an unknown long option", "git push --frobnicate origin"],
    ["an unknown option with a value", "git push --frobnicate=1 origin"],
  ])("%s fails open", (_name, source) => {
    expect(run(source)).toBeUndefined()
  })
})

describe("pushVia treats unquoted non-ASCII words as literal", () => {
  test("a -C directory with accents resolves and refuses", () => {
    expect(run("git -C /work/café push")).toBe("/work/café")
  })

  test("a quoted non-ASCII directory still fails open", () => {
    expect(run("git -C '/work/café' push")).toBeUndefined()
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
    ["git push -vo ci.skip origin", "origin"],
    ["git push -vo ci.skip", undefined],
    ["git push -vofoo origin", "origin"],
    ["git push -4u origin", "origin"],
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
    expect(refusal?.reason).toBe(
      "Blocked by safety (push-via-guard): a plain `git push` to github.com cannot work on this host. Push with `dgit -C /work/repo push` instead (same arguments), and push WIP often so commits are not lost.",
    )
  })

  test("quotes a directory with a space in the hint", () => {
    expect(hardGate("git push", "/work/my repo", options)?.reason).toContain(
      "`dgit -C '/work/my repo' push`",
    )
  })

  test.each([
    ["GIT_DIR", { GIT_DIR: "/x/.git" }],
    ["GIT_WORK_TREE", { GIT_WORK_TREE: "/x" }],
    ["GIT_COMMON_DIR", { GIT_COMMON_DIR: "/x" }],
    ["GIT_CONFIG_COUNT", { GIT_CONFIG_COUNT: "1" }],
    ["GIT_CONFIG_GLOBAL", { GIT_CONFIG_GLOBAL: "/x" }],
  ])("an inherited %s fails open", (_name, env) => {
    expect(hardGate("git push", "/work/repo", { ...options, env })).toBeUndefined()
  })

  test("an unrelated inherited variable still refuses", () => {
    expect(hardGate("git push", "/work/repo", { ...options, env: { GIT_TERMINAL_PROMPT: "0" } })?.guard).toBe("push-via")
  })

  test("is off without the option", () => {
    expect(hardGate("git push", "/work/repo", { resolveRemote: at(GITHUB) })).toBeUndefined()
  })

  test("can be disabled by id", () => {
    expect(hardGate("git push", "/work/repo", { ...options, disabled: new Set(["push-via"]) })).toBeUndefined()
  })
})

describe("default resolver with real git", () => {
  // An empty HOME, so the developer's own global git config (insteadOf rules) cannot change the outcome,
  // and no inherited GIT_DIR or similar can steer a fixture command into a real repository.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "push-via-home-")))
  afterAll(() => rmSync(home, { recursive: true }))
  const gitEnv = untrustedLocalGitEnv({ PATH: Bun.env.PATH, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" })

  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  }

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

  // origin is on github, lab is on gitlab; the bare push picks one by config.
  const twoRemotes = (...settings: Array<[string, string]>) => (dir: string) => {
    git(dir, "remote", "add", "lab", GITLAB)
    for (const [key, value] of settings) git(dir, "config", key, value)
  }

  test.each([
    ["branch.<name>.remote", [["branch.main.remote", "lab"]], undefined],
    ["remote.pushDefault", [["remote.pushDefault", "lab"]], undefined],
    ["remote.pushDefault beats branch.<name>.remote", [["remote.pushDefault", "lab"], ["branch.main.remote", "origin"]], undefined],
    ["branch.<name>.remote beats the origin fallback", [["branch.main.remote", "origin"]], "push-via"],
    ["branch.<name>.pushRemote beats remote.pushDefault", [["remote.pushDefault", "lab"], ["branch.main.pushRemote", "origin"]], "push-via"],
    ["origin when nothing is configured", [], "push-via"],
  ] as Array<[string, Array<[string, string]>, GuardID | undefined]>)("a bare push: %s", (_name, settings, guard) => {
    withRepo(GITHUB, twoRemotes(...settings), (dir) => expect(guardOf(dir, "git push")).toBe(guard))
  })

  test("a remote name containing a slash is resolved as a name, by its push URL", () => {
    withRepo(
      GITLAB,
      (dir) => {
        git(dir, "remote", "add", "team/lab", GITHUB)
        git(dir, "config", "remote.team/lab.pushurl", GITLAB)
      },
      (dir) => expect(guardOf(dir, "git push team/lab")).toBeUndefined(),
    )
  })

  test("a remote name containing a slash is refused when its push URL is on the host", () => {
    withRepo(
      GITLAB,
      (dir) => git(dir, "remote", "add", "team/hub", GITHUB),
      (dir) => expect(guardOf(dir, "git push team/hub")).toBe("push-via"),
    )
  })

  test("an explicit URL fails open when a pushInsteadOf rule exists", () => {
    withRepo(
      GITLAB,
      (dir) => git(dir, "config", "url.https://gitlab.example.com/.pushInsteadOf", "https://github.com/"),
      (dir) => expect(guardOf(dir, "git push https://github.com/a/b.git")).toBeUndefined(),
    )
  })

  test("an explicit URL on the host is refused when no pushInsteadOf rule exists", () => {
    withRepo(
      GITLAB,
      () => {},
      (dir) => expect(guardOf(dir, "git push https://github.com/a/b.git")).toBe("push-via"),
    )
  })

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

  // git: branch.<name>.remote, else the only configured remote, else `origin` (remote.c, remotes_remote_for_branch).
  test("a bare push with only a github remote named upstream is refused", () => {
    withRepo(
      GITHUB,
      (dir) => git(dir, "remote", "rename", "origin", "upstream"),
      (dir) => expect(guardOf(dir, "git push")).toBe("push-via"),
    )
  })

  test("a bare push with a lone gitlab remote named upstream passes", () => {
    withRepo(
      GITLAB,
      (dir) => git(dir, "remote", "rename", "origin", "upstream"),
      (dir) => expect(guardOf(dir, "git push")).toBeUndefined(),
    )
  })

  test("with several remotes and no origin the push target is unknown, so it fails open", () => {
    withRepo(
      GITHUB,
      (dir) => {
        git(dir, "remote", "rename", "origin", "upstream")
        git(dir, "remote", "add", "lab", GITLAB)
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
