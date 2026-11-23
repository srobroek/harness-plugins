import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import {
  type Check,
  type CommandResult,
  Context,
  checkCwdIsWorktree,
  checkHookApprovals,
  checkMergeEvidence,
  checkNodeModulesIntegrity,
  checkProvisioningHook,
  checkProvisioningInclude,
  checkWtAvailable,
  commandResult,
  type PreflightContext,
  type RunOptions,
  runPreflight,
} from "./preflight.ts"

// Mirrors common/skills/worktrunk-preflight/test_preflight.py case for case.

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function scratch(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "worktrunk-preflight-")))
  directories.push(directory)
  return directory
}

type Responder = (args: readonly string[]) => CommandResult | undefined

/** A repository at `root` whose git and wt answers are canned; an unexpected command fails the test. */
class FakeContext implements PreflightContext {
  readonly cwd: string
  readonly home: string
  ignoredConfigKeys: string[] = []
  readonly gitRootError = undefined
  readonly #ignored: Set<string>
  readonly #remote: string | undefined
  readonly #hookConfig: string
  readonly #respond: Responder

  constructor(
    readonly root: string,
    options: { home?: string; remote?: string; ignored?: string[]; hookConfig?: string; respond?: Responder } = {},
  ) {
    this.cwd = root
    this.home = options.home ?? join(root, "home")
    this.#ignored = new Set(options.ignored ?? ["node_modules"])
    this.#remote = options.remote
    this.#hookConfig = options.hookConfig ?? ""
    this.#respond = options.respond ?? (() => undefined)
  }

  async requireGitRoot(): Promise<string> {
    return this.root
  }

  async mutateFile(_path: string, write: () => void): Promise<void> {
    write()
  }

  async run(args: readonly string[], _options?: RunOptions): Promise<CommandResult> {
    const own = this.#respond(args)
    if (own !== undefined) return own
    const key = args.join(" ")
    if (key.startsWith("git check-ignore -q ")) return commandResult(this.#ignored.has(args[3] as string) ? 0 : 1)
    if (key === "git config --get remote.origin.url") return commandResult(0, `${this.#remote ?? ""}\n`)
    if (key === "wt config show") return commandResult(0, this.#hookConfig)
    throw new Error(`unexpected command: ${key}`)
  }
}

const approvals = (payload: unknown): Responder => (args) =>
  args.join(" ") === "wt config approvals list --format=json" ? commandResult(0, JSON.stringify(payload)) : undefined

const approved = (template: string) => ({
  state: "approved",
  commands: [{ phase: "pre-start", name: "verify", template, approved: true }],
})

describe("worktrunk preflight", () => {
  test("invalid UTF-8 command output is reported without an exception", async () => {
    const script = join(scratch(), "emit-invalid-utf8")
    writeExecutable(script, "printf '\\377\\376'\n")
    const found = await new Context(scratch()).run([script])
    expect(found.returncode).toBe(0)
    expect(found.stdout).toContain("\ufffd")
  })

  test("an empty or unrelated .worktreeinclude warns and a matching one passes", async () => {
    const root = scratch()
    const include = join(root, ".worktreeinclude")
    const context = new FakeContext(root)
    writeFileSync(include, "# only unrelated state\n.cache/\n")
    expect((await checkProvisioningInclude(context)).status).toBe("warn")
    writeFileSync(include, "node_modules/\n")
    const found = await checkProvisioningInclude(context)
    expect(found.status).toBe("pass")
    expect(found.detail).toContain("node_modules")
  })

  test("a declared dependency missing from a partial copy warns with the repair", async () => {
    const root = scratch()
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { present: "1.0.0", missing: "1.0.0" } }))
    mkdirSync(join(root, "node_modules", "present"), { recursive: true })
    const found = await checkNodeModulesIntegrity(new FakeContext(root))
    expect(found.status).toBe("warn")
    expect(found.detail).toContain("missing")
    expect(found.fix).toContain("bun install --frozen-lockfile")
  })

