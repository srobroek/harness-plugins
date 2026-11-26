import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import { TOOL_FIRST_LINE } from "../../../scripts/check-descriptions.ts"
import { type CliResult, type CliRunner, runCli, SAFE_GIT_ARGS } from "../opencode/src/forge-adapter.ts"
import { LAND_INPUT, LAND_OUTPUT, landDescription } from "../opencode/src/land-tool.ts"
import { type LandingReceipt, readReceipt } from "../opencode/src/landing-receipt.ts"
import deliveryLand, { DESCRIPTION, type LandTool, landTool, type PiLandDeps } from "./delivery-land.ts"

// Each test builds real Git repositories (a bare remote, a checkout, a linked worktree, a squash
// merge) and runs real git for everything but the forge reads: 1.1-3.4 s per test, 27-34 s for the
// file, on a developer machine whose endpoint scanner slows every spawn. 30 s leaves nine times that.
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), `delivery-pi-land-${name}-`)))
  ROOTS.push(root)
  return root
}

const TITLE = "feat(delivery): land on pi"
const OTHER_HEAD = "0123456789abcdef0123456789abcdef01234567"

type Fixture = {
  root: string
  main: string
  bare: string
  linked: string
  branch: string
  /** The PR head, checked out in `linked`. */
  head: string
  /** The squash commit on main that lands the head. */
  merge: string
  receipts: string
  env: NodeJS.ProcessEnv
  /** A settings file that names no GitLab host. */
  settings: string
}

/**
 * A PR whose branch was pushed from its linked worktree and squash-merged into main on the remote,
 * with the remote branch deleted afterwards, the way GitHub lands a squash with auto-delete on. The
 * repository has no Beads ledger, and the receipts directory is the fixture's own.
 */
function squashMerged(name: string): Fixture {
  const root = scratch(name)
  const bare = join(root, "origin.git")
  const main = join(root, "main")
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
  const branch = `feat/${name}`
  const linked = join(root, "linked")
  git(main, ["worktree", "add", "-q", "-b", branch, linked])
  writeFileSync(join(linked, "feature.txt"), "feature\n")
  git(linked, ["add", "feature.txt"])
  git(linked, ["commit", "-q", "-m", "feature"])
  git(linked, ["push", "-q", "-u", "origin", branch])
  const head = git(linked, ["rev-parse", "HEAD"])
  git(main, ["merge", "--squash", "-q", branch])
  git(main, ["commit", "-q", "-m", `${TITLE} (#17)`])
  const merge = git(main, ["rev-parse", "HEAD"])
  git(main, ["push", "-q", "origin", "main"])
  git(bare, ["update-ref", "-d", `refs/heads/${branch}`])
  const receipts = join(root, "receipts")
  const settings = join(root, "settings.json")
  writeFileSync(settings, "{}\n")
  return { root, main, bare, linked, branch, head, merge, receipts, env: { ...process.env, DELIVERY_RECEIPTS_DIR: receipts }, settings }
}

const ok = (stdout: string, exitCode = 0): CliResult => ({ ok: true, exitCode, stdout, stderr: "" })

type Forge = { run: CliRunner; calls: string[][]; merges: () => string[][] }

/**
 * Real git, except the forge. `gh pr view` answers for PR 17: MERGED at the squash commit, or OPEN
 * until a `gh pr merge` is issued when `open` is set. `git remote get-url` names
 * `https://<host>/owner/repo.git`, and a fetch from that URL fetches from the fixture's bare remote
 * instead. Any other forge command fails the test, so an unexpected write cannot pass unseen.
 */
