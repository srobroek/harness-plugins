import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import { writeClaim } from "@srobroek/opencode-lib/worktree-claims"
import { setHold } from "@srobroek/opencode-lib/worktree-locks"
import { TOOL_FIRST_LINE } from "../../../scripts/check-descriptions.ts"
import { CLEANUP_INPUT, CLEANUP_OUTPUT } from "../opencode/src/cleanup-tool.ts"
import { type CliResult, type CliRunner, runCli, SAFE_GIT_ARGS } from "../opencode/src/forge-adapter.ts"
import { buildReceipt, type LandingReceipt, receiptDirectory, repoKey, repositoryContext, writeReceipt } from "../opencode/src/landing-receipt.ts"
import pkg from "../package.json" with { type: "json" }
import delivery, { type CleanupTool, cleanupTool, DESCRIPTION, otherRepositoryReason, type PiCleanupDeps } from "./delivery-cleanup.ts"

// Each test builds real Git repositories (a bare remote, a checkout, a linked worktree, a merge)
// and runs real git for everything but the forge reads: 2.3-5.8 s per test, 46 s for the file, on
// a developer machine whose endpoint scanner slows every spawn. 30 s leaves five times that.
setDefaultTimeout(30_000)

const ROOTS: string[] = []
afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true })
})

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" }

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV }).trim()
}

function scratch(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `delivery-pi-${name}-`)))
  ROOTS.push(root)
  return root
}

/** A checkout with an `origin` bare remote and one commit on main. */
function checkout(root: string, name: string): { main: string; bare: string } {
  const bare = join(root, `${name}.git`)
  const main = join(root, name)
  mkdirSync(bare)
  git(bare, ["init", "--bare", "-q", "--template="])
  mkdirSync(main)
  git(main, ["init", "-q", "-b", "main", "--template="])
  git(main, ["config", "user.email", "delivery@example.test"])
  git(main, ["config", "user.name", "Delivery Test"])
  writeFileSync(join(main, "base.txt"), "base\n")
  git(main, ["add", "base.txt"])
  git(main, ["commit", "-q", "-m", "base"])
  git(main, ["remote", "add", "origin", bare])
  git(main, ["push", "-q", "-u", "origin", "main"])
  return { main, bare }
}

type Landed = { root: string; main: string; linked: string; branch: string; head: string; merge: string; receipt: LandingReceipt; receiptPath: string; env: NodeJS.ProcessEnv }

/**
 * A PR that landed: its worktree's branch was pushed, merged into main and deleted on the remote, and
 * the landing receipt `delivery_land` writes is on disk. The repository has no Beads ledger.
 */