  test("a platform optional dependency may be absent", async () => {
    const root = scratch()
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { present: "1.0.0" }, optionalDependencies: { "platform-only": "1.0.0" } }),
    )
    mkdirSync(join(root, "node_modules", "present"), { recursive: true })
    const found = await checkNodeModulesIntegrity(new FakeContext(root))
    expect(found.status).toBe("pass")
    expect(found.detail).toContain("declared node_modules packages")
  })

  test("a skeleton @types/bun warns with the repair", async () => {
    const root = scratch()
    mkdirSync(join(root, "node_modules", "@types", "bun"), { recursive: true })
    const found = await checkNodeModulesIntegrity(new FakeContext(root))
    expect(found.status).toBe("warn")
    expect(found.detail).toContain("TS2688")
    expect(found.fix).toContain("bun install --frozen-lockfile")
  })

  test("invalid git metadata is a failure", async () => {
    const broken = new FakeContext(scratch(), { respond: () => commandResult(128, "", "not a git repository") })
    const found = await checkCwdIsWorktree(broken)
    expect(found.status).toBe("fail")
    expect(found.detail).toContain("not a git repository")
  })

  test("hook approvals check that declared executable paths are executable", async () => {
    const root = scratch()
    const hook = join(root, "verify.sh")
    writeFileSync(hook, "#!/bin/sh\nexit 0\n")
    const payload = {
      state: "approved",
      commands: [{ phase: "pre-merge", name: "verify", template: "./verify.sh", approved: true }],
      stale: [],
    }
    expect((await checkHookApprovals(new FakeContext(root, { respond: approvals(payload) }))).status).toBe("fail")
    writeExecutable(hook, "exit 0\n")
    const found = await checkHookApprovals(new FakeContext(root, { respond: approvals(payload) }))
    expect(found.status).toBe("pass")
    expect(found.detail).toContain("present, executable, and approved")
  })

  test("an interpreter hook only requires its script to be readable", async () => {
    const root = scratch()
    writeFileSync(join(root, "verify.py"), "print('ok')\n")
    const found = await checkHookApprovals(new FakeContext(root, { respond: approvals(approved("python3 ./verify.py")) }))
    expect(found.status).toBe("pass")
  })

  test("hook approvals report a missing declared executable", async () => {
    const found = await checkHookApprovals(new FakeContext(scratch(), { respond: approvals(approved("./missing.sh")) }))
    expect(found.status).toBe("fail")
    expect(found.detail).toContain("missing hook executables")
  })

  test("hook approvals report a missing executable named without a path", async () => {
    const found = await checkHookApprovals(
      new FakeContext(scratch(), { respond: approvals(approved("missing-tool verify")) }),
    )
    expect(found.status).toBe("fail")
    expect(found.detail).toContain("missing-tool")
  })

  test("an invalid package manifest warns with the repair", async () => {
    const root = scratch()
    writeFileSync(join(root, "package.json"), "{not-json")
    mkdirSync(join(root, "node_modules"))
    const found = await checkNodeModulesIntegrity(new FakeContext(root))
    expect(found.status).toBe("warn")
    expect(found.detail).toContain("package.json is unreadable or invalid")
    expect(found.fix).toContain("bun install --frozen-lockfile")
  })

  test("with only, a warn fails the report", async () => {
    const selected: Check = async () => ({ status: "warn", detail: "needs attention", fix: null })
    const report = await runPreflight({ only: ["selected"] }, new FakeContext(scratch()), [["selected", selected]])
    expect(report.ok).toBe(false)
  })

  test("an unknown only id is refused", async () => {
    await expect(runPreflight({ only: ["nope"] }, new FakeContext(scratch()))).rejects.toThrow("unknown check id(s): nope")
  })

  test("non-text command output fails closed", async () => {
    const malformed = new FakeContext(scratch(), {
      respond: (args) =>
        args.join(" ") === "wt --version"
          ? ({ returncode: 0, stdout: { version: "1.0" }, stderr: ["not", "text"] } as unknown as CommandResult)
          : undefined,
    })
    const found = await checkWtAvailable(malformed)
    expect(found.status).toBe("fail")
    expect(found.detail).toContain("non-text")
  })

  test("malformed approval output fails the default report", async () => {
    const malformed = new FakeContext(scratch(), {
      respond: (args) =>
        args.join(" ") === "wt config approvals list --format=json"
          ? ({ returncode: 0, stdout: { commands: [] }, stderr: "" } as unknown as CommandResult)
          : undefined,
    })
    expect((await checkHookApprovals(malformed)).status).toBe("fail")
    const report = await runPreflight({}, malformed, [["hook-approvals", (ctx) => checkHookApprovals(ctx)]])
    expect(report.ok).toBe(false)
  })

  test("the provisioning hook passes for a user post-start copy", async () => {
    const root = scratch()
    const config = join(root, "home", ".config", "worktrunk", "config.toml")
    mkdirSync(join(config, ".."), { recursive: true })
    writeFileSync(config, '[post-start]\ncopy = "wt step copy-ignored --require-include"\n')
    const found = await checkProvisioningHook(new FakeContext(root))
    expect(found.status).toBe("pass")
    expect(found.detail).toContain("post-start")
  })

  test("the provisioning hook fails when the copy hook is absent", async () => {
    const found = await checkProvisioningHook(new FakeContext(scratch()))
    expect(found.status).toBe("fail")
    expect(found.detail).toContain("[post-start]")
    expect(found.detail).toContain("copy-ignored")
  })

  test("a uv project requires uv sync", async () => {
    const root = scratch()
    writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "example"\n')
    writeFileSync(join(root, "uv.lock"), "version = 1\n")
    const found = await checkProvisioningHook(new FakeContext(root, { ignored: [] }))
    expect(found.status).toBe("fail")
    expect(found.detail).toContain('deps = "uv sync"')
  })

  test("a pre-start provisioning hook passes with a note that it blocks creation", async () => {
    const root = scratch()
    const config = join(root, "home", ".config", "worktrunk", "config.toml")
    mkdirSync(join(config, ".."), { recursive: true })
    writeFileSync(config, '[[pre-start]]\ncopy = "wt step copy-ignored"\n')
    const found = await checkProvisioningHook(new FakeContext(root))
    expect(found.status).toBe("pass")
    expect(found.detail).toContain("pre-start")
    expect(found.detail).toContain("block worktree creation")
  })

  test("apply appends the missing provisioning entries and keeps existing content", async () => {
    const root = scratch()
    const config = join(root, ".config", "wt.toml")
    const original = '# keep this comment\n[step.copy-ignored]\nexclude = ["target/"]\n'
    mkdirSync(join(root, ".config"))
    writeFileSync(config, original)
    const report = await runPreflight({ only: ["provisioning-hook"], apply: true }, new FakeContext(root))
    const found = report.checks[0]
    expect(report.ok).toBe(true)
    expect(found?.status).toBe("pass")
    expect(readFileSync(config, "utf8")).toBe(
      `${original}\n[post-start]\ncopy-ignored = "wt step copy-ignored --require-include"\n`,
    )
    expect(found?.detail).toContain("wt config approvals add")
  })

  test("the provisioning check is read-only without apply", async () => {
    const root = scratch()
    const config = join(root, ".config", "wt.toml")
    mkdirSync(join(root, ".config"))
    writeFileSync(config, "# untouched\n")
    const found = await checkProvisioningHook(new FakeContext(root))
    expect(found.status).toBe("fail")
    expect(readFileSync(config, "utf8")).toBe("# untouched\n")
  })

  test("matching project-scoped merge settings pass", async () => {
    const home = scratch()
    const config = join(home, ".config", "worktrunk", "config.toml")
    mkdirSync(join(config, ".."), { recursive: true })
    writeFileSync(config, '[projects."github.com/user/repo"]\nmerge.squash = false\nmerge.ff = false\n')
    const found = await checkMergeEvidence(new FakeContext(home, { home, remote: "git@github.com:user/repo.git" }))
    expect(found.status).toBe("pass")
    expect(found.detail).toContain("github.com/user/repo")
  })

  test("project-scoped merge settings for another repository warn", async () => {
    const home = scratch()
    const config = join(home, ".config", "worktrunk", "config.toml")
    mkdirSync(join(config, ".."), { recursive: true })
    writeFileSync(config, '[projects."github.com/other/repo"]\nmerge.squash = false\nmerge.ff = false\n')
    const found = await checkMergeEvidence(new FakeContext(home, { home, remote: "git@github.com:user/repo.git" }))
    expect(found.status).toBe("warn")
  })
})