function forge(f: Fixture, options: { open?: boolean; host?: string } = {}): Forge {
  const calls: string[][] = []
  const url = `https://${options.host ?? "github.com"}/owner/repo.git`
  let merged = options.open !== true
  const pr = () =>
    JSON.stringify({
      id: "PR_node_17",
      number: 17,
      url: "https://github.com/owner/repo/pull/17",
      title: TITLE,
      state: merged ? "MERGED" : "OPEN",
      baseRefName: "main",
      headRefName: f.branch,
      headRefOid: f.head,
      mergeCommit: merged ? { oid: f.merge } : null,
      mergedAt: merged ? "2027-01-15T08:00:00Z" : null,
    })
  const run: CliRunner = (argv, cli) => {
    calls.push([...argv])
    if (argv[0] === "git") {
      const args = argv.slice(1 + SAFE_GIT_ARGS.length)
      if (args[0] === "remote" && args[1] === "get-url") return ok(`${url}\n`)
      const fetching = args.includes("fetch")
      return runCli(
        fetching ? argv.map((word) => (word === url || word === url.replace(/\.git$/, "") ? f.bare : word)) : argv,
        cli,
      )
    }
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return ok(pr())
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
      merged = true
      return ok("")
    }
    // A branch ref read answers from the bare remote, so a deleted head branch reads as absent.
    const ref = argv[0] === "gh" && argv[2] === "graphql" ? argv.find((word) => word.startsWith("ref="))?.slice("ref=".length) : undefined
    if (ref !== undefined) {
      const oid = remoteRef(f, ref)
      const name = ref.replace(/^refs\/heads\//, "")
      const target = oid === null ? null : { prefix: "refs/heads/", name, target: { __typename: "Commit", oid } }
      return ok(JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", ref: target } } }))
    }
    // The base branch has no rules, so it takes a direct merge.
    if (argv[0] === "gh" && argv[1] === "api" && /^repos\/owner\/repo\/rules\/branches\//.test(argv[2] ?? "")) return ok("[]")
    // GitHub deletes the head branch on merge.
    if (argv[0] === "gh" && argv[1] === "api" && argv[2] === "repos/owner/repo" && argv.includes(".delete_branch_on_merge")) return ok("true\n")
    throw new Error(`the fixture forge has no answer for ${argv.join(" ")}`)
  }
  return { run, calls, merges: () => calls.filter((argv) => argv.includes("merge") && argv[0] !== "git") }
}

/** The commit `ref` names on the fixture's bare remote, or null when the remote has no such ref. */
function remoteRef(f: Fixture, ref: string): string | null {
  try {
    return git(f.bare, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])
  } catch {
    return null
  }
}

function deps(f: Fixture, run: CliRunner, settingsPath = f.settings): PiLandDeps {
  return { land: { run, env: f.env }, settingsPath }
}

type Asked = Array<{ title: string; message: string }>

/** A tool context with no UI, or one whose confirm dialog answers `answer` and records what it asked. */
function context(cwd: string, ui: { answer: boolean } | null, asked: Asked = []): ExtensionToolContext {
  const unexpected = async () => {
    throw new Error("delivery_land only ever asks for a confirmation")
  }
  return {
    cwd,
    hasUI: ui !== null,
    ui: {
      confirm: async (title: string, message: string) => {
        if (ui === null) throw new Error("a session without a UI was asked")
        asked.push({ title, message })
        return ui.answer
      },
      select: unexpected,
      input: unexpected,
      notify: () => {},
    },
  } as unknown as ExtensionToolContext
}

async function call(tool: LandTool, params: object, ctx: ExtensionToolContext, signal?: AbortSignal) {
  const result = await tool.execute("call_1", params as never, signal, undefined, ctx)
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
  return { ...result, text, output: result.structuredContent as Record<string, unknown> }
}

const receiptFiles = (f: Fixture): string[] =>
  existsSync(f.receipts) ? readdirSync(f.receipts, { recursive: true, encoding: "utf8" }).filter((file) => /[\\/][^\\/]+\.json$/.test(`/${file}`) && !file.includes("pending-")) : []

describe("registration", () => {
  test("the extension registers one tool, delivery_land, with the OpenCode schemas and OMP's exec tier", () => {
    const tools: LandTool[] = []
    deliveryLand({ registerTool: (tool: LandTool) => void tools.push(tool) } as unknown as ExtensionAPI)
    expect(tools.map((tool) => tool.name)).toEqual(["delivery_land"])
    const [tool] = tools as [LandTool]
    expect(tool.parameters).toBe(LAND_INPUT as never)
    expect(tool.outputSchema).toBe(LAND_OUTPUT as never)
    expect(tool.approval).toBe("exec")
    expect(tool.description).toBe(DESCRIPTION)
  })

  test("the description is the shared contract, and its first line fits the limit every tool listing keeps", () => {
    const first = DESCRIPTION.split("\n", 1)[0] ?? ""
    expect(first).toBe(landDescription("").split("\n", 1)[0] as string)
    expect(first.length).toBeLessThanOrEqual(TOOL_FIRST_LINE)
  })
})

describe("proving an already merged PR", () => {
  test("without a UI, it proves the squash merge, writes the receipt to the receipts directory and asks nothing", async () => {
    const f = squashMerged("proves")
    const fake = forge(f)
    const result = await call(landTool(deps(f, fake.run)), { pr: 17 }, context(f.main, null))
    expect(result.output).toMatchObject({ ok: true, mergeSha: f.merge, pr: 17, repo: "owner/repo", next: ["delivery_cleanup"] })
    expect(result.output.cleanup).toBeUndefined()
    expect(result.text).toStartWith(`delivery_land proved owner/repo#17 merged as ${f.merge.slice(0, 12)} on github.`)
    expect(result.text).toContain("next: run delivery_cleanup to remove the worktree and the local branch.")
    const receiptPath = result.output.receiptPath as string
    expect(receiptPath.startsWith(`${f.receipts}/`)).toBe(true)
    const read = readReceipt(receiptPath)
    if (!read.ok) throw new Error(read.reason)
    const receipt: LandingReceipt = read.receipt
    expect(receipt.pr).toMatchObject({ number: 17, state: "MERGED", headRefOid: f.head, mergeCommitOid: f.merge })
    expect(receipt.worktree.path).toBe(f.linked)
    expect(receipt.emitter.tool).toBe("delivery_land")
    // details is the output without the receipt, which lives on disk.
    expect(result.details).toEqual(Object.fromEntries(Object.entries(result.output).filter(([key]) => key !== "receipt")))
    expect(fake.merges()).toEqual([])
  })

  test("a UI is not asked either: proving a merged PR writes nothing to the forge", async () => {
    const f = squashMerged("proves-ui")
    const asked: Asked = []
    const result = await call(landTool(deps(f, forge(f).run)), { pr: 17, expectHeadSha: f.head }, context(f.main, { answer: false }, asked))
    expect(result.output.ok).toBe(true)
    expect(asked).toEqual([])
  })

  test("an expectHeadSha that is not the PR head is refused, with no receipt written", async () => {
    const f = squashMerged("mismatch")
    const fake = forge(f)
    const result = await call(landTool(deps(f, fake.run)), { pr: 17, expectHeadSha: OTHER_HEAD }, context(f.main, null))
    expect(result.output.ok).toBe(false)
    expect(result.output.reason as string).toContain("expectHeadSha")
    expect(result.output.reason as string).toContain(f.head)
    expect(result.text).toStartWith("delivery_land refused: ")
    expect(receiptFiles(f)).toEqual([])
    expect(fake.merges()).toEqual([])
  })

  test("the call's abort signal stops it before anything is written", async () => {
    const f = squashMerged("aborted")
    const controller = new AbortController()
    controller.abort()
    const result = await call(landTool(deps(f, forge(f).run)), { pr: 17 }, context(f.main, null), controller.signal)
    expect(result.output.ok).toBe(false)
    expect(receiptFiles(f)).toEqual([])
  })
})

describe("merging an open PR", () => {
  test("without a UI, a merge is refused before it is issued, and nothing is written", async () => {
    const f = squashMerged("no-ui")
    const fake = forge(f, { open: true })
    const result = await call(landTool(deps(f, fake.run)), { pr: 17, expectHeadSha: f.head }, context(f.main, null))
    expect(result.output.ok).toBe(false)
    expect(result.output.reason as string).toContain("no UI")
    expect(result.output.mergeIssued).toBeUndefined()
    expect(fake.merges()).toEqual([])
    expect(receiptFiles(f)).toEqual([])
  })

  test("a user who declines the confirmation gets a refusal, and no merge is issued", async () => {
    const f = squashMerged("declined")
    const fake = forge(f, { open: true })
    const asked: Asked = []
    const result = await call(landTool(deps(f, fake.run)), { pr: 17, expectHeadSha: f.head }, context(f.main, { answer: false }, asked))
    expect(asked).toHaveLength(1)
    expect(asked[0]?.title).toContain("owner/repo#17")
    expect(asked[0]?.message).toContain(f.head)
    expect(asked[0]?.message).toContain("squash")
    expect(result.output.ok).toBe(false)
    expect(result.output.reason as string).toContain("declined")
    expect(fake.merges()).toEqual([])
    expect(receiptFiles(f)).toEqual([])
  })

  test("a user who confirms gets one merge bound to the head, then the proof and the receipt", async () => {
    const f = squashMerged("confirmed")
    const fake = forge(f, { open: true })
    const asked: Asked = []
    const result = await call(landTool(deps(f, fake.run)), { pr: 17, expectHeadSha: f.head }, context(f.main, { answer: true }, asked))
    expect(asked).toHaveLength(1)
    expect(result.output).toMatchObject({ ok: true, mergeSha: f.merge, next: ["delivery_cleanup"] })
    const merges = fake.merges()
    expect(merges).toHaveLength(1)
    expect(merges[0]).toEqual(expect.arrayContaining(["gh", "pr", "merge", "--squash", "--match-head-commit", f.head]))
    expect(existsSync(result.output.receiptPath as string)).toBe(true)
  })
})

describe("settings", () => {
  test("the delivery key's gitlabHosts reach the landing: a remote on that host is read with glab", async () => {
    const f = squashMerged("gitlab-host")
    const hosted = join(f.root, "gitlab-settings.json")
    writeFileSync(hosted, JSON.stringify({ delivery: { gitlabHosts: ["gitlab.example.org"] } }))
    const glab = forge(f, { host: "gitlab.example.org" })
    const run: CliRunner = (argv, cli) => {
      if (argv[0] !== "glab") return glab.run(argv, cli)
      glab.calls.push([...argv])
      return ok("", 1)
    }
    const result = await call(landTool(deps(f, run, hosted)), { pr: 17 }, context(f.main, null))
    expect(result.output.ok).toBe(false)
    expect(glab.calls.some((argv) => argv[0] === "glab")).toBe(true)

    const plain = forge(f, { host: "gitlab.example.org" })
    const unknown = await call(landTool(deps(f, plain.run)), { pr: 17 }, context(f.main, null))
    expect(unknown.output.ok).toBe(false)
    expect(plain.calls.some((argv) => argv[0] === "glab")).toBe(false)
  })
})
