import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "./executable-fixture.ts"
import { GIT_VERSION_MESSAGE, gitVersionProblem, hardenedGitEnv, parseGitVersion } from "./safe-git.ts"

describe("gitVersionProblem", () => {
  test.each([
    ["git version 2.45.0", false],
    ["git version 2.56.1 (Apple Git-150)", false],
    ["git version 3.0.0", false],
    ["git version 2.44.9", true],
    ["git version 2.41.0", true],
    ["git version 1.9.0", true],
    ["", true],
    ["zsh: command not found: git", true],
  ])("%p -> problem: %p", (text, problem) => {
    expect(gitVersionProblem(text) !== undefined).toBe(problem)
  })
  test("names the minimum in the exact refusal message", () => {
    expect(gitVersionProblem("git version 2.44.0")).toBe("subagent-worktree needs git 2.45+ for safe automatic merges")
    expect(GIT_VERSION_MESSAGE).toBe("subagent-worktree needs git 2.45+ for safe automatic merges")
  })
  test("parses a version without a patch number", () => {
    expect(parseGitVersion("git version 2.50")).toEqual([2, 50, 0])
  })
})

describe("hardenedGitEnv", () => {
  test("appends to an existing GIT_CONFIG_COUNT and drops GIT_EXTERNAL_DIFF", () => {
    const env = hardenedGitEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c", GIT_EXTERNAL_DIFF: "evil", HOME: "/h" })
    expect(env.GIT_CONFIG_KEY_0).toBe("a.b")
    expect(env.GIT_CONFIG_KEY_1).toBe("core.fsmonitor")
    expect(env.GIT_CONFIG_VALUE_1).toBe("false")
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined()
    expect(env.HOME).toBe("/h")
  })
  test("sets the attribute source, optional locks and lazy fetch", () => {
    const env = hardenedGitEnv({})
    expect({ attr: env.GIT_ATTR_SOURCE, locks: env.GIT_OPTIONAL_LOCKS, lazy: env.GIT_NO_LAZY_FETCH }).toEqual({
      attr: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      locks: "0",
      lazy: "1",
    })
  })
})

// Real git: a partial clone whose blob is missing, so reading it needs a lazy fetch.
describe("hardenedGitEnv against a hostile repository's lazy fetch", () => {
  setDefaultTimeout(30_000)
  let root = ""
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "safe-git-lazy-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  const git = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return out.trim()
  }
  const marker = (name: string) => join(root, name)
  const fired = (name: string) => Bun.file(marker(name)).exists()

  /** A `--no-checkout` partial clone of a one-file repository; its `origin` is re-pointed at `url` and `config` is set in the clone. */
  const lazyClone = async (name: string, url: string, config: ReadonlyArray<readonly [string, string]>) => {
    const source = join(root, `${name}-source`)
    await git(root, "init", "--quiet", "--initial-branch=main", source)
    await git(source, "config", "uploadpack.allowFilter", "true")
    await git(source, "config", "uploadpack.allowAnySHA1InWant", "true")
    await writeFile(join(source, "a.txt"), "content\n")
    await git(source, "add", "a.txt")
    await git(source, "commit", "--quiet", "-m", "init")
    const clone = join(root, `${name}-clone`)
    await git(root, "clone", "--quiet", "--no-checkout", "--filter=blob:none", `file://${source}`, clone)
    for (const [key, value] of config) await git(clone, "config", key, value)
    await git(clone, "remote", "set-url", "origin", url)
    const blob = await git(source, "rev-parse", "HEAD:a.txt")
    // The clone really lacks the blob, so the read below must start a lazy fetch.
    expect((await git(clone, "rev-list", "--objects", "--missing=print", "HEAD")).split("\n")).toContain(`?${blob}`)
    return { clone, blob }
  }
  /** `cat-file` on the missing blob, with the lazy fetch left on so only the config overrides stand in its way. */
  const catBlob = async (clone: string, blob: string, hardened: boolean) => {
    const env = hardened ? hardenedGitEnv(Bun.env) : { ...Bun.env }
    delete env.GIT_NO_LAZY_FETCH
    await Bun.spawn(["git", "-C", clone, "cat-file", "-p", blob], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited
  }

  test("a lazy fetch over ssh runs no core.sshCommand of the repository", async () => {
    writeExecutable(join(root, "ssh-command"), `#!/bin/sh\ntouch ${marker("ssh-command-ran")}\nexit 1\n`)
    const { clone, blob } = await lazyClone("lazy-ssh", "ssh://example.invalid/repo", [["core.sshCommand", join(root, "ssh-command")]])
    await catBlob(clone, blob, true)
    const hardened = await fired("ssh-command-ran")
    // The control: the same read with no hardening reaches the command, so the fixture does start a lazy fetch.
    await catBlob(clone, blob, false)
    expect({ hardened, unhardened: await fired("ssh-command-ran") }).toEqual({ hardened: false, unhardened: true })
  })

  test("a lazy fetch that meets an authentication challenge runs no credential.helper of the repository", async () => {
    writeExecutable(join(root, "credential-helper"), `#!/bin/sh\ntouch ${marker("credential-helper-ran")}\nexit 1\n`)
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } }) })
    try {
      const { clone, blob } = await lazyClone("lazy-cred", `http://127.0.0.1:${server.port}/repo.git`, [["credential.helper", join(root, "credential-helper")]])
      await catBlob(clone, blob, true)
      const hardened = await fired("credential-helper-ran")
      await catBlob(clone, blob, false)
      expect({ hardened, unhardened: await fired("credential-helper-ran") }).toEqual({ hardened: false, unhardened: true })
    } finally {
      await server.stop(true)
    }
  })
})