async function landed(name: string): Promise<Landed> {
  const root = scratch(name)
  const { main, bare } = checkout(root, "main")
  const branch = `feat/${name}`
  const linked = join(root, "linked")
  git(main, ["worktree", "add", "-q", "-b", branch, linked])
  writeFileSync(join(linked, "feature.txt"), "feature\n")
  git(linked, ["add", "feature.txt"])
  git(linked, ["commit", "-q", "-m", "feature"])
  git(linked, ["push", "-q", "-u", "origin", branch])
  const head = git(linked, ["rev-parse", "HEAD"])
  git(main, ["merge", "-q", "--no-ff", branch, "-m", "merge feature"])
  const merge = git(main, ["rev-parse", "HEAD"])
  git(main, ["push", "-q", "origin", "main"])
  git(bare, ["update-ref", "-d", `refs/heads/${branch}`])
  const env = { ...process.env, DELIVERY_RECEIPTS_DIR: join(root, "receipts") }
  const key = await repoKey(main)
  if (key === null) throw new Error("fixture repository has no key")
  const receipt = buildReceipt({
    emitter: { plugin: pkg.name, version: pkg.version, tool: "delivery_land" },
    repo: { key, canonicalRoot: main, remote: "origin", forge: "github", nameWithOwner: "owner/repo" },
    pr: {
      number: 17,
      url: "https://github.com/owner/repo/pull/17",
      state: "MERGED",
      baseRefName: "main",
      headRefName: branch,
      headRefOid: head,
      mergeCommitOid: merge,
      mergedAt: "2027-01-15T08:00:00.000Z",
    },
    branch: { name: branch, deletedRemote: true, remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z", autoDeleteSetting: "on" },
    worktree: { path: linked, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
    beads: { ids: [], ledgerActive: false },
    proof: { method: "gh pr view", observedAt: "2027-01-15T08:00:00.000Z", evidence: { state: "MERGED" } },
    outcome: "landed",
  })
  const receiptPath = writeReceipt(receipt, receiptDirectory(env, key))
  return { root, main, linked, branch, head, merge, receipt, receiptPath, env }
}

const ok = (stdout: string, exitCode = 0): CliResult => ({ ok: true, exitCode, stdout, stderr: "" })

/**
 * Real git, except the forge: `gh` answers for the landed PR, and `git remote get-url` names a
 * GitHub repository (the fixture's real remote is a local path, which names none). A checkout under
 * `others` names that repository instead.
 */
function forge(f: Landed, others: Record<string, string> = {}): CliRunner {
  return (argv, options) => {
    const git = argv[0] === "git" ? argv.slice(1 + SAFE_GIT_ARGS.length) : []
    if (argv[0] === "gh" && argv[2] === "graphql") return ok(JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", ref: null } } }))
    if (argv[0] === "gh") {
      const { pr } = f.receipt
      return ok(JSON.stringify({ ...pr, mergeCommit: { oid: pr.mergeCommitOid } }))
    }
    if (git[0] === "remote" && git[1] === "get-url") {
      const other = Object.entries(others).find(([dir]) => options.cwd?.startsWith(dir))
      return ok(`https://github.com/${other?.[1] ?? "owner/repo"}.git\n`)
    }
    if (git.includes("ls-remote")) return ok("", 2)
    return runCli(argv, options)
  }
}

function deps(f: Landed, others: Record<string, string> = {}): PiCleanupDeps {
  return { cleanup: { run: forge(f, others), env: f.env }, lock: { waitMs: 5_000 } }
}

/** A tool context whose UI fails the test if anything asks. */
function context(cwd: string, hasUI: boolean): ExtensionToolContext {
  const ask = async () => {
    throw new Error("delivery_cleanup must not ask")
  }
  return { cwd, hasUI, ui: { confirm: ask, select: ask, input: ask } } as unknown as ExtensionToolContext
}

async function call(tool: CleanupTool, params: object, ctx: ExtensionToolContext, signal?: AbortSignal) {
  const result = await tool.execute("call_1", params as never, signal, undefined, ctx)
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
  return { ...result, text, output: result.structuredContent as Record<string, unknown> }
}

const branchExists = (f: Landed) => git(f.main, ["branch", "--list", f.branch]) !== ""

describe("registration", () => {
  test("the extension registers one tool, delivery_cleanup, with the OpenCode schemas and OMP's exec tier", () => {
    const tools: CleanupTool[] = []
    delivery({ registerTool: (tool: CleanupTool) => void tools.push(tool) } as unknown as ExtensionAPI)
    expect(tools.map((tool) => tool.name)).toEqual(["delivery_cleanup"])
    const [tool] = tools as [CleanupTool]
    expect(tool.parameters).toBe(CLEANUP_INPUT as never)
    expect(tool.outputSchema).toBe(CLEANUP_OUTPUT as never)
    expect(tool.approval).toBe("exec")
    expect(tool.description).toBe(DESCRIPTION)
  })

  test("the first description line fits the limit every tool listing keeps", () => {
    expect(DESCRIPTION.split("\n", 1)[0]?.length ?? 0).toBeLessThanOrEqual(TOOL_FIRST_LINE)
  })
})

describe("an explicit cleanup in the session's repository", () => {
  test("without a UI, it removes the worktree and local branch, writes the continuation receipt and asks nothing", async () => {
    const f = await landed("removes")
    const result = await call(cleanupTool(deps(f)), { pr: 17 }, context(f.main, false))
    expect(result.output).toMatchObject({ ok: true, alreadyCleaned: false, branch: f.branch, worktree: f.linked, remoteBranchAbsence: "absent" })
    expect(result.text).toStartWith(`delivery_cleanup removed worktree ${f.linked}, local branch ${f.branch}; remote branch absent.`)
    expect(result.text).toContain(`\nreceipt: ${result.output.receiptPath}`)
    expect(result.output.receiptPath).not.toBe(f.receiptPath)
    expect((result.output.receipt as LandingReceipt).worktree).toMatchObject({ path: f.linked, removed: true, localRefDeleted: true })
    // details is the output without the receipt, which lives on disk.
    expect(result.details).toEqual(Object.fromEntries(Object.entries(result.output).filter(([key]) => key !== "receipt")))
    expect(existsSync(f.linked)).toBe(false)
    expect(branchExists(f)).toBe(false)
  })

  test("the tool input reaches cleanupDelivery unchanged: a pr that is not the receipt's is refused", async () => {
    const f = await landed("mismatch")
    const result = await call(cleanupTool(deps(f)), { receipt: f.receiptPath, pr: 18 }, context(f.main, true))
    expect(result.output.ok).toBe(false)
    expect(result.text).toStartWith("delivery_cleanup refused: pr")
    expect(result.text).toContain("18")
    expect(existsSync(f.linked)).toBe(true)
  })

  test("the session directory is the tool context's cwd: a call from inside the target is refused", async () => {
    const f = await landed("inside")
    const result = await call(cleanupTool(deps(f)), { receipt: f.receiptPath }, context(f.linked, false))
    expect(result.text).toStartWith("delivery_cleanup refused: worktree.invocationCwd")
    expect(existsSync(f.linked)).toBe(true)
  })

  test("the call's abort signal stops it before the removal", async () => {
    const f = await landed("aborted")
    const controller = new AbortController()
    controller.abort()
    const result = await call(cleanupTool(deps(f)), { receipt: f.receiptPath }, context(f.main, false), controller.signal)
    expect(result.output.ok).toBe(false)
    expect(existsSync(f.linked)).toBe(true)
    expect(branchExists(f)).toBe(true)
  })

  test("without a UI, a dirty worktree is refused with the reason and nothing is removed", async () => {
    const f = await landed("dirty")
    writeFileSync(join(f.linked, "scratch.txt"), "not committed\n")
    const result = await call(cleanupTool(deps(f)), { receipt: f.receiptPath }, context(f.main, false))
    expect(result.output).toEqual({ ok: false, reason: expect.stringMatching(/^worktree\.status:/) })
    expect(result.text).toStartWith("delivery_cleanup refused: worktree.status:")
    expect(existsSync(join(f.linked, "scratch.txt"))).toBe(true)
    expect(branchExists(f)).toBe(true)
  })

  test("a worktree a lane claims is deferred to its owner, untouched", async () => {
    const f = await landed("claimed")
    const common = (await repositoryContext(f.main))?.commonDir as string
    writeClaim(common, { directory: f.linked, branch: f.branch, sessionID: "lane", parentID: "lead", createdAt: 1 })
    const result = await call(cleanupTool(deps(f)), { receipt: f.receiptPath }, context(f.main, false))
    expect(result.output).toEqual({ ok: true, deferred: "owned by subagent-worktree lane; removed by its owner once finished" })
    expect(result.text).toBe("delivery_cleanup deferred: owned by subagent-worktree lane; removed by its owner once finished")
    expect(existsSync(f.linked)).toBe(true)
  })

  test("background work recorded for the worktree holds the removal, read under the lock", async () => {
    const f = await landed("held")
    const common = (await repositoryContext(f.main))?.commonDir as string
    setHold(common, f.linked, "s1", [{ kind: "bash", id: "b1" }], Date.now())
    const result = await call(cleanupTool(deps(f)), { receipt: f.receiptPath }, context(f.main, false))
    expect(result.text).toStartWith("delivery_cleanup refused: worktree.held: observed session s1 has 1 background job(s) running (bash b1)")
    expect(existsSync(f.linked)).toBe(true)
    expect(branchExists(f)).toBe(true)
  })

  test("a second call reports the worktree already cleaned and writes nothing", async () => {
    const f = await landed("twice")
    const tool = cleanupTool(deps(f))
    const first = await call(tool, { receipt: f.receiptPath }, context(f.main, false))
    const second = await call(tool, { receipt: first.output.receiptPath as string }, context(f.main, false))
    expect(second.output).toMatchObject({ ok: true, alreadyCleaned: true, removed: [] })
    expect(second.text).toStartWith("delivery_cleanup: nothing to remove.")
  })

  test("two concurrent calls on one receipt: one removes, the other finds it already cleaned, neither refuses", async () => {
    const f = await landed("concurrent")
    const ctx = context(f.main, false)
    const results = await Promise.all([1, 2].map(() => call(cleanupTool(deps(f)), { receipt: f.receiptPath }, ctx)))
    const outputs = results.map((result) => result.output)
    expect(outputs.every((output) => output.ok === true)).toBe(true)
    expect(outputs.map((output) => output.alreadyCleaned).sort()).toEqual([false, true])
    expect(existsSync(f.linked)).toBe(false)
  })
})

describe("another repository is refused", () => {
  test("repo and repoPath naming another clone: refused, and nothing is removed", async () => {
    const f = await landed("other-clone")
    const { main: other } = checkout(f.root, "other")
    const result = await call(cleanupTool(deps(f, { [other]: "other/repo" })), { repo: "other/repo", repoPath: other }, context(f.main, false))
    expect(result.output).toEqual({ ok: false, reason: otherRepositoryReason(other) })
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a worktree of another repository: refused, and nothing in it is removed", async () => {
    const f = await landed("other-worktree")
    const { main: other } = checkout(f.root, "other")
    const foreign = join(f.root, "foreign")
    git(other, ["worktree", "add", "-q", "-b", "feat/foreign", foreign])
    const result = await call(cleanupTool(deps(f)), { worktree: foreign }, context(f.main, false))
    expect(result.text).toStartWith("delivery_cleanup refused: worktree.owner")
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(f.linked)).toBe(true)
  })
})
