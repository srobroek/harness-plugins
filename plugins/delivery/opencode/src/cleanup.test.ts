import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { outsideLocks, withLease } from "@srobroek/opencode-lib/lease-lock"
import { readReports, runningDirectory, runningLeaseFile, writeReport } from "@srobroek/opencode-lib/running-reports"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import {
  claimFile,
  landingFile,
  readLanding,
  removeClaim,
  writeClaim,
  writeLanding,
} from "@srobroek/opencode-lib/worktree-claims"
import {
  holdsState,
  LockTimeout,
  lockedWorktreeRead,
  lockedWorktreeRemoval,
  lockedWrite,
  lockFile,
  readHolds,
  recordHold,
  setHold,
  withDiskLock,
} from "@srobroek/opencode-lib/worktree-locks"
import { CleanupDeferred, cleanupText } from "./cleanup-tool.ts"
import { addClone, MAX_CLONES, readClones, registryFile } from "./clone-registry.ts"
import { authorizeExplicit, createPendingCleanup, partlyRemovedText } from "./pending-cleanup.ts"

// Fixture setup creates several real Git repositories and measured about 20s under full-suite load;
// keep three times that headroom instead of letting Bun's 5s default kill a child process mid-fixture.
setDefaultTimeout(60_000)

import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { devNull, hostname, tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import pkg from "../../package.json" with { type: "json" }
import { reportFromCleanup, textAfterCleanup } from "./auto-cleanup.ts"
import {
  acceptWorktree,
  branchDeleteArgs,
  CLEANUP_BOUNDS,
  type CleanupBounds,
  type CleanupDeps,
  type CleanupResult,
  cleanupDelivery as cleanupDeliveryUnwrapped,
  type DeliveryCleanupParams,
  type HostWorktrees,
  planLocalRef,
  type ReceiptCandidate,
  removalRoute,
  selectReceipt,
  targetAbsence,
} from "./cleanup.ts"
import { type CliResult, type CliRunner, runCli, SAFE_GIT_ARGS } from "./forge-adapter.ts"
import { type LandDeps, type LandParams, landPullRequest as landPullRequestUnwrapped } from "./land.ts"
import {
  buildReceipt,
  type GitRunner,
  type LandingReceipt,
  listReceipts,
  REPOSITORY_OBSERVATION_ARGS,
  readReceipt,
  receiptDirectory,
  repoKey,
  repositoryContext,
  spawnGit,
  validateReceipt,
  writeReceipt,
} from "./landing-receipt.ts"

const ROOTS: string[] = []
// Each test's scratch is removed when it ends. Removing every fixture of the file in one
// afterAll took over a minute where each unlink is endpoint-scanned, past the hook timeout.
afterEach(() => {
  const template = normalTemplateCache?.root
  for (const root of ROOTS.splice(0)) {
    if (root === template) ROOTS.push(root)
    else rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true })
})

const NOW = 1_800_000_000_000

type Fixture = {
  root: string
  main: string
  linked: string
  bare: string
  branch: string
  head: string
  merge: string
  env: NodeJS.ProcessEnv
  receipt: LandingReceipt
  receiptPath: string
}

type FixtureLayout = "normal" | "separate-git-dir" | "separate-dot-git-dir" | "submodule"

/** Every raw git argv a wrapped call issued, with the safe-option prefix still on. */
const rawGitArgv: string[][] = []

/** The argv without the safe-option prefix every checkout-bound Git command carries. */
const withoutSafeGit = (argv: readonly string[]): string[] =>
  argv[0] === "git" && SAFE_GIT_ARGS.every((part, index) => argv[index + 1] === part)
    ? ["git", ...argv.slice(1 + SAFE_GIT_ARGS.length)]
    : [...argv]

/** A runner that sees Git argv without the safe prefix, so scripted runners match on the verb. */
const stripped =
  (inner: CliRunner): CliRunner =>
  (argv, options) => {
    if (argv[0] === "git") rawGitArgv.push([...argv])
    return inner(withoutSafeGit(argv), options)
  }

/** `cleanupDelivery` with a supplied runner seeing the stripped argv; without one it runs real Git, prefix and all. */
function cleanupDelivery(params: DeliveryCleanupParams, cwd: string, deps: CleanupDeps = {}) {
  return cleanupDeliveryUnwrapped(params, cwd, deps.run === undefined ? deps : { ...deps, run: stripped(deps.run) })
}

function landPullRequest(params: LandParams, deps: LandDeps = {}) {
  return landPullRequestUnwrapped(params, deps.run === undefined ? deps : { ...deps, run: stripped(deps.run) })
}

type RecordedCall = {
  argv: string[]
  cwd: string | undefined
  timeoutMs: number
  env: Readonly<Record<string, string>> | undefined
}

type RunnerOptions = {
  pr?: Partial<{
    state: string
    baseRefName: string
    headRefName: string
    headRefOid: string
    mergeCommitOid: string | null
    mergedAt: string | null
    url: string
  }>
  /**
   * What each remote name resolves to, for a checkout whose remotes do not all
   * name the repository the receipt was written for. Absent, every name resolves
   * to the receipt's own repository; present, a name it omits is no remote at all.
   */
  remotes?: Record<string, string>
  /** Let git answer `remote get-url` itself, so a worktree-scoped rewrite is real. */
  realRemoteUrls?: boolean
  /** Verbatim stdout for `remote get-url`, for output that is not one clean record. */
  remoteStdout?: string
  beadStatus?: string
  beadRows?: Record<string, unknown>[]
  beadMergeSha?: string
  remote?: "absent" | "present" | "unknown"
  pathlessAfterRemove?: boolean
  /** Add a porcelain record for a path that is not on disk, to model a registration that outlives its directory. */
  registerAbsent?: { path: string; head: string }
  /** Fail every `git worktree list` read as a timeout. */
  worktreeListTimeout?: boolean
  registeredTargetAfterRemove?: boolean
  before?: (argv: string[], calls: string[][]) => void
  after?: (argv: string[], result: CliResult, calls: string[][]) => void
}

function scratch(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `delivery-cleanup-${name}-`)))
  ROOTS.push(root)
  return root
}

type NormalTemplate = { root: string }
let normalTemplateCache: NormalTemplate | undefined

function normalTemplate(): NormalTemplate {
  if (normalTemplateCache !== undefined) return normalTemplateCache
  const root = scratch("template")
  const bare = join(root, "remote.git")
  const main = join(root, "main")
  const linked = join(root, "linked worktree")
  // No template: its sample hooks would be copied into every fixture and never run.
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
  mkdirSync(join(main, ".beads"))
  git(main, ["worktree", "add", "-q", "-b", "template", linked])
  writeFileSync(join(linked, "feature.txt"), "feature\n")
  git(linked, ["add", "feature.txt"])
  git(linked, ["commit", "-q", "-m", "feature"])
  git(linked, ["push", "-q", "-u", "origin", "template"])
  git(main, ["merge", "-q", "--no-ff", "template", "-m", "merge feature"])
  git(main, ["push", "-q", "origin", "main"])
  git(bare, ["update-ref", "-d", "refs/heads/template"])
  normalTemplateCache = { root }
  return normalTemplateCache
}

function rewriteCopiedWorktree(templateRoot: string, root: string): void {
  const worktrees = join(root, "main", ".git", "worktrees")
  for (const name of readdirSync(worktrees)) {
    const gitdir = join(worktrees, name, "gitdir")
    if (existsSync(gitdir)) writeFileSync(gitdir, readFileSync(gitdir, "utf8").replaceAll(templateRoot, root))
  }
  const linkedGit = join(root, "linked worktree", ".git")
  writeFileSync(linkedGit, readFileSync(linkedGit, "utf8").replaceAll(templateRoot, root))
  const config = join(root, "main", ".git", "config")
  writeFileSync(config, readFileSync(config, "utf8").replaceAll(templateRoot, root))
}

beforeAll(() => {
  normalTemplate()
})

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim()
}

/**
 * Make a fixture repository hostile: `core.fsmonitor`, a clean filter selected by
 * `info/attributes`, a `filter.<x>.process` driver and `include.path` config each run a
 * script that writes a marker file, and every hook writes one too.
 */
function hostileConfig(f: Fixture): { markers: Record<string, string> } {
  const dir = scratch("hostile")
  const markers: Record<string, string> = {}
  const script = (name: string, body = "cat"): string => {
    const marker = join(dir, `${name}.ran`)
    markers[name] = marker
    const path = join(dir, `${name}.sh`)
    writeExecutable(path, `#!/bin/sh\ntouch "${marker}"\n${body}\n`)
    return path
  }
  git(f.main, ["config", "core.fsmonitor", script("fsmonitor", "printf '\\0'")])
  git(f.main, ["config", "filter.hostile.process", script("process")])
  const included = join(dir, "included.config")
  writeFileSync(included, `[filter "included"]\n\tclean = ${script("included")}\n`)
  git(f.main, ["config", "include.path", included])
  const tracked = git(f.linked, ["ls-files"]).split("\n").filter(Boolean)
  // `included` is a clean driver from `include.path`, `hostile` a long-running process driver.
  mkdirSync(join(f.main, ".git", "info"), { recursive: true })
  writeFileSync(join(f.main, ".git", "info", "attributes"), `* filter=included\n${tracked[0]} filter=hostile\n`)
  const hooks = join(dir, "hooks")
  mkdirSync(hooks)
  for (const hook of ["post-checkout", "reference-transaction", "post-index-change", "pre-auto-gc"]) {
    const marker = join(dir, `hook-${hook}.ran`)
    markers[`hook-${hook}`] = marker
    writeExecutable(join(hooks, hook), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`)
  }
  git(f.main, ["config", "core.hooksPath", hooks])
  // Make a tracked file stat-dirty so a status has to re-hash it through the clean filter.
  for (const file of tracked) writeFileSync(join(f.linked, file), readFileSync(join(f.linked, file)))
  return { markers }
}

const ranMarkers = (markers: Record<string, string>): string[] =>
  Object.entries(markers)
    .filter(([, marker]) => existsSync(marker))
    .map(([name]) => name)
    .sort()

/** One `git` start the PATH shim saw: its physical working directory, the repository selectors in its environment, and its argv. */
type GitSpawn = { cwd: string; gitDir: string; workTree: string; commonDir: string; argv: string[] }

/**
 * `path` as the kernel resolves it: the longest existing prefix through `realpath.native`
 * (symlinks first, then each `..` against the resolved parent), the missing remainder appended.
 * `node:path` and `fs.realpathSync` collapse `..` lexically, so `link/..` would wrongly name
 * the link's parent instead of the link target's parent.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    const cut = path.replace(/\/+$/, "").lastIndexOf("/")
    if (cut < 0) return path
    const parent = canonical(cut === 0 ? "/" : path.slice(0, cut))
    const leaf = path.slice(cut + 1)
    return leaf === ".." ? dirname(parent) : leaf === "." || leaf === "" ? parent : join(parent, leaf)
  }
}

/** `path` joined onto `cwd` without collapsing `..`; `canonical` resolves it. */
const rawJoin = (cwd: string, path: string): string => (path.startsWith("/") ? path : `${cwd}/${path}`)

/**
 * Every path a start could select a repository through, made canonical: the working
 * directory after each `-C`, `--git-dir` and `--work-tree` (as `=value` or a separate word),
 * and `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR`, relative ones against that directory.
 * Git reads these global options up to the subcommand, so parsing stops there.
 */
function repositorySelectors(spawn: GitSpawn): string[] {
  let cwd = spawn.cwd
  const selected = [cwd]
  const options = spawn.argv
  for (let at = 0; at < options.length; at++) {
    const word = options[at] ?? ""
    const value = (name: string): string | undefined =>
      word === name ? options[++at] : word.startsWith(`${name}=`) ? word.slice(name.length + 1) : undefined
    if (word === "-C") {
      cwd = canonical(rawJoin(cwd, options[++at] ?? ""))
      selected.push(cwd)
      continue
    }
    if (word === "-c") {
      at++
      continue
    }
    const path = value("--git-dir") ?? value("--work-tree")
    if (path !== undefined) {
      selected.push(rawJoin(cwd, path))
      continue
    }
    if (!word.startsWith("-")) break
  }
  for (const path of [spawn.gitDir, spawn.workTree, spawn.commonDir]) if (path !== "") selected.push(rawJoin(cwd, path))
  return selected.map(canonical)
}

/** The starts that selected a repository path outside `root`, compared canonically. */
const outside = (log: GitSpawn[], root: string): GitSpawn[] => {
  const allowed = canonical(root)
  return log.filter((spawn) =>
    repositorySelectors(spawn).some((path) => path !== allowed && !path.startsWith(`${allowed}/`)),
  )
}

/**
 * Put a `git` shim first on PATH that records every start. Every Git child cleanup runs
 * gets the current environment, so each one passes through it, synchronous or not. Fields
 * are separated by US (0x1f) and records by RS (0x1e), so any argv word survives.
 */
function gitSpawnLog(): { log: () => GitSpawn[]; restore: () => void } {
  const dir = scratch("git-shim")
  const logFile = join(dir, "spawns.log")
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
  writeExecutable(
    join(dir, "git"),
    `#!/bin/sh\n{ printf '%s\\037' "$(pwd -P)" "$GIT_DIR" "$GIT_WORK_TREE" "$GIT_COMMON_DIR" "$@"; printf '\\036'; } >> "${logFile}"\nexec "${real}" "$@"\n`,
  )
  const before = process.env.PATH
  process.env.PATH = `${dir}:${before ?? ""}`
  return {
    log: () =>
      (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\x1e").filter(Boolean) : []).map((record) => {
        const [cwd = "", gitDir = "", workTree = "", commonDir = "", ...argv] = record.split("\x1f")
        return { cwd, gitDir, workTree, commonDir, argv: argv.slice(0, -1) }
      }),
    restore: () => {
      process.env.PATH = before
    },
  }
}

function gitExit(cwd: string, args: string[]): number | null {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  })
  return result.exitCode
}

/**
 * A real repository whose ledger state on disk is the state its receipt claims.
 *
 * Nonstandard layouts plant a retired ledger above an active checkout ledger. That
 * is the live fail-open shape: using the common metadata directory as the checkout
 * root sees the parent verdict, while Git's top level names the active ledger.
 */
async function fixture(
  name: string,
  branch = `feat/${name}`,
  ledger: "active" | "retired" = "active",
  layout: FixtureLayout = "normal",
): Promise<Fixture> {
  const root = scratch(name)
  const bare = join(root, "remote.git")
  let main: string

  if (layout === "normal") {
    cpSync(normalTemplate().root, root, { recursive: true })
    main = join(root, "main")
  } else {
    mkdirSync(bare)
    git(bare, ["init", "--bare", "-q"])
    if (layout === "submodule") {
      const source = join(root, "source")
      const superproject = join(root, "superproject")
      main = join(superproject, "sub")
      mkdirSync(source)
      git(source, ["init", "-q", "-b", "main"])
      git(source, ["config", "user.email", "delivery@example.test"])
      git(source, ["config", "user.name", "Delivery Test"])
      writeFileSync(join(source, "source.txt"), "source\n")
      git(source, ["add", "source.txt"])
      git(source, ["commit", "-q", "-m", "source"])
      mkdirSync(superproject)
      git(superproject, ["init", "-q", "-b", "main"])
      git(superproject, ["config", "user.email", "delivery@example.test"])
      git(superproject, ["config", "user.name", "Delivery Test"])
      writeFileSync(join(superproject, "super.txt"), "super\n")
      git(superproject, ["add", "super.txt"])
      git(superproject, ["commit", "-q", "-m", "super"])
      git(superproject, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub"])
      mkdirSync(join(superproject, ".beads"))
      writeFileSync(join(superproject, ".beads", "RETIRED"), "retired\n")
    } else {
      main = join(root, "main")
      mkdirSync(main)
      const common = layout === "separate-dot-git-dir" ? join(root, "store", ".git") : join(root, "store.git")
      if (layout === "separate-git-dir" || layout === "separate-dot-git-dir") {
        mkdirSync(dirname(common), { recursive: true })
        git(main, ["init", "-q", "-b", "main", `--separate-git-dir=${common}`])
        mkdirSync(join(dirname(common), ".beads"))
        writeFileSync(join(dirname(common), ".beads", "RETIRED"), "retired\n")
      } else {
        git(main, ["init", "-q", "-b", "main"])
      }
    }
    git(main, ["config", "user.email", "delivery@example.test"])
    git(main, ["config", "user.name", "Delivery Test"])
    writeFileSync(join(main, "base.txt"), "base\n")
    git(main, ["add", "base.txt"])
    git(main, ["commit", "-q", "-m", "base"])
    if (layout === "submodule") git(main, ["remote", "set-url", "origin", bare])
    else git(main, ["remote", "add", "origin", bare])
    git(main, ["push", "-q", "-u", "origin", "main"])
    mkdirSync(join(main, ".beads"))
  }
  if (ledger === "retired") writeFileSync(join(main, ".beads", "RETIRED"), "retired\n")

  const linked = join(root, "linked worktree")
  let head: string
  let merge: string
  if (layout === "normal") {
    rewriteCopiedWorktree(normalTemplate().root, root)
    git(linked, ["branch", "-m", branch])
    git(linked, ["config", `branch.${branch}.remote`, "origin"])
    git(linked, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`])
    if (branch !== "template") {
      git(main, ["update-ref", `refs/remotes/origin/${branch}`, "refs/remotes/origin/template"])
      git(main, ["update-ref", "-d", "refs/remotes/origin/template"])
    }
    head = git(linked, ["rev-parse", "HEAD"])
    merge = git(main, ["rev-parse", "HEAD"])
  } else {
    git(main, ["worktree", "add", "-q", "-b", branch, linked])
    writeFileSync(join(linked, "feature.txt"), "feature\n")
    git(linked, ["add", "feature.txt"])
    git(linked, ["commit", "-q", "-m", "feature"])
    git(linked, ["push", "-q", "-u", "origin", branch])
    head = git(linked, ["rev-parse", "HEAD"])
    git(main, ["merge", "-q", "--no-ff", branch, "-m", "merge feature"])
    merge = git(main, ["rev-parse", "HEAD"])
    git(main, ["push", "-q", "origin", "main"])
    git(bare, ["update-ref", "-d", `refs/heads/${branch}`])
  }

  const env = { ...process.env, DELIVERY_RECEIPTS_DIR: join(root, "agent", "receipts") }
  const key = await repoKey(main)
  if (key === null) throw new Error("fixture repo has no key")
  const receipt = buildReceipt({
    now: NOW,
    emitter: { plugin: pkg.name, version: pkg.version, tool: "delivery_land" },
    repo: {
      key,
      canonicalRoot: realpathSync(main),
      remote: "origin",
      forge: "github",
      nameWithOwner: "owner/repo",
    },
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
    branch: {
      name: branch,
      deletedRemote: true,
      remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z",
      autoDeleteSetting: "on",
    },
    worktree: { path: linked, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
    beads: { ids: ["delivery-17"], ledgerActive: ledger === "active" },
    proof: {
      method: "gh pr view",
      observedAt: "2027-01-15T08:00:00.000Z",
      evidence: { state: "MERGED" },
    },
    outcome: "landed",
  })
  receipt.forwardProof = { kept: true }
  const receiptPath = writeReceipt(receipt, receiptDirectory(env, key))
  return { root, main, linked, bare, branch, head, merge, env, receipt, receiptPath }
}

function success(stdout = "", exitCode = 0): CliResult {
  return { ok: true, exitCode, stdout, stderr: "" }
}

function githubPayload(f: Fixture, over: RunnerOptions["pr"] = {}): string {
  const state = over.state ?? "MERGED"
  const mergeCommitOid = over.mergeCommitOid === undefined ? f.receipt.pr.mergeCommitOid : over.mergeCommitOid
  return JSON.stringify({
    number: f.receipt.pr.number,
    url: over.url ?? f.receipt.pr.url,
    state,
    baseRefName: over.baseRefName ?? f.receipt.pr.baseRefName,
    headRefName: over.headRefName ?? f.receipt.pr.headRefName,
    headRefOid: over.headRefOid ?? f.receipt.pr.headRefOid,
    mergeCommit: mergeCommitOid === null ? null : { oid: mergeCommitOid },
    mergedAt: over.mergedAt === undefined ? f.receipt.pr.mergedAt : over.mergedAt,
  })
}

function gitlabPayload(f: Fixture, over: RunnerOptions["pr"] = {}): string {
  return JSON.stringify({
    iid: f.receipt.pr.number,
    web_url: over.url ?? f.receipt.pr.url,
    state: over.state ?? f.receipt.pr.state,
    target_branch: over.baseRefName ?? f.receipt.pr.baseRefName,
    source_branch: over.headRefName ?? f.receipt.pr.headRefName,
    sha: over.headRefOid ?? f.receipt.pr.headRefOid,
    merge_commit_sha: over.mergeCommitOid === undefined ? f.receipt.pr.mergeCommitOid : over.mergeCommitOid,
    merged_at: over.mergedAt === undefined ? f.receipt.pr.mergedAt : over.mergedAt,
  })
}

/**
 * The URL a remote name resolves to, which is the one Git read this runner scripts.
 *
 * The fixture's real `origin` is a local bare path, and no forge adapter verifies
 * a path as a host. The remote NAME is what a receipt records; the URL is what
 * classification and every forge query are bound to, so it is scripted here, and
 * `remotes` is how a contributor fork on `origin` is expressed.
 *
 * `realRemoteUrls` hands the read back to git, for the one case whose whole point is
 * that git resolves a URL differently per worktree.
 */
function remoteUrl(f: Fixture, remote: string, options: RunnerOptions): string | null {
  if (options.remotes !== undefined) return options.remotes[remote] ?? null
  const { forge, nameWithOwner } = f.receipt.repo
  const host = forge === "gitlab" ? "gitlab.com" : "github.com"
  return `https://${host}/${nameWithOwner}.git`
}

/**
 * These fixtures run real git, and a loaded machine stalls even a ref read past its
 * production bound; the bounds test below checks the production values.
 */
const HEAVY_FIXTURE_BOUNDS: Partial<CleanupBounds> = { refReadMs: 60_000 }

function runner(
  f: Fixture,
  options: RunnerOptions = {},
): { run: CliRunner; calls: string[][]; details: RecordedCall[] } {
  const calls: string[][] = []
  const details: RecordedCall[] = []
  const run: CliRunner = async (argv, commandOptions) => {
    calls.push([...argv])
    details.push({
      argv: [...argv],
      cwd: commandOptions.cwd,
      timeoutMs: commandOptions.timeoutMs,
      env: commandOptions.env,
    })
    options.before?.(argv, calls)
    let result: CliResult
    if (argv[0] === "gh" && argv[2] === "graphql" && argv.some((part) => part.includes("ref(qualifiedName"))) {
      // The GitHub absence read answers what `ls-remote` answers below, through the API.
      const remote = options.remote ?? "absent"
      const ref = { prefix: "refs/heads/", name: f.branch, target: { __typename: "Commit", oid: f.head } }
      const repository = { nameWithOwner: f.receipt.repo.nameWithOwner, ref: remote === "present" ? ref : null }
      result =
        remote === "unknown"
          ? { ok: false, exitCode: null, stdout: "", stderr: "", error: "timeout" }
          : success(JSON.stringify({ data: { repository } }))
    } else if (argv[0] === "gh") {
      result = success(githubPayload(f, options.pr))
    } else if (argv[0] === "glab") {
      result = success(gitlabPayload(f, options.pr))
    } else if (argv[0] === "bd") {
      result = success(
        JSON.stringify({
          schema_version: 1,
          data: options.beadRows ?? [
            {
              id: "delivery-17",
              status: options.beadStatus ?? "closed",
              metadata: { merge_sha: options.beadMergeSha ?? f.merge },
            },
          ],
        }),
      )
    } else if (argv[0] === "git" && argv[1] === "remote" && argv[2] === "get-url" && options.realRemoteUrls !== true) {
      if (options.remoteStdout !== undefined) {
        result = success(options.remoteStdout)
      } else {
        const url = remoteUrl(f, argv[3] ?? "", options)
        result =
          url === null
            ? { ok: true, exitCode: 1, stdout: "", stderr: `error: No such remote '${argv[3]}'\n` }
            : success(`${url}\n`)
      }
    } else if (argv[0] === "git" && argv.includes("ls-remote")) {
      const remote = options.remote ?? "absent"
      if (remote === "absent") result = success("", 2)
      else if (remote === "present") result = success(`${f.head}\trefs/heads/${f.branch}\n`)
      else result = { ok: false, exitCode: null, stdout: "", stderr: "", error: "timeout" }
    } else {
      result = await runCli(argv, commandOptions)
    }
    if (
      options.pathlessAfterRemove &&
      argv[0] === "git" &&
      argv[1] === "worktree" &&
      argv[2] === "list" &&
      calls.some((call) => call[0] === "git" && call[1] === "worktree" && call[2] === "remove")
    ) {
      result = success(`${result.stdout.trimEnd()}\n\nworktree \nHEAD ${f.head}\nbranch refs/heads/${f.branch}\n\n`)
    }
    if (
      options.registeredTargetAfterRemove &&
      argv[0] === "git" &&
      argv[1] === "worktree" &&
      argv[2] === "list" &&
      calls.some((call) => call[0] === "git" && call[1] === "worktree" && call[2] === "remove")
    ) {
      result = success(
        `${result.stdout.trimEnd()}\n\nworktree ${f.linked}\nHEAD ${f.head}\nbranch refs/heads/${f.branch}\n\n`,
      )
    }
    if (options.worktreeListTimeout && argv[0] === "git" && argv[1] === "worktree" && argv[2] === "list") {
      result = { ok: false, exitCode: null, stdout: "", stderr: "", error: "timeout" }
    }
    if (options.registerAbsent && argv[0] === "git" && argv[1] === "worktree" && argv[2] === "list") {
      result = success(
        `${result.stdout.trimEnd()}\n\nworktree ${options.registerAbsent.path}\nHEAD ${options.registerAbsent.head}\ndetached\n\n`,
      )
    }
    options.after?.(argv, result, calls)
    return result
  }
  return { run, calls, details }
}

async function invoke(
  f: Fixture,
  params: DeliveryCleanupParams = { receipt: f.receiptPath },
  options: RunnerOptions = {},
  extra: Partial<CleanupDeps> = {},
): Promise<{
  result: CleanupResult
  calls: string[][]
  details: RecordedCall[]
}> {
  const scripted = runner(f, options)
  const result = await cleanupDelivery(params, f.main, {
    run: scripted.run,
    now: () => NOW + 10,
    env: f.env,
    bounds: HEAVY_FIXTURE_BOUNDS,
    ...extra,
  })
  return { result, calls: scripted.calls, details: scripted.details }
}

function refusal(result: CleanupResult): string {
  if (result.ok) throw new Error(`expected refusal, got ${result.receipt.receiptId}`)
  return result.reason
}

/** The success of a call whose removal ran, whatever it could not finish afterwards. */
function removal(result: CleanupResult): Extract<CleanupResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected the removal to be reported, got a refusal: ${result.reason}`)
  return result
}

function commandCalls(calls: string[][], verb: string): string[][] {
  return calls.filter((argv) => argv[0] === verb)
}

function mutationCalls(calls: string[][]): string[][] {
  return calls.filter(
    (argv) =>
      (argv[0] === "git" &&
        ((argv[1] === "worktree" && argv[2] === "remove") || (argv[1] === "branch" && argv[2] === "-d"))) ||
      (argv[0] === "bd" && !["show", "list"].includes(argv[1] ?? "")),
  )
}

describe("delivery_cleanup irreversible boundary", () => {
  test("removes one listed worktree then its local branch and records four independent absence verdicts", async () => {
    const f = await fixture("happy")
    const listedPath = realpathSync(f.linked)
    const { result, calls } = await invoke(f, {
      receipt: f.receiptPath,
      pr: 17,
      branch: f.branch,
      worktree: f.linked,
      remote: "origin",
    })
    expect(calls.slice(0, 3)).toEqual([
      ["git", "worktree", "list", "--porcelain"],
      ["git", "remote", "get-url", "origin"],
      [
        "gh",
        "pr",
        "view",
        "17",
        "--repo",
        "github.com/owner/repo",
        "--json",
        "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt",
      ],
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(existsSync(f.linked)).toBe(false)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(1)
    const destructive = mutationCalls(calls)
    expect(destructive).toEqual([
      ["git", "worktree", "remove", listedPath],
      ["git", "branch", "-d", "--", f.branch],
    ])
    expect(calls.flat()).not.toContain("--force")
    expect(calls.flat()).not.toContain("-D")
    expect(commandCalls(calls, "bd").every((argv) => argv[1] === "show")).toBe(true)

    const validation = validateReceipt(result.receipt)
    expect(validation.ok).toBe(true)
    expect(result.receipt.outcome).toBe("cleaned")
    expect(result.receipt.supersedes).toBe(f.receipt.receiptId)
    expect(result.receipt.forwardProof).toEqual({ kept: true })
    expect(result.receipt.worktree).toEqual({
      path: f.linked,
      removed: true,
      localRefDeleted: true,
      absenceVerifiedAt: new Date(NOW + 10).toISOString(),
    })
    expect(result.receipt.branch.deletedRemote).toBe(true)
    expect(result.receipt.proof.evidence).toEqual({
      worktreeRegistration: "absent",
      worktreePath: "absent",
      localRef: "absent",
      remoteBranch: "absent",
      pushed: "upstream",
    })
    expect(readReceipt(result.path)).toEqual({ ok: true, receipt: result.receipt })
    expect(listReceipts(receiptDirectory(f.env, f.receipt.repo.key))).toHaveLength(2)
  }, 60_000)

  test("from another repository, a pr without a worktree or receipt still finds no receipt", async () => {
    const f = await fixture("cross-bare-pr")
    const session = await fixture("cross-bare-pr-session")
    const scripted = runner(f, {})
    const result = await cleanupDelivery({ pr: 17 }, session.main, {
      run: scripted.run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain("receipt")
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("a retired ledger, agreed by the receipt and the canonical root, cleans up with no bd command", async () => {
    const f = await fixture("inactive-ledger", "feat/inactive-ledger", "retired")

    const { result, calls } = await invoke(f)

    expect(result.ok).toBe(true)
    expect(commandCalls(calls, "bd")).toEqual([])
    if (!result.ok) return
    expect(result.receipt.beads.ledgerActive).toBe(false)
    expect(existsSync(f.linked)).toBe(false)
  })

  test("a ledger-free receipt for another repository is denied before local mutation", async () => {
    const f = await fixture("cross-repo-receipt", "feat/cross-repo-receipt", "retired")
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      continues: f.receipt,
      repo: { ...f.receipt.repo, nameWithOwner: "attacker/elsewhere" },
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))

    const { result, calls } = await invoke(f, { receipt: path })

    expect(refusal(result)).toContain(
      'repo.nameWithOwner: observed "owner/repo", expected receipt value "attacker/elsewhere"',
    )
    expect(calls).toEqual([
      ["git", "worktree", "list", "--porcelain"],
      ["git", "remote", "get-url", "origin"],
    ])
    expect(commandCalls(calls, "bd")).toEqual([])
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("a receipt remote that cannot name one verified repository fails closed", async () => {
    const f = await fixture("remote-identity", "feat/remote-identity", "retired")
    // A leading dash is an option to `git remote get-url`; whitespace padding is a
    // receipt that does not say which remote. Neither is trimmed into something
    // usable, and neither reaches a command that names a remote: the one call made
    // first is the target-identity listing the observation is resolved inside.
    //
    // The four line terminators are here because a receipt is a file: a generator
    // that wrote `origin\n` produced a value that must refuse, and U+2028/U+2029 are
    // line terminators to a JavaScript regex while surviving a JSON round trip
    // untouched.
    for (const remote of [
      "--upload-pack=touch",
      " origin",
      "origin\n",
      "origin\r",
      "origin\r\n",
      "origin\u2028",
      "origin\u2029",
      "or igin",
    ]) {
      const receipt = buildReceipt({
        ...f.receipt,
        now: NOW + 1,
        continues: f.receipt,
        repo: { ...f.receipt.repo, remote },
      })
      const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
      const { result, calls } = await invoke(f, { receipt: path })
      expect(refusal(result)).toContain(`repo.remote: observed ${JSON.stringify(remote)}, expected a git remote name`)
      expect(calls).toEqual([["git", "worktree", "list", "--porcelain"]])
      rmSync(path)
    }

    for (const [field, remotes] of [
      ["repo.remote", {}],
      ["repo.forge", { origin: "https://evil.example/owner/repo.git" }],
      ["repo.forge", { origin: "https://gitlab.com/owner/repo.git" }],
      ["repo.nameWithOwner", { origin: "https://github.com/" }],
      ["repo.nameWithOwner", { origin: "https://github.com/attacker/elsewhere.git" }],
    ] as const) {
      const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { remotes })
      expect(refusal(result)).toContain(field)
      expect(calls).toEqual([
        ["git", "worktree", "list", "--porcelain"],
        ["git", "remote", "get-url", "origin"],
      ])
    }
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  /**
   * `URL` deletes embedded tabs and newlines before parsing, so each of these reads as
   * an ordinary GitHub remote once the output is trimmed. Trimming would let the
   * identity comparison pass and authorise a removal whose absence probe could then
   * only ever answer "unknown" — a worktree deleted on an observation of nothing. The
   * output is read as exactly one record instead, and refusal precedes the forge read.
   *
   * The refusal also says nothing about the bytes. Output no parser accepted cannot be
   * redacted — a redactor can only find a secret in a spelling it understands — so the
   * cases below carry userinfo and a token query, and the refusal text must hold
   * neither those tokens nor the URL that framed them.
   */
  test("git remote get-url output that is not exactly one record refuses before the forge read", async () => {
    const f = await fixture("remote-record", "feat/remote-record", "retired")
    for (const remoteStdout of [
      "https://git\thub.com/owner/repo.git\n",
      "https://github.com/owner/repo.git\n@evil.example/x\n",
      "https://github.com/owner/repo.git\nhttps://evil.example/owner/repo.git\n",
      "https://github.com/owner/repo.git\r\n\r\n",
      " https://github.com/owner/repo.git\n",
      "https://github.com/owner/repo.git \n",
      "\n",
      "",
      "https://test-user:ghp_secrettoken@git\thub.com/owner/repo.git\n",
      "https://github.com/owner/repo.git?token=ghp_secrettoken\nhttps://evil.example/x\n",
      " ssh://git:ghp_secrettoken@github.com/owner/repo.git\n",
    ]) {
      const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { remoteStdout })
      const reason = refusal(result)
      expect(reason).toContain('repo.remote: observed "malformed Git remote output"')
      expect(reason).toContain("exactly one URL record")
      // Neither the secret nor the spelling that carried it.
      expect(reason).not.toContain("ghp_secrettoken")
      expect(reason).not.toContain("github.com/owner/repo")
      expect(reason).not.toContain("evil.example")
      expect(calls).toEqual([
        ["git", "worktree", "list", "--porcelain"],
        ["git", "remote", "get-url", "origin"],
      ])
      expect(mutationCalls(calls)).toEqual([])
    }
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("GitLab queries the receipt's project on the canonical host", async () => {
    const f = await fixture("gitlab-local-repo", "feat/gitlab-local-repo", "retired")
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      continues: f.receipt,
      repo: { ...f.receipt.repo, forge: "gitlab", nameWithOwner: "group/project" },
      pr: {
        ...f.receipt.pr,
        url: "https://gitlab.com/group/project/-/merge_requests/17",
        state: "merged",
      },
      proof: { ...f.receipt.proof, method: "glab mr view" },
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
    f.receipt = receipt
    f.receiptPath = path

    const { result, calls, details } = await invoke(f)

    expect(result.ok).toBe(true)
    expect(calls.slice(0, 3)).toEqual([
      ["git", "worktree", "list", "--porcelain"],
      ["git", "remote", "get-url", "origin"],
      ["glab", "mr", "view", "17", "--repo", "gitlab.com/group/project", "--output", "json"],
    ])
    const mr = details.find((call) => call.argv[0] === "glab")
    expect(mr?.env?.GITLAB_HOST).toBe("gitlab.com")
    expect(mr?.env?.GITLAB_API_HOST).toBe("gitlab.com")
    expect(mr?.cwd).toBeUndefined()
  }, 60_000)

  /**
   * An operator-named GitLab host is GitLab for every spelling Git may contact it by: the
   * web host, its `ssh.` transport host and the scp form. Cleanup classifies it through the
   * `forgeTarget` landing uses and addresses the API at the canonical host, never the SSH
   * one. A host the operator did not name stays `unknown` and refuses before any forge read.
   */
  test("a configured GitLab host resolves as gitlab in every spelling; an unlisted host refuses", async () => {
    const gitlabHosts = ["gitlab.example.org"]
    const spellings = [
      "git@ssh.gitlab.example.org:group/project.git",
      "ssh://git@ssh.gitlab.example.org/group/project.git",
      "https://gitlab.example.org/group/project.git",
    ]
    for (const [i, remote] of spellings.entries()) {
      const f = await fixture(`configured-host-${i}`, `feat/configured-host-${i}`, "retired")
      const receipt = buildReceipt({
        ...f.receipt,
        now: NOW + 1,
        continues: f.receipt,
        repo: { ...f.receipt.repo, forge: "gitlab", nameWithOwner: "group/project" },
        pr: { ...f.receipt.pr, url: "https://gitlab.example.org/group/project/-/merge_requests/17", state: "merged" },
        proof: { ...f.receipt.proof, method: "glab mr view" },
      })
      f.receipt = receipt
      f.receiptPath = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
      const { result, details } = await invoke(f, { receipt: f.receiptPath }, { remotes: { origin: remote } }, { gitlabHosts })
      expect(removal(result).receipt.repo.forge).toBe("gitlab")
      const mr = details.find((call) => call.argv[0] === "glab")
      expect(mr?.argv).toEqual(["glab", "mr", "view", "17", "--repo", "gitlab.example.org/group/project", "--output", "json"])
      expect(mr?.env?.GITLAB_HOST).toBe("gitlab.example.org")
      expect(mr?.env?.GITLAB_API_HOST).toBe("gitlab.example.org")
    }
    const f = await fixture("configured-host-unlisted", "feat/configured-host-unlisted", "retired")
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      { remotes: { origin: "git@ssh.gitlab.example.net:group/project.git" } },
      { gitlabHosts },
    )
    expect(refusal(result)).toContain("repo.forge: observed")
    expect(refusal(result)).toContain('expected "github" or "gitlab"')
    expect(calls).toEqual([
      ["git", "worktree", "list", "--porcelain"],
      ["git", "remote", "get-url", "origin"],
    ])
  }, 120_000)

  /**
   * The finding this pins: a checkout whose `origin` is a contributor fork and
   * whose `upstream` is the remote the landing was run with. `gh repo view` and
   * `glab repo view` answer for `origin`, so the observation came out of the fork
   * and a valid upstream receipt was refused, blocking cleanup after a landing
   * that had already succeeded — while the receipt named the right remote all
   * along.
   */
  for (const forge of ["github", "gitlab"] as const) {
    test(`${forge}: the observation follows the receipt's remote while origin is a fork`, async () => {
      const f = await fixture(`fork-origin-${forge}`, `feat/fork-origin-${forge}`, "retired")
      git(f.main, ["remote", "add", "upstream", f.bare])
      const nameWithOwner = forge === "github" ? "owner/repo" : "group/project"
      const host = forge === "github" ? "github.com" : "gitlab.com"
      const receipt = buildReceipt({
        ...f.receipt,
        now: NOW + 1,
        continues: f.receipt,
        repo: { ...f.receipt.repo, remote: "upstream", forge, nameWithOwner },
        pr:
          forge === "github"
            ? f.receipt.pr
            : {
                ...f.receipt.pr,
                url: `https://gitlab.com/${nameWithOwner}/-/merge_requests/17`,
                state: "merged",
              },
        proof: { ...f.receipt.proof, method: forge === "github" ? "gh pr view" : "glab mr view" },
      })
      f.receiptPath = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
      f.receipt = receipt

      const { result, calls, details } = await invoke(
        f,
        { receipt: f.receiptPath },
        {
          remotes: {
            origin: `https://${host}/contributor/fork.git`,
            upstream: `https://${host}/${nameWithOwner}.git`,
          },
        },
      )

      expect(result.ok).toBe(true)
      expect(calls.slice(0, 3)).toEqual([
        ["git", "worktree", "list", "--porcelain"],
        ["git", "remote", "get-url", "upstream"],
        forge === "github"
          ? [
              "gh",
              "pr",
              "view",
              "17",
              "--repo",
              "github.com/owner/repo",
              "--json",
              "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt",
            ]
          : ["glab", "mr", "view", "17", "--repo", "gitlab.com/group/project", "--output", "json"],
      ])
      expect(calls.filter((argv) => argv[1] === "remote" && argv[2] === "get-url")).toEqual([
        ["git", "remote", "get-url", "upstream"],
      ])
      expect(calls.flat().join(" ")).not.toContain("contributor/fork")
      expect(calls.flat()).not.toContain("origin")
      // The absence probe is bound to the resolved repository, not the remote name: after
      // removal a name would be re-resolved by a surviving worktree's configuration.
      // GitHub reads it through the API for the bound owner/name; GitLab's Git probe takes
      // the URL in the child's environment, so argv names only the alias.
      if (forge === "github") {
        expect(details.filter((call) => call.argv.includes("ls-remote"))).toEqual([])
        const absence = details.find((call) => call.argv.includes(`ref=refs/heads/${f.branch}`))
        expect(absence?.argv).toEqual(expect.arrayContaining(["--hostname", "github.com", "owner=owner", "name=repo"]))
      } else {
        const absence = details.find((call) => call.argv.includes("ls-remote"))
        expect(absence?.argv.at(-2)).toBe("delivery-absence-probe")
        expect(absence?.argv).not.toContain("upstream")
        expect(absence?.env?.GIT_CONFIG_VALUE_0).toBe(`https://${host}/${nameWithOwner}.git`)
      }
      expect(existsSync(f.linked)).toBe(false)
      if (!result.ok) return
      expect(result.receipt.repo.remote).toBe("upstream")
      expect(result.receipt.proof.method).toBe(forge === "github" ? "gh pr view" : "glab mr view")
    }, 60_000)
  }

  /**
   * A remote NAME resolves per repository; a remote URL resolves per worktree.
   *
   * `extensions.worktreeConfig` scopes `url.<other>.insteadOf` to a single worktree,
   * and `git remote get-url` expands those rewrites, so the landed worktree and the
   * directory cleanup must run from print different URLs for the same name. Nothing
   * here is scripted: git configures the rewrite and git answers both reads, and the
   * two `expect`s before the call record the premise as an observation rather than an
   * assumption. Resolved from the invocation worktree this receipt is unusable —
   * `origin` is the fork there — and the landed worktree it names becomes impossible
   * to clean.
   */
  test("the remote URL is resolved in the landed worktree, where a worktree-scoped rewrite applies", async () => {
    const f = await fixture("worktree-config", "feat/worktree-config", "retired")
    const fork = "https://github.com/contributor/fork.git"
    const upstream = "https://github.com/owner/repo.git"
    git(f.main, ["config", "extensions.worktreeConfig", "true"])
    git(f.main, ["remote", "set-url", "origin", fork])
    git(f.linked, ["config", "--worktree", `url.${upstream}.insteadOf`, fork])
    // The surviving worktree rewrites the other way: any probe that loaded this
    // repository's configuration would be sent from upstream to the fork. It is the
    // worktree cleanup runs from, and the only one left once the target is removed.
    git(f.main, ["config", "--worktree", `url.${fork}.insteadOf`, upstream])
    expect(git(f.linked, ["remote", "get-url", "origin"])).toBe(upstream)
    expect(git(f.main, ["remote", "get-url", "origin"])).toBe(fork)
    // Captured before the call, because a successful cleanup removes this directory
    // and `realpathSync` then throws on a path that no longer exists.
    const landedPath = realpathSync(f.linked)

    const { result, calls, details } = await invoke(f, { receipt: f.receiptPath }, { realRemoteUrls: true })

    expect(result.ok).toBe(true)
    const identityRead = details.find((call) => call.argv[1] === "remote" && call.argv[2] === "get-url")
    expect(identityRead?.argv).toEqual(["git", "remote", "get-url", "origin"])
    // The directory is what makes the answer upstream's rather than the fork's.
    expect(identityRead?.cwd).toBe(landedPath)
    expect(calls.slice(0, 3)).toEqual([
      ["git", "worktree", "list", "--porcelain"],
      ["git", "remote", "get-url", "origin"],
      [
        "gh",
        "pr",
        "view",
        "17",
        "--repo",
        "github.com/owner/repo",
        "--json",
        "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt",
      ],
    ])
    expect(calls.flat().join(" ")).not.toContain("contributor/fork")
    // The post-removal absence read is the second place a remote name would be
    // re-resolved, and by then the worktree that rewrites it is gone. On GitHub it is a
    // forge API read bound to the owner/name the target resolved (upstream's, never the
    // fork's), and no Git process contacts a remote at all, so no surviving worktree's
    // rewrite can reach it. The URL-bound Git probe is GitLab's, shown in the fork test.
    expect(details.filter((call) => call.argv.includes("ls-remote"))).toEqual([])
    const probe = details.find((call) => call.argv.includes(`ref=refs/heads/${f.branch}`))
    expect(probe?.argv.slice(0, 5)).toEqual(["gh", "api", "graphql", "--hostname", "github.com"])
    expect(probe?.argv).toEqual(expect.arrayContaining(["owner=owner", "name=repo"]))
    expect(probe?.env?.GH_HOST).toBe("github.com")
    expect(existsSync(f.linked)).toBe(false)
  }, 60_000)

  test("cleanup strips every ambient forge and Git selector from the identity and pull-request reads", async () => {
    const f = await fixture("ambient-redirectors", "feat/ambient-redirectors", "retired")
    Object.assign(f.env, {
      GH_REPO: "attacker/elsewhere",
      GH_HOST: "evil.example",
      GITLAB_HOST: "evil.example",
      GL_HOST: "evil.example",
      GITLAB_URI: "https://evil.example",
      GITLAB_API_HOST: "api.evil.example",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_CONFIG_GLOBAL: "/elsewhere/config",
      GH_TOKEN: "keep-gh",
      GITLAB_TOKEN: "keep-gitlab",
      GL_TOKEN: "keep-gl",
    })

    const { result, details } = await invoke(f)

    expect(result.ok).toBe(true)
    const forgeCalls = details.filter((call) => call.argv[0] === "gh")
    // The pull-request read and the remote-branch absence read through the API.
    expect(forgeCalls.map((call) => call.argv.slice(0, 3))).toEqual([
      ["gh", "pr", "view"],
      ["gh", "api", "graphql"],
    ])
    for (const call of forgeCalls) {
      for (const key of ["GH_REPO", "GITLAB_HOST", "GL_HOST", "GITLAB_URI", "GITLAB_API_HOST"]) {
        expect(call.env?.[key]).toBeUndefined()
      }
      // Not merely stripped: replaced by the host `forgeTarget` verified, so the
      // CLI cannot fall back to a configured default host either.
      expect(call.env?.GH_HOST).toBe("github.com")
      expect(call.env?.GH_TOKEN).toBe("keep-gh")
      expect(call.env?.GITLAB_TOKEN).toBe("keep-gitlab")
      expect(call.env?.GL_TOKEN).toBe("keep-gl")
    }
    const identityRead = details.find((call) => call.argv[1] === "remote" && call.argv[2] === "get-url")
    expect(identityRead?.argv).toEqual(["git", "remote", "get-url", "origin"])
    // The ambient selectors are gone; the only GIT_DIR / GIT_WORK_TREE are the ones the
    // call pinned from the verified checkout, never the inherited "/elsewhere" values.
    expect(identityRead?.env?.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(identityRead?.env?.GIT_WORK_TREE).toBe(f.linked)
    expect(identityRead?.env?.GIT_DIR?.startsWith(join(f.main, ".git", "worktrees"))).toBe(true)
    expect(identityRead?.env?.GIT_COMMON_DIR).toBe(join(f.main, ".git"))
  }, 60_000)

  test("a valid receipt extension named ok cannot collide with cleanup's private resolution tag", async () => {
    const f = await fixture("receipt-ok-extension")
    rmSync(f.receiptPath)
    f.receipt.ok = false
    const path = writeReceipt(f.receipt, receiptDirectory(f.env, f.receipt.repo.key))

    const { result } = await invoke(f, { receipt: path })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.receipt.ok).toBe(false)
    expect(result.receipt.outcome).toBe("cleaned")
    expect(existsSync(f.linked)).toBe(false)
  })

  test("a second call selects the cleaned continuation, reports it already cleaned, and mutates nothing", async () => {
    const f = await fixture("second")
    const first = await invoke(f)
    expect(first.result.ok).toBe(true)
    const second = await invoke(f, {})
    if (!second.result.ok) throw new Error(second.result.reason)
    expect(second.result.alreadyCleaned).toBe(true)
    expect(second.result.receipt.outcome).toBe("cleaned")
    expect(mutationCalls(second.calls)).toEqual([])
  })

  test("an unknown remote observation never becomes verified absence, while local cleanup stays truthful", async () => {
    const f = await fixture("remote-unknown")
    const { result } = await invoke(f, { receipt: f.receiptPath }, { remote: "unknown" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.remoteBranchAbsence).toBe("unknown")
    expect(result.receipt.branch.deletedRemote).toBe(false)
    expect(result.receipt.branch.remoteAbsenceVerifiedAt).toBeNull()
    expect(result.receipt.worktree.removed).toBe(true)
    expect(result.receipt.worktree.localRefDeleted).toBe(true)
  })

  test("an explicit receipt outside the canonical repository receipt directory is refused before observation", async () => {
    const f = await fixture("outside-receipt")
    const outside = join(scratch("explicit-tmp"), basename(f.receiptPath))
    copyFileSync(f.receiptPath, outside)
    const { result, calls } = await invoke(f, { receipt: outside })
    expect(refusal(result)).toContain(`receipt.path: observed "${outside}", expected a direct entry under`)
    expect(calls).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("explicit and implicit receipt selection refuse a symlinked receipt parent", async () => {
    const f = await fixture("receipt-parent-symlink")
    const directory = receiptDirectory(f.env, f.receipt.repo.key)
    const realDirectory = `${directory}-real`
    renameSync(directory, realDirectory)
    symlinkSync(realDirectory, directory, "dir")

    const explicit = await invoke(f, { receipt: f.receiptPath })
    expect(refusal(explicit.result)).toContain(`receipt.directory: observed "${directory} (symlink)"`)
    expect(explicit.calls).toEqual([])
    const implicit = await invoke(f, { pr: f.receipt.pr.number })
    expect(refusal(implicit.result)).toContain(`receipt.directory: observed "${directory} (symlink)"`)
    expect(implicit.calls).toEqual([])
  })

  type HomeFixture = Fixture & { aliasPath: string }

  /**
   * The fixture reached through a symlinked home directory, as on a host whose `/home/<user>`
   * links to `/local/home/<user>`: `home` aliases `f.root`, the receipts directory is named
   * through it, and `aliasPath` names the receipt that way.
   */
  function throughSymlinkedHome(f: Fixture): HomeFixture {
    const home = join(scratch("symlinked-home"), "home")
    symlinkSync(f.root, home, "dir")
    const env = { ...f.env, DELIVERY_RECEIPTS_DIR: join(home, "agent", "receipts") }
    const aliasPath = join(home, "agent", "receipts", f.receipt.repo.key, basename(f.receiptPath))
    return { ...f, env, aliasPath }
  }

  test("a symlinked ancestor above the receipt root is accepted by explicit and implicit selection", async () => {
    const selections: [string, (f: HomeFixture) => DeliveryCleanupParams][] = [
      ["alias", (f) => ({ receipt: f.aliasPath })],
      ["canonical", (f) => ({ receipt: f.receiptPath })],
      ["pr", (f) => ({ pr: f.receipt.pr.number })],
    ]
    for (const [name, select] of selections) {
      const f = throughSymlinkedHome(await fixture(`receipt-home-${name}`))
      const { result } = await invoke(f, select(f))
      if (!result.ok) throw new Error(`${name} selection refused: ${result.reason}`)
      // The continuation is written beside the canonical receipt, not through the alias.
      expect(result.path).toBe(join(dirname(f.receiptPath), `${result.receipt.receiptId}.json`))
      expect(existsSync(f.linked)).toBe(false)
    }
  })

  test("below a symlinked home, a symlinked receipts directory or keyed directory is still refused", async () => {
    for (const level of ["receipts", "keyed"] as const) {
      const f = throughSymlinkedHome(await fixture(`receipt-home-${level}-symlink`))
      const keyed = dirname(f.receiptPath)
      const planted = level === "receipts" ? dirname(keyed) : keyed
      renameSync(planted, `${planted}-real`)
      symlinkSync(`${planted}-real`, planted, "dir")
      for (const params of [{ receipt: f.aliasPath }, { receipt: f.receiptPath }, { pr: f.receipt.pr.number }]) {
        const { result, calls } = await invoke(f, params)
        expect(refusal(result)).toContain(`receipt.directory: observed "${planted} (symlink)"`)
        expect(calls).toEqual([])
      }
      expect(existsSync(f.linked)).toBe(true)
    }
  })

  test("receipt, argument, and each merged-PR mismatch precede every local-state observation", async () => {
    const f = await fixture("proof-order")
    const missing = await invoke(f, { pr: 999 })
    expect(refusal(missing.result)).toContain(
      "receipt: observed null, expected the newest validated receipt for pr 999",
    )
    expect(missing.calls).toEqual([])

    appendFileSync(join(f.linked, "feature.txt"), "dirty\n")
    const argument = await invoke(f, { receipt: f.receiptPath, branch: "wrong" })
    expect(refusal(argument.result)).toContain(`branch: observed "wrong", expected receipt value "${f.branch}"`)
    expect(argument.calls).toEqual([])

    const mismatches: Array<{ pr: NonNullable<RunnerOptions["pr"]>; field: string }> = [
      { pr: { state: "OPEN" }, field: "pr.state" },
      { pr: { url: "https://github.com/owner/repo/pull/99" }, field: "pr.url" },
      { pr: { baseRefName: "other-base" }, field: "pr.baseRefName" },
      { pr: { headRefName: "other-head" }, field: "pr.headRefName" },
      { pr: { headRefOid: "a".repeat(40) }, field: "pr.headRefOid" },
      { pr: { mergeCommitOid: "b".repeat(40) }, field: "pr.mergeCommitOid" },
      { pr: { mergedAt: "2027-01-15T08:00:01.000Z" }, field: "pr.mergedAt" },
    ]
    for (const mismatch of mismatches) {
      const observed = await invoke(f, { receipt: f.receiptPath }, { pr: mismatch.pr })
      expect(refusal(observed.result)).toContain(`${mismatch.field}: observed`)
      // The pull-request read is now preceded by the target's identity, because the
      // remote is resolved inside the target. That is the only thing allowed to
      // precede it, and it is a listing: no dirty check, no unpushed check, no
      // ledger read, and nothing that mutates.
      expect(observed.calls.map((argv) => argv.slice(0, 3))).toEqual([
        ["git", "worktree", "list"],
        ["git", "remote", "get-url"],
        ["gh", "pr", "view"],
      ])
      expect(observed.calls.some((argv) => argv[0] === "git" && argv[1] === "status")).toBe(false)
      expect(observed.calls.some((argv) => argv[0] === "bd")).toBe(false)
      expect(mutationCalls(observed.calls)).toEqual([])
    }
  })

  test("a schema-valid receipt without a merge commit refuses before any observation or mutation", async () => {
    const f = await fixture("missing-merge-authorization", "feat/missing-merge-authorization", "retired")
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      pr: { ...f.receipt.pr, mergeCommitOid: null },
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))

    const { result, calls } = await invoke(f, { receipt: path }, { pr: { mergeCommitOid: null } })

    expect(refusal(result)).toContain("pr.mergeCommitOid")
    expect(refusal(result)).toContain("a non-empty merge commit oid before cleanup")
    expect(calls).toEqual([])
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
    rmSync(f.root, { recursive: true, force: true })
  })

  test("commits after the PR head refuse before anything is removed", async () => {
    const f = await fixture("moved-on")
    writeFileSync(join(f.linked, "followup.txt"), "more work\n")
    git(f.linked, ["add", "followup.txt"])
    git(f.linked, ["commit", "-q", "-m", "follow-up work"])
    const { result, calls } = await invoke(f)
    expect(refusal(result)).toContain("worktree.HEAD: observed")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    rmSync(f.root, { recursive: true, force: true })
  })

  describe.each([
    ["a tracked change", "worktree.status", (f: Fixture) => writeFileSync(join(f.linked, git(f.linked, ["ls-files"]).split("\n")[0] ?? ""), "changed\n")],
    ["an untracked file", "worktree.status", (f: Fixture) => writeFileSync(join(f.linked, "untracked.txt"), "x\n")],
    ["a merge in progress", "worktree.operation", (f: Fixture) => writeFileSync(join(git(f.linked, ["rev-parse", "--absolute-git-dir"]), "MERGE_HEAD"), `${f.head}\n`)],
    ["a cherry-pick in progress", "worktree.operation", (f: Fixture) => writeFileSync(join(git(f.linked, ["rev-parse", "--absolute-git-dir"]), "CHERRY_PICK_HEAD"), `${f.head}\n`)],
    ["a rebase in progress", "worktree.operation", (f: Fixture) => mkdirSync(join(git(f.linked, ["rev-parse", "--absolute-git-dir"]), "rebase-merge"))],
    ["a bisect in progress", "worktree.operation", (f: Fixture) => writeFileSync(join(git(f.linked, ["rev-parse", "--absolute-git-dir"]), "BISECT_LOG"), "git bisect start\n")],
    ["a stash on the branch", "worktree.stash", (f: Fixture) => {
      writeFileSync(join(f.linked, "stashed.txt"), "x\n")
      git(f.linked, ["stash", "push", "-u", "-q", "-m", "keep me"])
    }],
  ])("the clean check refuses %s", (_name, gate, dirty) => {
    test("and removes nothing", async () => {
      const f = await fixture("dirty-kind")
      dirty(f)
      const { result, calls } = await invoke(f)
      expect(refusal(result)).toContain(`${gate}: observed`)
      expect(mutationCalls(calls)).toEqual([])
      expect(existsSync(f.linked)).toBe(true)
      rmSync(f.root, { recursive: true, force: true })
    })
  })

  test("an ignored file does not make the worktree dirty", async () => {
    const f = await fixture("ignored-ok")
    const commonExclude = join(resolve(f.linked, git(f.linked, ["rev-parse", "--git-common-dir"])), "info", "exclude")
    mkdirSync(dirname(commonExclude), { recursive: true })
    writeFileSync(commonExclude, "ignored.log\n")
    writeFileSync(join(f.linked, "ignored.log"), "noise\n")
    const { result } = await invoke(f)
    expect(result.ok).toBe(true)
    rmSync(f.root, { recursive: true, force: true })
  })

  test("a moved head, a dirty tree, an unpushed commit, and an open bead each refuse at their own gate", async () => {
    const f = await fixture("refusal-order")
    writeFileSync(join(f.linked, "dirty.txt"), "dirty\n")
    const dirty = await invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" })
    expect(refusal(dirty.result)).toContain("worktree.status")
    expect(refusal(dirty.result)).toContain("dirty.txt")
    expect(commandCalls(dirty.calls, "bd")).toEqual([])

    // A commit moves the worktree off the head the receipt names, and the target's
    // identity is now proved before the pull request is read — because the remote is
    // resolved inside the target — so this refuses at `worktree.HEAD` rather than
    // reaching the unpushed count. The earlier gate is the point: the receipt no
    // longer describes this worktree at all.
    rmSync(join(f.linked, "dirty.txt"))
    writeFileSync(join(f.linked, "ahead.txt"), "ahead\n")
    git(f.linked, ["add", "ahead.txt"])
    git(f.linked, ["commit", "-q", "-m", "ahead"])
    const moved = await invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" })
    expect(refusal(moved.result)).toContain("worktree.HEAD: observed")
    expect(refusal(moved.result)).toContain(f.head)
    expect(moved.calls.map((argv) => argv.slice(0, 3))).toEqual([["git", "worktree", "list"]])

    // Unpushed with the head the receipt does name: the commit is dropped and the
    // tracking ref is rewound instead, which is what `@{upstream}..HEAD` counts.
    git(f.linked, ["reset", "-q", "--hard", f.head])
    git(f.linked, ["update-ref", `refs/remotes/origin/${f.branch}`, `${f.head}^`])
    const unpushed = await invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" })
    expect(refusal(unpushed.result)).toContain("branch.unpushed: observed 1, expected 0 commits")
    expect(commandCalls(unpushed.calls, "bd")).toEqual([])

    git(f.linked, ["update-ref", `refs/remotes/origin/${f.branch}`, f.head])
    const ledger = await invoke(f, { receipt: f.receiptPath }, { beadStatus: "open" })
    expect(refusal(ledger.result)).toContain(
      `bd update delivery-17 --set-metadata pr=${f.receipt.pr.number} --set-metadata merge_sha=${f.receipt.pr.mergeCommitOid}`,
    )
    expect(mutationCalls(ledger.calls)).toEqual([])
  }, 60_000)

  test("a branch with no upstream is proved pushed by the merged pull request head", async () => {
    const f = await fixture("no-upstream")
    git(f.linked, ["config", "--unset", `branch.${f.branch}.remote`])
    git(f.linked, ["config", "--unset", `branch.${f.branch}.merge`])
    const { result } = await invoke(f)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.receipt.proof.evidence.pushed).toBe("pr-head")
  }, 60_000)

  test("an upstream read that does not complete still refuses before the ledger read", async () => {
    const f = await fixture("upstream-hung")
    const scripted = runner(f)
    const run: CliRunner = (argv, options) =>
      argv.includes("@{upstream}") && argv[1] === "rev-parse"
        ? { ok: false, exitCode: null, stdout: "", stderr: "", error: "git was killed by the 5000ms timeout" }
        : scripted.run(argv, options)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain("branch.upstream: observed")
    expect(commandCalls(scripted.calls, "bd")).toEqual([])
    expect(mutationCalls(scripted.calls)).toEqual([])
  }, 60_000)

  test("reconciliation requires every bead merge_sha to equal the receipt exactly", async () => {
    const f = await fixture("ledger-sha")
    const observed = "b".repeat(40)
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { beadMergeSha: observed })
    const reason = refusal(result)
    expect(reason).toContain("beads.delivery-17.metadata.merge_sha")
    expect(reason).toContain(observed)
    expect(reason).toContain(f.merge)
    expect(reason).toContain(
      `bd update delivery-17 --set-metadata pr=${f.receipt.pr.number} --set-metadata merge_sha=${f.merge}`,
    )
    expect(commandCalls(calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]])
    expect(mutationCalls(calls)).toEqual([])
  })

  test("reconciliation refuses a closed bead without merge_sha and names native update", async () => {
    const f = await fixture("ledger-missing-merge-sha")
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        beadRows: [{ id: "delivery-17", status: "closed", metadata: {} }],
      },
    )
    const reason = refusal(result)
    expect(reason).toContain("beads.delivery-17.metadata.merge_sha")
    expect(reason).toContain(
      `bd update delivery-17 --set-metadata pr=${f.receipt.pr.number} --set-metadata merge_sha=${f.merge}`,
    )
    expect(reason).toContain(
      `bd close delivery-17 --reason "PR #${f.receipt.pr.number} merged as ${f.merge}; receipt ${f.receiptPath}"`,
    )
    expect(commandCalls(calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]])
    expect(mutationCalls(calls)).toEqual([])
  })
  for (const [order, statuses] of [
    ["open then closed", ["open", "closed"]],
    ["closed then open", ["closed", "open"]],
  ] as const) {
    test(`conflicting duplicate bead statuses refuse in ${order} order without mutation`, async () => {
      const f = await fixture(`duplicate-status-${statuses.join("-")}`)
      const beadRows = statuses.map((status) => ({
        id: "delivery-17",
        status,
        metadata: { merge_sha: f.merge },
      }))

      const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { beadRows })

      const reason = refusal(result)
      expect(reason).toContain("beads.delivery-17")
      expect(reason).toContain("duplicate bd show rows for one bead id to be identical")
      expect(reason).toContain(JSON.stringify(beadRows))
      expect(mutationCalls(calls)).toEqual([])
      expect(existsSync(f.linked)).toBe(true)
      expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
      rmSync(f.root, { recursive: true, force: true })
    })
  }

  for (const [order, identities] of [
    ["first then second", ["issue-one", "issue-two"]],
    ["second then first", ["issue-two", "issue-one"]],
  ] as const) {
    test(`conflicting duplicate bead identities refuse in ${order} order without mutation`, async () => {
      const f = await fixture(`duplicate-identity-${identities.join("-")}`)
      const beadRows = identities.map((identity) => ({
        id: "delivery-17",
        identity,
        status: "closed",
        metadata: { merge_sha: f.merge },
      }))

      const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { beadRows })

      const reason = refusal(result)
      expect(reason).toContain("beads.delivery-17")
      expect(reason).toContain("duplicate bd show rows for one bead id to be identical")
      expect(reason).toContain(JSON.stringify(beadRows))
      expect(mutationCalls(calls)).toEqual([])
      expect(existsSync(f.linked)).toBe(true)
      expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
      rmSync(f.root, { recursive: true, force: true })
    })
  }

  test("identical duplicate bead rows coalesce without weakening cleanup authorization", async () => {
    const f = await fixture("duplicate-identical")
    const issue = { id: "delivery-17", status: "closed", metadata: { merge_sha: f.merge } }
    const linked = realpathSync(f.linked)

    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { beadRows: [issue, structuredClone(issue)] })

    expect(result.ok).toBe(true)
    expect(mutationCalls(calls)).toEqual([
      ["git", "worktree", "remove", linked],
      ["git", "branch", "-d", "--", f.branch],
    ])
    rmSync(f.root, { recursive: true, force: true })
  })

  test("refuses the repository's main worktree", async () => {
    const mainTarget = await fixture("main-target")
    const mainReceipt = buildReceipt({
      ...mainTarget.receipt,
      now: NOW + 1,
      pr: { ...mainTarget.receipt.pr, headRefName: "main", headRefOid: mainTarget.merge },
      branch: { ...mainTarget.receipt.branch, name: "main" },
      worktree: { path: mainTarget.main, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: mainTarget.receipt,
    })
    const mainPath = writeReceipt(mainReceipt, receiptDirectory(mainTarget.env, mainReceipt.repo.key))
    const mainRun = runner(mainTarget, { pr: { headRefName: "main", headRefOid: mainTarget.merge } })
    // Asked from the linked worktree: a call standing in its own target is refused
    // earlier, by the invocation check, and would not reach the main-worktree rule.
    const mainResult = await cleanupDelivery({ receipt: mainPath }, mainTarget.linked, {
      run: mainRun.run,
      now: () => NOW + 20,
      env: mainTarget.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(mainResult)).toContain("a linked worktree other than main")
    expect(mutationCalls(mainRun.calls)).toEqual([])
  })

  test("refuses a worktree from a foreign repository", async () => {
    const current = await fixture("current-repo")
    const foreign = await fixture("foreign-repo")
    const foreignReceipt = buildReceipt({
      ...current.receipt,
      now: NOW + 2,
      worktree: { path: foreign.linked, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: current.receipt,
    })
    const foreignPath = writeReceipt(foreignReceipt, receiptDirectory(current.env, foreignReceipt.repo.key))
    const foreignRun = runner(current)
    const foreignResult = await cleanupDelivery({ receipt: foreignPath }, current.main, {
      run: foreignRun.run,
      now: () => NOW + 20,
      env: current.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(foreignResult)).toContain("a worktree in the current repository")
    expect(mutationCalls(foreignRun.calls)).toEqual([])
  })

  test("refuses an unlisted path inside the same linked worktree", async () => {
    const unlisted = await fixture("unlisted")
    const nested = join(unlisted.linked, "nested")
    mkdirSync(nested)
    const unlistedReceipt = buildReceipt({
      ...unlisted.receipt,
      now: NOW + 3,
      worktree: { path: nested, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: unlisted.receipt,
    })
    const unlistedPath = writeReceipt(unlistedReceipt, receiptDirectory(unlisted.env, unlistedReceipt.repo.key))
    const unlistedRun = runner(unlisted)
    const unlistedResult = await cleanupDelivery({ receipt: unlistedPath }, unlisted.main, {
      run: unlistedRun.run,
      now: () => NOW + 20,
      env: unlisted.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(unlistedResult)).toContain("an exact live record in git worktree list --porcelain")
    expect(mutationCalls(unlistedRun.calls)).toEqual([])
  })

  test("a symlink alias cannot turn an untrusted receipt path into a listed target", async () => {
    const f = await fixture("symlink")
    const alias = join(f.root, "linked-alias")
    symlinkSync(f.linked, alias, "dir")
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      worktree: { path: alias, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: f.receipt,
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: path }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain(`${alias} (unsafe)`)
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a dirtying race at the irreversible boundary is observed before removal", async () => {
    const f = await fixture("dirty-race")
    let statuses = 0
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        before: (argv) => {
          if (argv[0] === "git" && argv[1] === "status") {
            statuses += 1
            if (statuses === 2) writeFileSync(join(f.linked, "raced.txt"), "raced\n")
          }
        },
      },
    )
    expect(refusal(result)).toContain("raced.txt")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a ref that moves after worktree removal is kept, and the removal reports success with the ref recorded present", async () => {
    const f = await fixture("ref-race")
    const beforeReceipts = readFileSync(f.receiptPath, "utf8")
    const raced = git(f.main, ["commit-tree", `${f.merge}^{tree}`, "-p", f.merge, "-m", "raced ref"])
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        after: (argv, commandResult) => {
          if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove" && commandResult.exitCode === 0) {
            git(f.main, ["update-ref", `refs/heads/${f.branch}`, raced])
          }
        },
      },
    )
    const done = removal(result)
    expect(done.report.removed).toEqual([`worktree ${f.receipt.worktree.path}`])
    expect(done.report.skipped.join("\n")).toContain(`local branch ${f.branch} kept: it moved off ${f.head}`)
    expect(done.localRefDeleted).toBe(false)
    expect(done.receipt.worktree).toMatchObject({ removed: true, localRefDeleted: false })
    expect(done.receipt.proof.evidence).toMatchObject({ localRef: "present" })
    expect(git(f.main, ["rev-parse", `refs/heads/${f.branch}`])).toBe(raced)
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
    expect(readFileSync(f.receiptPath, "utf8")).toBe(beforeReceipts)
  })

  test("work after the removal still runs when a ref race keeps the branch, and its notes join the report", async () => {
    const f = await fixture("ref-race-after")
    const raced = git(f.main, ["commit-tree", `${f.merge}^{tree}`, "-p", f.merge, "-m", "raced ref"])
    const seen: string[] = []
    const { result } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        after: (argv, commandResult) => {
          if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove" && commandResult.exitCode === 0) {
            git(f.main, ["update-ref", `refs/heads/${f.branch}`, raced])
          }
        },
      },
      {
        afterRemoval: async (worktree) => {
          seen.push(worktree)
          return ["session ses_x could not be moved"]
        },
      },
    )
    const notes = removal(result).report.skipped.join("\n")
    expect(notes).toContain(`local branch ${f.branch} kept`)
    expect(notes).toContain("session ses_x could not be moved")
    expect(seen).toHaveLength(1)
    expect(existsSync(f.linked)).toBe(false)
  })

  test("work after the removal does not run when the removal's absence was not proven", async () => {
    const f = await fixture("registration-race-after")
    let ran = false
    const { result } = await invoke(
      f,
      { receipt: f.receiptPath },
      { registeredTargetAfterRemove: true },
      {
        afterRemoval: async () => {
          ran = true
          return []
        },
      },
    )
    const done = removal(result)
    expect(done.receipt.receiptId).toBe(f.receipt.receiptId)
    expect(done.report.skipped.join("\n")).toContain("absence is not proven")
    expect(ran).toBe(false)
  })

  test("work after the removal that throws is reported and does not fail the cleanup", async () => {
    const f = await fixture("after-throws")
    const { result } = await invoke(
      f,
      { receipt: f.receiptPath },
      {},
      {
        afterRemoval: async () => {
          throw new Error("move machinery down")
        },
      },
    )
    if (!result.ok) throw new Error(result.reason)
    expect(existsSync(f.linked)).toBe(false)
    expect(result.report.skipped.join("\n")).toContain("move machinery down")
  })

  test("notes from the work after the removal join the report when the continuation receipt cannot be written", async () => {
    const f = await fixture("after-notes-write-fails")
    const dir = dirname(f.receiptPath)
    const { result } = await invoke(
      f,
      { receipt: f.receiptPath },
      {},
      {
        afterRemoval: async () => {
          // The receipt directory becomes a symlink, which the writer refuses.
          renameSync(dir, `${dir}-moved`)
          symlinkSync(`${dir}-moved`, dir)
          return ["session ses_x could not be moved"]
        },
      },
    )
    const done = removal(result)
    const notes = done.report.skipped.join("\n")
    expect(notes).toContain("no continuation receipt written")
    expect(notes).toContain("session ses_x could not be moved")
    expect(done.receipt.receiptId).toBe(f.receipt.receiptId)
  })

  test("re-registration after removal is reported, keeps the branch and writes no receipt", async () => {
    const f = await fixture("registration-race")
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        after: (argv, commandResult) => {
          if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove" && commandResult.exitCode === 0) {
            git(f.main, ["worktree", "add", "-q", f.linked, f.branch])
          }
        },
      },
    )
    const done = removal(result)
    expect(done.report.removed).toEqual([`worktree ${f.receipt.worktree.path}`])
    expect(done.report.skipped.join("\n")).toContain("registration present")
    expect(done.receipt.receiptId).toBe(f.receipt.receiptId)
    expect(existsSync(f.linked)).toBe(true)
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
  })

  test("a stored registration path remains present proof after its filesystem target vanishes", async () => {
    const f = await fixture("stored-registration")
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { registeredTargetAfterRemove: true })
    expect(removal(result).report.skipped.join("\n")).toContain("registration present")
    expect(existsSync(f.linked)).toBe(false)
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
  })

  test("a pathless porcelain record makes post-remove registration proof unknown", async () => {
    const f = await fixture("pathless-record")
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { pathlessAfterRemove: true })
    expect(removal(result).report.skipped.join("\n")).toContain("registration unknown")
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
  })

  test("filesystem-path recreation after removal is independent of registration absence", async () => {
    const f = await fixture("path-race")
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        after: (argv, commandResult) => {
          if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove" && commandResult.exitCode === 0) {
            mkdirSync(f.linked)
          }
        },
      },
    )
    const done = removal(result)
    expect(done.report.skipped.join("\n")).toContain("directory present")
    expect(done.receipt.receiptId).toBe(f.receipt.receiptId)
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
  })

  test("local-ref recreation after branch -d is reported, and the receipt records the ref present", async () => {
    const f = await fixture("local-ref-race")
    const { result } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        after: (argv, commandResult) => {
          if (argv[0] === "git" && argv[1] === "branch" && argv[2] === "-d" && commandResult.exitCode === 0) {
            git(f.main, ["update-ref", `refs/heads/${f.branch}`, f.head])
          }
        },
      },
    )
    const done = removal(result)
    expect(done.report.skipped.join("\n")).toContain(`local branch ${f.branch}: observed present afterwards, expected absent`)
    expect(done.localRefDeleted).toBe(false)
    expect(done.receipt.worktree).toMatchObject({ removed: true, localRefDeleted: false })
    expect(git(f.main, ["rev-parse", `refs/heads/${f.branch}`])).toBe(f.head)
  })

  test("hostile shell punctuation remains one argv element and cannot create a side effect", async () => {
    const marker = join(tmpdir(), "delivery-cleanup-must-not-exist")
    rmSync(marker, { force: true })
    const branch = `feat/cleanup;touch-${marker.replaceAll("/", "-")}`
    const f = await fixture("argv", branch)
    const { result, calls } = await invoke(f)
    expect(result.ok).toBe(true)
    expect(calls).toContainEqual(["git", "branch", "-d", "--", branch])
    expect(existsSync(marker)).toBe(false)
  })

  test("a leading-dash branch remains an operand after the branch-delete option terminator", () => {
    expect(branchDeleteArgs("-malicious-option")).toEqual(["branch", "-d", "--", "-malicious-option"])
  })
})

/**
 * The worktree lock every delivery remover takes (`pending-cleanup.ts`), without the host's last
 * look at claims and sessions, so two calls in one test exclude each other the way two plugin
 * instances do. `sleep` sees the waits for a busy lock. With `holds`, the removal's two looks read
 * the background-work records from disk, as every remover's do.
 */
function lockedDeps(f: Fixture, sessionID: string, sleep?: (ms: number) => Promise<void>, holds = false): Partial<CleanupDeps> {
  const common = resolve(f.main, git(f.main, ["rev-parse", "--git-common-dir"]))
  const lock = { sessionID, ...(sleep === undefined ? {} : { sleep }) }
  const look = async (worktree: string) => (holds ? holdsState(common, worktree, NOW + 10) : undefined)
  return {
    proofSection: async (worktree, read) => {
      const outcome = await lockedWorktreeRead(common, worktree, lock, read)
      return outcome.locked ? outcome.value : { ok: false, reason: outcome.reason }
    },
    removalSection: async (worktree, run) => {
      const outcome = await lockedWorktreeRemoval(common, worktree, lock, { recheck: () => look(worktree), remove: run })
      return outcome.removed ? outcome.value : { ok: false, reason: outcome.reason }
    },
    finalCheck: look,
  }
}

/** `inner`, except that its `nth` call matching `match` first runs `during` and then takes `ms` longer: a slow read under load. */
function slowCall(inner: CliRunner, match: (argv: readonly string[]) => boolean, nth: number, ms: number, during: () => void): CliRunner {
  let seen = 0
  return async (argv, options) => {
    if (match(argv) && ++seen === nth) {
      during()
      await Bun.sleep(ms)
    }
    return inner(argv, options)
  }
}

describe("delivery_cleanup beside a background job that starts during it", () => {
  // Scaled down from the real bounds: a hold writer waits 300 ms for the lock (10 s in production) while
  // one read takes 800 ms (a slow `gh` read, or a `git status` of a large tree, up to `treeScanMs`).
  const WRITER_WAIT_MS = 300
  const SLOW_READ_MS = 800
  const isStatus = (argv: readonly string[]) => argv[0] === "git" && argv.includes("status") && argv.includes("--porcelain")
  const isPrRead = (argv: readonly string[]) => argv[0] === "gh" && argv[1] === "pr"

  const contend = async (name: string, match: (argv: readonly string[]) => boolean, nth: number) => {
    const f = await fixture(name)
    const common = resolve(f.main, git(f.main, ["rev-parse", "--git-common-dir"]))
    let write: Promise<string> = Promise.resolve("never started")
    const job = () => {
      // Another plugin instance's idle gate records a shell it just saw running in the worktree.
      write = outsideLocks(() =>
        recordHold(common, f.linked, "ses_bg", [{ kind: "shell", id: "sh_1" }], NOW + 10, { sessionID: "ses_bg", waitMs: WRITER_WAIT_MS }).then(
          () => "recorded",
          (error) => (error instanceof LockTimeout ? "starved" : String(error)),
        ),
      )
    }
    const scripted = runner(f)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run: slowCall(scripted.run, match, nth, SLOW_READ_MS, job),
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
      ...lockedDeps(f, "remover", undefined, true),
    })
    return { f, result, written: await write, calls: scripted.calls }
  }

  test("a hold written during a slow first proof is not starved, and the removal refuses", async () => {
    const { f, result, written, calls } = await contend("hold-during-proof", isPrRead, 1)
    expect(written).toBe("recorded")
    expect(refusal(result)).toContain("session ses_bg has 1 background job(s) running (shell sh_1)")
    expect(calls.filter(isWorktreeRemove)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a hold whose write is starved by a slow final scan under the removal lock still reaches disk, and the removal refuses", async () => {
    // The second scan is revalidateBoundary's, inside the removal section, after the removal's first look.
    const { f, result, written, calls } = await contend("hold-during-final-scan", isStatus, 2)
    expect(written).toBe("starved")
    expect(refusal(result)).toContain("session ses_bg has 1 background job(s) running (shell sh_1)")
    expect(calls.filter(isWorktreeRemove)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    // The record stays until a later write of that session takes the lock.
    const common = resolve(f.main, git(f.main, ["rev-parse", "--git-common-dir"]))
    expect(holdsState(common, f.linked, NOW + 10)).toContain("ses_bg")
  })
})

const isWorktreeRemove = (argv: readonly string[]) => argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove"

/** A command that deletes, in any form a result could carry it: its own advice, git's quoted hint, or an expectation text. */
const DESTRUCTIVE_ADVICE = /--force|-f -f|\s-D\b|rm -r/

describe("delivery_cleanup beside another remover", () => {
  test("a cleanup that overlaps another call's removal reports the worktree already cleaned, not a dirty tree", async () => {
    const f = await fixture("overlap")
    const tracked = git(f.linked, ["ls-files"]).split("\n").filter(Boolean)
    let partWay = () => {}
    const removing = new Promise<void>((done) => {
      partWay = done
    })
    let release = () => {}
    const released = new Promise<void>((done) => {
      release = done
    })
    const first = runner(f)
    // `git worktree remove` deletes the tree file by file: this one stops part-way until the other call has looked.
    const runFirst: CliRunner = async (argv, options) => {
      if (!isWorktreeRemove(argv)) return first.run(argv, options)
      for (const file of tracked.slice(0, 2)) rmSync(join(f.linked, file))
      partWay()
      await released
      return runCli([...argv.slice(0, 3), "--force", ...argv.slice(3)], options)
    }
    const deps = { now: () => NOW + 10, env: f.env, bounds: HEAVY_FIXTURE_BOUNDS }
    const removal = cleanupDelivery({ receipt: f.receiptPath }, f.main, { ...deps, run: runFirst, ...lockedDeps(f, "first") })
    await removing
    let waiting = () => {}
    const blocked = new Promise<void>((done) => {
      waiting = done
    })
    const lockWait = async (ms: number) => {
      waiting()
      await Bun.sleep(ms)
    }
    const overlapping = cleanupDelivery({ receipt: f.receiptPath }, f.main, { ...deps, run: runner(f).run, ...lockedDeps(f, "second", lockWait) })
    // The second call either answers from the half-deleted tree or waits for the lock the removal holds.
    await Promise.race([overlapping, blocked])
    release()
    const [removed, other] = await Promise.all([removal, overlapping])
    if (!removed.ok) throw new Error(removed.reason)
    expect(removed.alreadyCleaned).toBe(false)
    if (!other.ok) throw new Error(`refused while another call removed the worktree: ${other.reason}`)
    expect(other.alreadyCleaned).toBe(true)
    expect(other.report.removed).toEqual([])
    expect(existsSync(f.linked)).toBe(false)
  })

  test("a worktree another remover takes between the proofs and the removal is reported already cleaned", async () => {
    const f = await fixture("taken-before-removal")
    const { result, calls } = await invoke(
      f,
      { receipt: f.receiptPath },
      {},
      {
        ...lockedDeps(f, "late"),
        // The prompt sits between the proofs and the removal section; another remover finishes meanwhile.
        authorize: async () => {
          git(f.main, ["worktree", "remove", "--force", f.linked])
        },
      },
    )
    if (!result.ok) throw new Error(`refused after another remover took the worktree: ${result.reason}`)
    expect(result.alreadyCleaned).toBe(true)
    expect(calls.filter(isWorktreeRemove)).toEqual([])
  })

  test("a tree that only lost tracked files is refused as a removal in progress elsewhere, with nothing removed", async () => {
    const f = await fixture("unlocked-remover")
    // A remover that takes no lock (another plugin, another tool that removes worktrees) is part-way through the tree.
    for (const file of git(f.linked, ["ls-files"]).split("\n").filter(Boolean).slice(0, 2)) rmSync(join(f.linked, file))
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, lockedDeps(f, "observer"))
    expect(refusal(result)).toContain("worktree.status")
    expect(refusal(result)).toContain("only deleted tracked files")
    expect(refusal(result)).toContain("another process")
    // A cause is named, never a command an agent could take as its next step.
    expect(refusal(result)).toContain("another tool that removes worktrees without the delivery lock")
    expect(refusal(result)).not.toContain("wt remove")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a removal that fails part-way after deleting the registration is reported as partly removed, not as a refusal", async () => {
    const f = await fixture("part-way")
    const before = readdirSync(dirname(f.receiptPath)).sort()
    const scripted = runner(f)
    // Git deletes the registration even when it cannot delete every file of the tree.
    const run: CliRunner = async (argv, options) => {
      if (!isWorktreeRemove(argv)) return scripted.run(argv, options)
      scripted.calls.push([...argv])
      await runCli([...argv.slice(0, 3), "--force", ...argv.slice(3)], options)
      mkdirSync(join(f.linked, "vendor"), { recursive: true })
      writeFileSync(join(f.linked, "vendor", "read-only.txt"), "x\n")
      return { ok: true, exitCode: 255, stdout: "", stderr: `error: failed to delete '${f.linked}': Directory not empty\n` }
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, { run, now: () => NOW + 10, env: f.env, bounds: HEAVY_FIXTURE_BOUNDS })
    const done = removal(result)
    expect(done.alreadyCleaned).toBe(false)
    expect(done.partlyRemoved).toBe(true)
    expect(done.report.removed).toEqual([])
    expect(done.report.skipped.join("\n")).toContain("removal attempted and stopped part-way")
    expect(done.localRefDeleted).toBe(false)
    expect(scripted.calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
    expect(readdirSync(dirname(f.receiptPath)).sort()).toEqual(before)
  })

  test("the final check is given the receipt's own spelling of the worktree beside git's", async () => {
    const f = await fixture("final-check-spellings")
    const seen: Array<readonly string[] | undefined> = []
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run: runner(f).run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
      finalCheck: async (_worktree, spellings) => {
        seen.push(spellings)
        return undefined
      },
    })
    expect(result.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain(f.linked)
  })

  /** Git stops part-way with the tree still registered and on disk: `before` deletes tracked files, then real git refuses the now-dirty tree, and `after` gives the command the reported shape. */
  const stoppedPartWay = (f: Fixture, shape: "exit 255" | "timeout", deletes: boolean): RunnerOptions => ({
    before: (argv) => {
      if (!isWorktreeRemove(argv) || !deletes) return
      for (const file of git(f.linked, ["ls-files"]).split("\n").filter(Boolean).slice(0, 2)) rmSync(join(f.linked, file))
    },
    after: (argv, result) => {
      if (!isWorktreeRemove(argv)) return
      if (shape === "exit 255") Object.assign(result, { ok: true, exitCode: 255, error: undefined, stderr: `error: failed to delete '${f.linked}': Permission denied\n` })
      else Object.assign(result, { ok: false, exitCode: null, stderr: "", error: "timeout" })
    },
  })

  test.each([
    ["exit 255 after deleting tracked files", "exit 255", true],
    ["a timeout after deleting tracked files", "timeout", true],
    ["a timeout that deleted nothing it can show", "timeout", false],
  ] as const)("a removal that stopped part-way, still registered and on disk (%s), is reported as partly removed, unverified", async (_name, shape, deletes) => {
    const f = await fixture("stopped-part-way")
    const before = readdirSync(dirname(f.receiptPath)).sort()
    // A timeout with nothing deleted would otherwise remove the clean tree for real.
    if (!deletes) git(f.main, ["worktree", "lock", f.linked])
    let after = false
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, stoppedPartWay(f, shape, deletes), {
      afterRemoval: async () => {
        after = true
        return []
      },
    })
    const done = removal(result)
    expect(done.partlyRemoved).toBe(true)
    expect(done.report.removed).toEqual([])
    const notes = done.report.skipped.join("\n")
    expect(notes).toContain("removal attempted and stopped part-way")
    expect(notes).toContain("registration present, directory present; absence unverified; no continuation receipt")
    expect(notes).toContain(`inspect ${f.linked} and save any changes in it`)
    // Deletion-only status does not prove the removal did them, and ignored files do not show: nothing destructive is named.
    expect(notes).not.toMatch(DESTRUCTIVE_ADVICE)
    expect(done.localRefDeleted).toBe(false)
    expect(after).toBe(false)
    expect(calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
    expect(readdirSync(dirname(f.receiptPath)).sort()).toEqual(before)
    expect(existsSync(f.linked)).toBe(true)
    expect(git(f.main, ["worktree", "list", "--porcelain"])).toContain(`worktree ${f.linked}`)
    if (!deletes) return
    // The rerun meets the half-removed tree and says what it is, without claiming to remove anything.
    const rerun = refusal((await invoke(f)).result)
    expect(rerun).toContain("a removal is running or stopped part-way")
    expect(rerun).toContain("an earlier cleanup that failed")
    expect(rerun).toContain(`inspect ${f.linked} and save any changes in it`)
    expect(rerun).not.toContain("rerun")
    expect(rerun).not.toMatch(DESTRUCTIVE_ADVICE)
  })

  test("a part-way failure whose path holds git's clean-check words is still partly removed", async () => {
    // The fixture's path carries the phrase; git's failure names that path.
    const f = await fixture("contains modified or untracked files", "feat/clean-check-words")
    expect(f.linked).toContain("contains modified or untracked files")
    const { result } = await invoke(f, { receipt: f.receiptPath }, stoppedPartWay(f, "exit 255", true))
    const done = removal(result)
    expect(done.partlyRemoved).toBe(true)
    expect(done.report.skipped.join("\n")).toContain("removal attempted and stopped part-way")
  })

  test("a failed removal that deleted nothing is still a refusal", async () => {
    const f = await fixture("refused-untouched")
    git(f.main, ["worktree", "lock", f.linked])
    const { result } = await invoke(f)
    expect(refusal(result)).toContain("worktree.removed")
    expect(refusal(result)).toContain("locked")
    expect(existsSync(f.linked)).toBe(true)
    expect(git(f.linked, ["status", "--porcelain"])).toBe("")
  })

  test.each([
    ["an untracked file", (f: Fixture) => writeFileSync(join(f.linked, "new-work.txt"), "new work\n"), "new-work.txt"],
    ["an edit to a tracked file", (f: Fixture) => writeFileSync(join(f.linked, "base.txt"), "edited\n"), "base.txt"],
  ] as const)("%s written between the last proof and the removal is a plain refusal that names it", async (_name, write, changed) => {
    const f = await fixture("dirty-after-proof")
    const before = readdirSync(dirname(f.receiptPath)).sort()
    // Git refuses the now-dirty tree before deleting anything.
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, { before: (argv) => (isWorktreeRemove(argv) ? write(f) : undefined) })
    const reason = refusal(result)
    expect(reason).toContain("worktree.removed")
    expect(reason).toContain("the tree changed after the last proof")
    expect(reason).toContain(changed)
    expect(reason).toContain("save those changes")
    expect(reason).not.toContain("git worktree remove --force")
    expect(calls.filter(isWorktreeRemove)).toHaveLength(1)
    expect(existsSync(join(f.linked, changed))).toBe(true)
    expect(git(f.linked, ["ls-files", "--deleted"])).toBe("")
    expect(readdirSync(dirname(f.receiptPath)).sort()).toEqual(before)
  })

  test("a removal that deleted only the .git marker is partly removed, not a refusal", async () => {
    const f = await fixture("marker-deleted")
    const scripted = runner(f)
    // The pinned status still reads the tree clean; only the marker shows what went.
    const run: CliRunner = async (argv, options) => {
      if (!isWorktreeRemove(argv)) return scripted.run(argv, options)
      scripted.calls.push([...argv])
      rmSync(join(f.linked, ".git"))
      return { ok: true, exitCode: 255, stdout: "", stderr: `error: failed to delete '${f.linked}': Permission denied\n` }
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, { run, now: () => NOW + 10, env: f.env, bounds: HEAVY_FIXTURE_BOUNDS })
    const done = removal(result)
    expect(done.partlyRemoved).toBe(true)
    expect(done.report.skipped.join("\n")).toContain(`inspect ${f.linked} and save any changes in it`)
    expect(done.report.skipped.join("\n")).not.toMatch(DESTRUCTIVE_ADVICE)
    expect(scripted.calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
  })

  /** Every text a failed removal reaches a person or an agent through: the tool's, the land report's, and the idle retry's note. */
  const surfaces = (f: Fixture, result: CleanupResult): string[] =>
    result.ok
      ? [...result.report.skipped, cleanupText(result), textAfterCleanup("landed", reportFromCleanup(result)), partlyRemovedText(f.receipt, result.report.skipped)]
      : [result.reason, cleanupText(result), textAfterCleanup("landed", reportFromCleanup(result))]

  type Shape = {
    name: string
    outcome: "refusal" | "partly removed"
    /** Text the result must carry. */
    says?: string
    arrange?: (f: Fixture) => void
    options?: (f: Fixture) => RunnerOptions
    run?: (f: Fixture, inner: CliRunner) => CliRunner
  }
  const deleteTracked = (f: Fixture) => rmSync(join(f.linked, "base.txt"))
  const writeUntracked = (f: Fixture) => writeFileSync(join(f.linked, "new-work.txt"), "new work\n")
  const onRemove = (act: (f: Fixture) => void) => (f: Fixture): RunnerOptions => ({ before: (argv) => (isWorktreeRemove(argv) ? act(f) : undefined) })
  /** A remove that fails with git's "failed to delete" after `act`, without running git. */
  const failsToDelete = (act: (f: Fixture) => void) => (f: Fixture, inner: CliRunner): CliRunner => async (argv, options) => {
    if (!isWorktreeRemove(argv)) return inner(argv, options)
    act(f)
    return { ok: true, exitCode: 255, stdout: "", stderr: `error: failed to delete '${f.linked}': Permission denied\n` }
  }
  const matrix: Shape[] = [
    { name: "an untracked file only", outcome: "refusal", options: onRemove(writeUntracked) },
    { name: "a tracked edit only", outcome: "refusal", options: onRemove((f) => writeFileSync(join(f.linked, "base.txt"), "edited\n")) },
    // Git refuses at its clean check before deleting anything: the deletion is another process's, not this call's.
    { name: "a deletion only, git refusing at its clean check", outcome: "refusal", says: "a removal is running or stopped part-way", options: onRemove(deleteTracked) },
    {
      name: "a deletion and an untracked file",
      outcome: "refusal",
      says: "the tree changed after the last proof",
      options: onRemove((f) => {
        deleteTracked(f)
        writeUntracked(f)
      }),
    },
    { name: "the .git marker only (exit 255)", outcome: "partly removed", run: failsToDelete((f) => rmSync(join(f.linked, ".git"))) },
    {
      name: "a status that cannot be read afterwards (exit 255)",
      outcome: "partly removed",
      run: (f, inner) => {
        let removed = false
        const failing = failsToDelete(() => {
          removed = true
        })(f, inner)
        return async (argv, options) =>
          removed && argv.includes("status") ? { ok: false, exitCode: null, stdout: "", stderr: "", error: "timeout" } : failing(argv, options)
      },
    },
    {
      name: "no exit status (a timeout)",
      outcome: "partly removed",
      arrange: (f) => git(f.main, ["worktree", "lock", f.linked]),
      options: () => ({ after: (argv, result) => (isWorktreeRemove(argv) ? Object.assign(result, { ok: false, exitCode: null, stderr: "", error: "timeout" }) : undefined) }),
    },
    { name: "a locked tree, untouched", outcome: "refusal", arrange: (f) => git(f.main, ["worktree", "lock", "--reason", "kept on purpose", f.linked]) },
  ]

  test.each(matrix.map((shape) => [shape.name, shape] as const))("a failed removal with %s names no command that deletes", async (_name, shape) => {
    const f = await fixture("no-deleting-advice")
    const before = readdirSync(dirname(f.receiptPath)).sort()
    shape.arrange?.(f)
    const scripted = runner(f, shape.options?.(f) ?? {})
    const run = shape.run === undefined ? scripted.run : shape.run(f, scripted.run)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, { run, now: () => NOW + 10, env: f.env, bounds: HEAVY_FIXTURE_BOUNDS })
    expect(result.ok ? (result.partlyRemoved ? "partly removed" : "removed") : "refusal").toBe(shape.outcome)
    if (shape.says !== undefined) expect(surfaces(f, result).join("\n")).toContain(shape.says)
    for (const text of surfaces(f, result)) expect(text).not.toMatch(DESTRUCTIVE_ADVICE)
    expect(readdirSync(dirname(f.receiptPath)).sort()).toEqual(before)
    expect(scripted.calls.some((argv) => argv[0] === "git" && argv[1] === "branch")).toBe(false)
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a branch deletion that git refuses is reported without git's branch -D hint", async () => {
    const f = await fixture("branch-delete-hint")
    const scripted = runner(f)
    const run: CliRunner = async (argv, options) =>
      argv[0] === "git" && argv[1] === "branch" && argv[2] === "-d"
        ? {
            ok: true,
            exitCode: 1,
            stdout: "",
            stderr: `error: the branch '${f.branch}' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D ${f.branch}'\n`,
          }
        : scripted.run(argv, options)
    const done = removal(await cleanupDelivery({ receipt: f.receiptPath }, f.main, { run, now: () => NOW + 10, env: f.env, bounds: HEAVY_FIXTURE_BOUNDS }))
    const notes = done.report.skipped.join("\n")
    expect(notes).toContain(`local branch ${f.branch} kept`)
    expect(notes).toContain("is not fully merged")
    for (const text of surfaces(f, done)) expect(text).not.toMatch(DESTRUCTIVE_ADVICE)
  })
})

/**
 * One runner for a real `delivery_land` call against a fixture repository: the forge
 * reads are scripted, every Git read is answered by the fixture's own repository.
 *
 * Scripted `git remote get-url` is the one exception. The fixture's `origin` is a
 * local bare path, which `detectForge` correctly refuses as no forge; the URL is what
 * the landing classifies, and the remote NAME is what the receipt records. The
 * branch ref reads, which a GitHub landing makes through `gh api graphql`, are scripted
 * too: the base branch's tip is the fixture's merge commit, and the head branch is absent.
 */
function landRunner(f: Fixture): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: CliRunner = (argv, options) => {
    calls.push([...argv])
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return success(githubPayload(f))
    if (argv[0] === "gh" && argv[2] === "graphql" && argv.some((part) => part.includes("ref(qualifiedName"))) {
      const base = argv.includes(`ref=refs/heads/${f.receipt.pr.baseRefName}`)
      const ref = { prefix: "refs/heads/", name: f.receipt.pr.baseRefName, target: { __typename: "Commit", oid: f.receipt.pr.mergeCommitOid } }
      return success(JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", ref: base ? ref : null } } }))
    }
    if (argv[0] === "gh" && argv[1] === "api") return success("false\n")
    if (argv[0] === "git" && argv[1] === "remote" && argv[2] === "get-url")
      return success("https://github.com/owner/repo.git\n")
    return runCli(argv, options)
  }
  return { run, calls }
}

/**
 * The classification seam is the security boundary this whole tool stands on, so it
 * is exercised against real repositories: a real `.beads` at a real canonical root, a
 * real nested retired marker, and a real linked worktree that really disappears or
 * really survives.
 */
describe("the ledger is classified at the canonical root, never at a caller's directory", () => {
  /**
   * The escalation the final integration review proved, end to end and now closed:
   * land from a directory shadowed by a nested retired `.beads`, then clean from the
   * repository whose canonical ledger is active. Before the fix the receipt recorded
   * `ledgerActive: false` from the shadowed directory and cleanup returned success
   * from the ledger gate without issuing a single `bd` call, deleting the worktree and
   * the branch while the bead stayed open.
   */
  test("a landing from a shadowed directory records the canonical verdict, and cleanup then requires reconciliation", async () => {
    const f = await fixture("bypass", "omp/agent/delivery-17")
    const shadowed = join(f.main, "nested")
    mkdirSync(join(shadowed, ".beads"), { recursive: true })
    writeFileSync(join(shadowed, ".beads", "RETIRED"), "retired\n")

    const landing = landRunner(f)
    const landed = await landPullRequest(
      { pr: f.receipt.pr.number, worktree: f.linked },
      { run: landing.run, cwd: shadowed, now: () => NOW + 5, env: f.env },
    )
    expect(landed.ok).toBe(true)
    if (!landed.ok) throw new Error(landed.reason)
    expect(landed.receipt.beads).toEqual({ ids: ["delivery-17"], ledgerActive: true })
    expect(landed.receipt.proof.evidence).toMatchObject({ ledger: { root: realpathSync(f.main), active: true } })
    expect(landed.receipt.repo.remote).toBe("origin")
    expect(landed.next).toEqual([
      `bd update delivery-17 --set-metadata pr=${landed.receipt.pr.number} --set-metadata merge_sha=${landed.receipt.pr.mergeCommitOid}`,
      `bd close delivery-17 --reason "PR #${landed.receipt.pr.number} merged as ${landed.receipt.pr.mergeCommitOid}; receipt ${landed.receiptPath}"`,
      "delivery_cleanup",
    ])

    const cleaning = runner(f)
    const cleaned = await cleanupDelivery({ receipt: landed.receiptPath }, f.main, {
      run: cleaning.run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(cleaned.ok).toBe(true)
    // The gate ran: the bypass was a cleanup that reached success with no bd call.
    expect(commandCalls(cleaning.calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]])
    expect(existsSync(f.linked)).toBe(false)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(1)
  })

  test("an unreconciled bead still refuses that same landing, so the gate is the ledger's and not the receipt's", async () => {
    const f = await fixture("bypass-open-bead", "omp/agent/delivery-17")
    const shadowed = join(f.main, "nested")
    mkdirSync(join(shadowed, ".beads"), { recursive: true })
    writeFileSync(join(shadowed, ".beads", "RETIRED"), "retired\n")

    const landed = await landPullRequest(
      { pr: f.receipt.pr.number, worktree: f.linked },
      { run: landRunner(f).run, cwd: shadowed, now: () => NOW + 5, env: f.env },
    )
    expect(landed.ok).toBe(true)
    if (!landed.ok) throw new Error(landed.reason)

    const cleaning = runner(f, { beadStatus: "open" })
    const refused = await cleanupDelivery({ receipt: landed.receiptPath }, f.main, {
      run: cleaning.run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(refused)).toContain(
      `bd update delivery-17 --set-metadata pr=${landed.receipt.pr.number} --set-metadata merge_sha=${landed.receipt.pr.mergeCommitOid}`,
    )
    expect(mutationCalls(cleaning.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
  })

  for (const layout of ["separate-git-dir", "separate-dot-git-dir", "submodule"] as const) {
    test(`${layout}: an active checkout ledger requires reconciliation and preserves an open bead's worktree and branch`, async () => {
      const f = await fixture(`live-${layout}`, "omp/agent/delivery-17", "active", layout)
      const landed = await landPullRequest(
        { pr: f.receipt.pr.number, worktree: f.linked },
        { run: landRunner(f).run, cwd: f.main, now: () => NOW + 5, env: f.env },
      )

      expect(landed.ok).toBe(true)
      if (!landed.ok) throw new Error(landed.reason)
      expect(landed.receipt.repo.canonicalRoot).toBe(realpathSync(f.main))
      expect(landed.receipt.beads).toEqual({ ids: ["delivery-17"], ledgerActive: true })
      expect(landed.next).toEqual([
        `bd update delivery-17 --set-metadata pr=${landed.receipt.pr.number} --set-metadata merge_sha=${landed.receipt.pr.mergeCommitOid}`,
        `bd close delivery-17 --reason "PR #${landed.receipt.pr.number} merged as ${landed.receipt.pr.mergeCommitOid}; receipt ${landed.receiptPath}"`,
        "delivery_cleanup",
      ])

      const cleaning = runner(f, { beadStatus: "open" })
      const refused = await cleanupDelivery({ receipt: landed.receiptPath }, f.main, {
        run: cleaning.run,
        now: () => NOW + 10,
        env: f.env,
        bounds: HEAVY_FIXTURE_BOUNDS,
      })
      expect(refusal(refused)).toContain(
        `bd update delivery-17 --set-metadata pr=${landed.receipt.pr.number} --set-metadata merge_sha=${landed.receipt.pr.mergeCommitOid}`,
      )
      expect(commandCalls(cleaning.calls, "bd")).toEqual([["bd", "show", "delivery-17", "--json"]])
      expect(mutationCalls(cleaning.calls)).toEqual([])
      expect(existsSync(f.linked)).toBe(true)
      expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
    })
  }

  /**
   * The same receipt an unfixed producer would have written, and the same receipt an
   * attacker would forge: `ledgerActive: false` over a repository whose canonical
   * ledger is active. The stored boolean alone never opens the success path.
   */
  test("a stale or tampered false claim is refused against the recomputed verdict, and nothing is removed", async () => {
    const f = await fixture("stale-false-claim")
    const stale = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      beads: { ids: f.receipt.beads.ids, ledgerActive: false },
    })
    const stalePath = writeReceipt(stale, receiptDirectory(f.env, stale.repo.key))

    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: stalePath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    const reason = refusal(result)
    expect(reason).toContain("beads.ledgerActive: observed false stored in the receipt, expected true")
    expect(reason).toContain(`recomputed at canonical root "${realpathSync(f.main)}"`)
    expect(reason).toContain(
      `bd update delivery-17 --set-metadata pr=${f.receipt.pr.number} --set-metadata merge_sha=${f.receipt.pr.mergeCommitOid}`,
    )
    expect(mutationCalls(calls)).toEqual([])
    expect(commandCalls(calls, "bd")).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
  })

  test("a true claim over a retired canonical root is refused just as loudly", async () => {
    const f = await fixture("stale-true-claim", "feat/stale-true-claim", "retired")
    const claimed = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      beads: { ids: f.receipt.beads.ids, ledgerActive: true },
    })
    const claimedPath = writeReceipt(claimed, receiptDirectory(f.env, claimed.repo.key))

    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: claimedPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    const reason = refusal(result)
    expect(reason).toContain("beads.ledgerActive: observed true stored in the receipt, expected false")
    expect(reason).toContain(`recomputed at canonical root "${realpathSync(f.main)}"`)
    // Receipts minted before the canonical-root fix carry this claim; the refusal names the way out.
    expect(reason).toContain(
      `run delivery_land for PR #${claimed.pr.number} again with worktree "${claimed.worktree.path}"`,
    )
    expect(reason).toContain("then run delivery_cleanup with that new receipt")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  /**
   * An active ledger with nothing to reconcile is refused by the receipt's own
   * validator, so a tampered file carrying that pair never reaches the ledger gate.
   */
  test("a tampered receipt claiming an active ledger with no bead ids is refused when it is read", async () => {
    const f = await fixture("tampered-empty-ids")
    const directory = receiptDirectory(f.env, f.receipt.repo.key)
    const tampered = { ...f.receipt, beads: { ids: [], ledgerActive: true } }
    rmSync(f.receiptPath)
    writeFileSync(join(directory, `${f.receipt.receiptId}.json`), JSON.stringify(tampered))

    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    expect(refusal(result)).toContain(
      "beads.ids: observed array of 0, expected at least one bead id when beads.ledgerActive is true",
    )
    expect(calls).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })
})

describe("delivery_cleanup never removes the worktree it was called from", () => {
  test("a call from inside its own target refuses, naming the invocation and the resolved target", async () => {
    const f = await fixture("invocation-target")
    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.linked, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    const reason = refusal(result)
    expect(reason).toContain(`worktree.invocationCwd: observed "${f.linked}"`)
    expect(reason).toContain(realpathSync(f.linked))
    expect(calls).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    expect(gitExit(f.main, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`])).toBe(0)
  })

  test("a subdirectory of the target is inside the target", async () => {
    const f = await fixture("invocation-nested")
    const nested = join(f.linked, "deep", "deeper")
    mkdirSync(nested, { recursive: true })
    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, nested, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    expect(refusal(result)).toContain("expected a directory outside the worktree this call would remove")
    expect(calls).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a symlinked alias of the target is still the target", async () => {
    const f = await fixture("invocation-alias")
    const alias = join(f.root, "alias")
    symlinkSync(f.linked, alias, "dir")
    const { run, calls } = runner(f)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, alias, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    expect(refusal(result)).toContain("worktree.invocationCwd")
    expect(calls).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  /**
   * The probe used to be asked from a surviving worktree, because a remote NAME only
   * resolves inside the repository that configures it. It is now given the identity the
   * landed worktree resolved, so it is asked from nowhere in particular on purpose:
   * any checkout it ran in could rewrite that URL through `url.<base>.insteadOf` and
   * send the question to another repository, whose answer would become a false
   * absence here. On GitHub it is a forge API read that runs no Git and is given no
   * directory; the URL-mode Git probe's directory is shown in forge-adapter.test.ts.
   */
  test("the remote-absence probe is asked outside every checkout", async () => {
    const f = await fixture("probe-cwd")
    const scripted = runner(f)
    const probes: { argv: string[]; cwd: string | undefined }[] = []
    const run: CliRunner = (argv, options) => {
      if (argv.includes("ls-remote") || argv.some((part) => part.includes("ref(qualifiedName"))) {
        probes.push({ argv: [...argv], cwd: options.cwd })
      }
      return scripted.run(argv, options)
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })

    expect(result.ok).toBe(true)
    expect(probes).toHaveLength(1)
    expect(probes[0]?.argv.slice(0, 3)).toEqual(["gh", "api", "graphql"])
    expect(probes[0]?.cwd).toBeUndefined()
  })
})

/**
 * The tool is registered, so no harness deadline applies: each bound is sized by the
 * work its command does. Cheap ref reads keep 5 s; a cold embedded store needs far
 * longer than that to answer `bd show`, and a removal stopped mid-way leaves a
 * half-deleted worktree.
 */
describe("delivery_cleanup command bounds and interrupts", () => {
  /** A command that never answers on its own: only its bound or an interrupt ends it. */
  const hang = (options: Parameters<CliRunner>[1]) => runCli(["sleep", "30"], options)

  test("each command is bounded by its work, and no mutation or bd read runs under the 5 s ref-read bound", async () => {
    const f = await fixture("bounds")
    // The bound each command was given is recorded; it then runs under a generous one,
    // so a loaded machine cannot trip the production bound this test reads back.
    const scripted = runner(f)
    const details: { argv: string[]; timeoutMs: number }[] = []
    const run: CliRunner = (argv, options) => {
      details.push({ argv: [...argv], timeoutMs: options.timeoutMs })
      return scripted.run(argv, { ...options, timeoutMs: Math.max(options.timeoutMs, 60_000) })
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, { run, now: () => NOW + 10, env: f.env })
    expect(result.ok).toBe(true)
    const bounds = (match: (argv: string[]) => boolean) =>
      details.filter((call) => match(call.argv)).map((call) => call.timeoutMs)
    expect(bounds((argv) => argv[0] === "bd")).toEqual([120_000])
    expect(bounds((argv) => argv[1] === "worktree" && argv[2] === "remove")).toEqual([600_000])
    expect(bounds((argv) => argv[1] === "branch" && argv[2] === "-d")).toEqual([600_000])
    expect(bounds((argv) => argv[1] === "status")).toEqual([60_000, 60_000])
    const refReads = bounds(
      (argv) =>
        argv[0] === "git" &&
        (["rev-parse", "rev-list", "show-ref", "remote"].includes(argv[1] ?? "") ||
          (argv[1] === "worktree" && argv[2] === "list")),
    )
    expect(refReads.length).toBeGreaterThan(0)
    expect(refReads.every((bound) => bound === CLEANUP_BOUNDS.refReadMs)).toBe(true)
    expect(CLEANUP_BOUNDS.refReadMs).toBe(5_000)
  })

  test("bounds.refReadMs replaces the ref-read bound on every ref read", async () => {
    const f = await fixture("configured-ref-read")
    const scripted = runner(f)
    const refReads: number[] = []
    const run: CliRunner = (argv, options) => {
      if (argv[0] === "git" && ["rev-parse", "rev-list", "show-ref", "remote"].includes(argv[1] ?? ""))
        refReads.push(options.timeoutMs)
      return scripted.run(argv, options)
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: { refReadMs: 61_000 },
    })
    expect(result.ok).toBe(true)
    expect(refReads.length).toBeGreaterThan(0)
    expect(refReads.every((bound) => bound === 61_000)).toBe(true)
  })

  test("bounds.refReadMs also bounds the repository identity reads", async () => {
    const f = await fixture("configured-repository-read")
    const reads: { argv: readonly string[]; timeoutMs: number }[] = []
    const git: GitRunner = (argv, cwd, timeoutMs) => {
      reads.push({ argv, timeoutMs })
      const proc = Bun.spawnSync(["git", ...SAFE_GIT_ARGS, ...argv], { cwd, env: process.env, stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
      return proc.exitCode === 0 ? proc.stdout.toString() : null
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run: runner(f).run,
      now: () => NOW + 10,
      env: f.env,
      bounds: { refReadMs: 61_000 },
      git,
    })
    expect(result.ok).toBe(true)
    // The repository key, the target's common directory (twice: before the reads and at
    // the boundary) and the canonical ledger root.
    expect(reads.map((read) => read.argv[0] === "rev-parse" && read.argv.at(-1))).toEqual([
      "--git-common-dir",
      "--show-toplevel",
      "--show-toplevel",
      "--show-toplevel",
    ])
    expect(reads.every((read) => read.timeoutMs === 61_000)).toBe(true)
  })

  test("a bd show that hangs past its bound reports the ledger step not done, and nothing is removed", async () => {
    const f = await fixture("hung-bd")
    const scripted = runner(f)
    const run: CliRunner = (argv, options) => (argv[0] === "bd" ? hang(options) : scripted.run(argv, options))
    const started = Date.now()
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: { ...HEAVY_FIXTURE_BOUNDS, bdShowMs: 300 },
    })
    expect(Date.now() - started).toBeLessThan(10_000)
    const reason = refusal(result)
    expect(reason.startsWith("beads: observed")).toBe(true)
    expect(reason).toContain("no exit status")
    expect(reason).toContain("killed by the 300ms timeout")
    expect(mutationCalls(scripted.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("an interrupt ends a hung read at once, long before its bound, and nothing is removed", async () => {
    const f = await fixture("interrupted-read")
    const scripted = runner(f)
    const controller = new AbortController()
    const run: CliRunner = (argv, options) => {
      if (argv[0] !== "bd") return scripted.run(argv, options)
      setTimeout(() => controller.abort(), 200)
      return hang(options)
    }
    const started = Date.now()
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      signal: controller.signal,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(refusal(result)).toContain("killed by an abort")
    expect(mutationCalls(scripted.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("an interrupt ends a hung repository key read, and nothing is removed", async () => {
    const f = await fixture("interrupted-key-read")
    // The git on PATH starts, then answers only once released, which this test does last.
    const bin = scratch("interrupted-key-read-bin")
    const started = join(bin, "started")
    const release = join(bin, "release")
    writeExecutable(join(bin, "git"), `#!/bin/sh\ntouch "${started}"\nwhile [ ! -e "${release}" ]; do sleep 0.01; done\n`)
    const controller = new AbortController()
    const abortOnceRunning = setInterval(() => {
      if (existsSync(started)) controller.abort()
    }, 5)
    const before = process.env.PATH
    process.env.PATH = `${bin}:${before ?? ""}`
    try {
      const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
        run: runner(f).run,
        now: () => NOW + 10,
        env: f.env,
        signal: controller.signal,
        bounds: { ...HEAVY_FIXTURE_BOUNDS, refReadMs: 600_000 },
      })
      expect(refusal(result).startsWith("repo.key: observed null")).toBe(true)
      expect(existsSync(f.linked)).toBe(true)
    } finally {
      clearInterval(abortOnceRunning)
      process.env.PATH = before
      writeFileSync(release, "")
    }
  })

  test("an interrupt observed after the last read refuses before the removal starts", async () => {
    const f = await fixture("interrupted-boundary")
    const scripted = runner(f)
    const controller = new AbortController()
    // The second `rev-list --count` is the last read before the removal, so the
    // abort lands where only the pre-removal check can observe it.
    let counts = 0
    const run: CliRunner = async (argv, options) => {
      const result = await scripted.run(argv, options)
      if (argv[1] === "rev-list" && ++counts === 2) controller.abort()
      return result
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      signal: controller.signal,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain("nothing was removed")
    expect(mutationCalls(scripted.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("an interrupt that arrives once the removal has started neither reaches it nor stops the steps after it", async () => {
    const f = await fixture("interrupted-removal")
    const scripted = runner(f)
    const controller = new AbortController()
    const signalled: { argv: string[]; signal: boolean }[] = []
    const run: CliRunner = (argv, options) => {
      signalled.push({ argv: [...argv], signal: options.signal !== undefined })
      if (argv[1] === "worktree" && argv[2] === "remove") controller.abort()
      return scripted.run(argv, options)
    }
    const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      signal: controller.signal,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(result.ok).toBe(true)
    expect(existsSync(f.linked)).toBe(false)
    const removal = signalled.findIndex((call) => call.argv[1] === "worktree" && call.argv[2] === "remove")
    expect(removal).toBeGreaterThan(0)
    expect(signalled.slice(0, removal).every((call) => call.signal)).toBe(true)
    expect(signalled.slice(removal).some((call) => call.signal)).toBe(false)
  })
})

describe("removalRoute", () => {
  const identity = (path: string) => path
  test.each([
    { name: "a listed directory goes to the host", listed: ["/r", "/w/a"], target: "/w/a", route: "host" },
    { name: "an unlisted directory goes to git", listed: ["/r", "/w/b"], target: "/w/a", route: "git" },
    { name: "an empty registry goes to git", listed: [] as string[], target: "/w/a", route: "git" },
  ])("$name", ({ listed, target, route }) => {
    expect(
      removalRoute(
        listed.map((directory) => ({ directory })),
        target,
        identity,
      ),
    ).toBe(route)
  })

  test("paths are compared after canonicalisation, so an alias still matches", () => {
    const canonical = (path: string) => path.replace("/alias", "/real")
    expect(removalRoute([{ directory: "/real/w" }], "/alias/w", canonical)).toBe("host")
  })
})

describe("delivery_cleanup host worktree registry", () => {
  /** A fake host registry that removes through git like the host's git strategy; it refuses on request. */
  function fakeHost(f: Fixture, registered: string[], refuse?: string) {
    const entries = new Set(registered)
    const removes: Array<{ directory: string }> = []
    return {
      removes,
      host: {
        list: async () => [...entries].map((directory) => ({ directory })),
        remove: async (directory: string) => {
          removes.push({ directory })
          if (refuse !== undefined) throw new Error(refuse)
          execFileSync("git", ["worktree", "remove", directory], { cwd: f.main })
          entries.delete(directory)
        },
      },
    }
  }

  test("a host-registered worktree is removed through the host, never by git, and leaves the registry", async () => {
    const f = await fixture("host-registered")
    const listedPath = realpathSync(f.linked)
    const fake = fakeHost(f, [listedPath])
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, { host: fake.host })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(fake.removes).toEqual([{ directory: listedPath }])
    expect(await fake.host.list()).toEqual([])
    expect(calls.filter((argv) => argv[1] === "worktree" && argv[2] === "remove")).toEqual([])
    expect(mutationCalls(calls)).toEqual([["git", "branch", "-d", "--", f.branch]])
    expect(existsSync(f.linked)).toBe(false)
    expect(result.receipt.worktree.removed).toBe(true)
    expect(result.receipt.proof.evidence).toMatchObject({ worktreeRegistration: "absent", worktreePath: "absent" })
  }, 60_000)

  test("a host whose listing fails leaves ownership unknown: refuse, remove nothing, no git fallback", async () => {
    const f = await fixture("host-list-fails")
    const host = {
      list: async () => {
        throw new Error("registry offline")
      },
      remove: async () => {
        throw new Error("must not be called")
      },
    }
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, { host })
    const reason = refusal(result)
    expect(reason).toContain("worktree.owner")
    expect(reason).toContain("registry offline")
    expect(reason).toContain("retry delivery_cleanup")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("an abort during the host listing stops the call before any removal", async () => {
    const f = await fixture("host-list-abort")
    const controller = new AbortController()
    const removes: string[] = []
    const host = {
      list: async () => {
        controller.abort()
        return [{ directory: realpathSync(f.linked) }]
      },
      remove: async (directory: string) => {
        removes.push(directory)
      },
    }
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, { host, signal: controller.signal })
    expect(refusal(result)).toContain("signal")
    expect(removes).toEqual([])
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("a worktree the host does not list is removed by git as before", async () => {
    const f = await fixture("host-unlisted")
    const listedPath = realpathSync(f.linked)
    const fake = fakeHost(f, [f.main])
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, { host: fake.host })
    expect(result.ok).toBe(true)
    expect(fake.removes).toEqual([])
    expect(mutationCalls(calls)[0]).toEqual(["git", "worktree", "remove", listedPath])
  }, 60_000)

  test("a host refusal is reported and neither forced nor retried with git", async () => {
    const f = await fixture("host-refuses")
    const fake = fakeHost(f, [realpathSync(f.linked)], "worktree contains modified files")
    const { result, calls } = await invoke(f, { receipt: f.receiptPath }, {}, { host: fake.host })
    const reason = refusal(result)
    expect(reason).toContain("worktree.removed")
    expect(reason).toContain("worktree contains modified files")
    expect(mutationCalls(calls)).toEqual([])
    expect(calls.flat()).not.toContain("--force")
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)
})

/** The options every checkout-bound Git command must carry, spelled out and independent of the source constant. */
const EXPECTED_SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-optional-locks"]

describe("the Git start check", () => {
  // The containment the two "no Git ran in the target" checks below rely on.
  const session = () => fixture("selector-session")
  const start = (cwd: string, argv: string[], env: Partial<Pick<GitSpawn, "gitDir" | "workTree" | "commonDir">> = {}): GitSpawn => ({
    cwd,
    gitDir: env.gitDir ?? "",
    workTree: env.workTree ?? "",
    commonDir: env.commonDir ?? "",
    argv,
  })

  test("a start that selects only the allowed checkout is inside it", async () => {
    const { main } = await session()
    const pinned = start(main, [...SAFE_GIT_ARGS, "-C", ".", "--git-dir=.git", "status"], { gitDir: ".git", workTree: main })
    expect(outside([pinned], main)).toEqual([])
  })

  test.each([
    ["-C", (target: string) => ["-C", target, "rev-parse", "--git-dir"], {}],
    ["--git-dir as a separate word", (target: string) => ["--git-dir", join(target, ".git"), "rev-parse"], {}],
    ["--git-dir=", (target: string) => [`--git-dir=${join(target, ".git")}`, "rev-parse"], {}],
    ["--work-tree=", (target: string) => [`--work-tree=${target}`, "status"], {}],
    ["-C after -c", (target: string) => [...SAFE_GIT_ARGS, "-C", target, "status"], {}],
  ] as const)("a start from the allowed directory that selects the target through %s is outside", async (_name, argv) => {
    const { main, linked } = await session()
    expect(outside([start(main, argv(linked))], main)).toHaveLength(1)
  })

  test("an environment path that only spells the allowed root before a .. is outside", async () => {
    const { main, linked } = await session()
    const lexical = `${main}/../${basename(linked)}`
    expect(lexical.startsWith(`${main}/`)).toBe(true)
    for (const env of [{ gitDir: `${lexical}/.git` }, { workTree: lexical }, { commonDir: `${main}/../${basename(main)}x` }])
      expect(outside([start(main, ["status"], env)], main)).toHaveLength(1)
  })

  test("a symlink inside the allowed checkout followed by .. into a foreign repository is outside", async () => {
    const { main, linked } = await session()
    // `<main>/link` -> `<linked>/sub`, so `<main>/link/..` is `<linked>`, not `<main>`.
    mkdirSync(join(linked, "sub"))
    symlinkSync(join(linked, "sub"), join(main, "escape-link"))
    const through = `${main}/escape-link/..`
    const cases: [string, GitSpawn][] = [
      ["-C", start(main, ["-C", through, "status"])],
      ["-C relative", start(main, ["-C", "escape-link/..", "status"])],
      ["--git-dir=", start(main, [`--git-dir=${through}/.git`, "status"])],
      ["--work-tree=", start(main, [`--work-tree=${through}`, "status"])],
      ["GIT_DIR", start(main, ["status"], { gitDir: `${through}/.git` })],
      ["GIT_WORK_TREE", start(main, ["status"], { workTree: through })],
      ["GIT_COMMON_DIR", start(main, ["status"], { commonDir: `${through}/.git` })],
    ]
    for (const [name, spawn] of cases) expect([name, outside([spawn], main).length]).toEqual([name, 1])
  })

  test("argv after the subcommand is not a repository selector", async () => {
    const { main, linked } = await session()
    expect(outside([start(main, ["log", "-C", linked])], main)).toEqual([])
  })
})

describe("delivery_cleanup fails closed on another repository", () => {
  const selectors = [
    ["the receipt path", (f: Fixture): DeliveryCleanupParams => ({ receipt: f.receiptPath })],
    ["the worktree", (f: Fixture): DeliveryCleanupParams => ({ pr: 17, worktree: f.linked })],
  ] as const
  const hosts = [
    ["without a host registry", undefined],
    [
      "with a host registry",
      {
        list: async () => [],
        remove: async () => {
          throw new Error("the host remover must not be called")
        },
      },
    ],
  ] as const

  describe.each(selectors)("selected by %s", (_selector, params) => {
    test.each(hosts)("%s: refused before any Git process runs in the target", async (_name, host) => {
      const f = await fixture("foreign-target")
      const session = await fixture("foreign-session")
      const { markers } = hostileConfig(f)
      // Sanity: the same hostile checkout does run its programs under plain Git.
      execFileSync("git", ["status", "--porcelain"], {
        cwd: f.linked,
        env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
      })
      expect(ranMarkers(markers)).toEqual(expect.arrayContaining(["fsmonitor", "included", "process"]))
      for (const marker of Object.values(markers)) rmSync(marker, { force: true })

      const spawns = gitSpawnLog()
      const scripted = runner(f, {})
      try {
        const result = await cleanupDelivery(params(f), session.main, {
          run: scripted.run,
          now: () => NOW + 10,
          env: f.env,
          bounds: HEAVY_FIXTURE_BOUNDS,
          ...(host === undefined ? {} : { host }),
        })
        const reason = refusal(result)
        expect(reason).toContain("worktree.owner")
        expect(reason).toContain("from a session in that repository")
        // Every Git start, not only those found in the target: each ran in the session's repository.
        const log = spawns.log()
        expect(log.length).toBeGreaterThan(0)
        expect(outside(log, session.main)).toEqual([])
      } finally {
        spawns.restore()
      }
      expect(ranMarkers(markers)).toEqual([])
      expect(scripted.details.filter((call) => call.cwd !== undefined && call.cwd !== session.main)).toEqual([])
      expect(mutationCalls(scripted.calls)).toEqual([])
      expect(existsSync(f.linked)).toBe(true)
    }, 60_000)
  })
})

describe("delivery_cleanup on a repository other than the session's, named explicitly", () => {
  const SESSION_URL = "https://github.com/other/session.git\n"

  /** Cleanup run from `session`, whose own remote names another repository than the fixture's `owner/repo`. */
  async function cleanupFrom(f: Fixture, session: Fixture, params: DeliveryCleanupParams) {
    const scripted = runner(f, {})
    const run: CliRunner = (argv, options) =>
      argv[0] === "git" && argv.slice(-3, -1).join(" ") === "remote get-url" && options.cwd === session.main
        ? Promise.resolve(success(SESSION_URL))
        : scripted.run(argv, options)
    const result = await cleanupDelivery(params, session.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    return { result, calls: scripted.calls, details: scripted.details }
  }

  test.each([
    ["repoPath", (f: Fixture): DeliveryCleanupParams => ({ receipt: f.receiptPath, repo: "owner/repo", repoPath: f.main })],
    ["a worktree of the target", (f: Fixture): DeliveryCleanupParams => ({ pr: 17, worktree: f.linked, repo: "owner/repo" })],
  ])("refuses another repository's cleanup named through %s, removing nothing", async (_label, params) => {
    const f = await fixture("explicit-refused")
    const session = await fixture("explicit-refused-session")
    const { result, calls } = await cleanupFrom(f, session, params(f))
    const reason = refusal(result)
    expect(reason).toContain('repo: observed "owner/repo"')
    expect(reason).toContain(`run delivery_cleanup from a session in ${realpathSync(f.main)}`)
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
    expect(existsSync(session.linked)).toBe(true)
  })

  test("refuses another repository without a clone, naming worktree and repoPath", async () => {
    const f = await fixture("explicit-none")
    const session = await fixture("explicit-none-session")
    const { result, calls } = await cleanupFrom(f, session, { receipt: f.receiptPath, repo: "owner/repo" })
    const reason = refusal(result)
    expect(reason).toContain("`repoPath`")
    expect(reason).toContain("`worktree`")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("refuses a clone whose remote names a different repository", async () => {
    const f = await fixture("explicit-mismatch")
    const session = await fixture("explicit-mismatch-session")
    const { result, calls } = await cleanupFrom(f, session, { receipt: f.receiptPath, repo: "owner/elsewhere", repoPath: f.main })
    expect(refusal(result)).toContain('expected one naming "owner/elsewhere"')
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })
})

describe("delivery_cleanup with two remotes naming different repositories", () => {
  // `origin` is the receipt's repository (owner/repo); `upstream` is another one.
  const UPSTREAM = "upstream-owner/upstream-repo"
  const remotes = { origin: "https://github.com/owner/repo.git", upstream: `https://github.com/${UPSTREAM}.git` }

  async function twoRemotes(name: string): Promise<Fixture> {
    const f = await fixture(name)
    git(f.main, ["remote", "add", "upstream", remotes.upstream])
    return f
  }

  test.each([
    ["an explicit receipt", (f: Fixture): DeliveryCleanupParams => ({ receipt: f.receiptPath, repo: UPSTREAM })],
    ["a pull request number", (_f: Fixture): DeliveryCleanupParams => ({ pr: 17, repo: UPSTREAM })],
    ["no other selector", (_f: Fixture): DeliveryCleanupParams => ({ repo: UPSTREAM })],
  ])("refuses a receipt of the other remote's repository, selected by %s", async (_label, params) => {
    const f = await twoRemotes("two-remotes-session")
    const { result, calls } = await invoke(f, params(f), { remotes })
    expect(result.ok).toBe(false)
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("refuses it when the named clone is retargeted from another session, issuing no mutation", async () => {
    const f = await twoRemotes("two-remotes-retargeted")
    const session = await fixture("two-remotes-retargeted-session")
    const scripted = runner(f, { remotes })
    const run: CliRunner = (argv, options) =>
      argv[0] === "git" && argv.slice(-3, -1).join(" ") === "remote get-url" && options.cwd === session.main
        ? Promise.resolve(success("https://github.com/other/session.git\n"))
        : scripted.run(argv, options)
    const result = await cleanupDelivery({ receipt: f.receiptPath, repo: UPSTREAM, repoPath: f.main }, session.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain(`repo: observed ${JSON.stringify(UPSTREAM)}`)
    expect(mutationCalls(scripted.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("cleans the receipt when the requested repo is the receipt's own", async () => {
    const f = await twoRemotes("two-remotes-match")
    const { result } = await invoke(f, { receipt: f.receiptPath, repo: "owner/repo" }, { remotes })
    expect(result.ok).toBe(true)
    expect(existsSync(f.linked)).toBe(false)
  }, 60_000)
})

describe("delivery_cleanup reads the target's beads, not the session's", () => {
  const PIN = {
    BEADS_DIR: "/session/.beads",
    BEADS_DB: "/session/db",
    BD_DB: "/session/bd-db",
    BD_SOCKET: "/session/sock",
    BEADS_DOLT_SHARED_SERVER: "1",
    HARNESS_BEADS_PIN: "/session/.beads",
  }

  /** A bd that answers by which ledger it would open: a pinned or foreign-cwd read is the session's. */
  function twoLedgers(f: Fixture, session: string, target: string): { run: CliRunner; details: RecordedCall[] } {
    const root = realpathSync(f.main)
    const scripted = runner(f, {})
    const run: CliRunner = (argv, options) => {
      if (argv[0] !== "bd") return scripted.run(argv, options)
      scripted.details.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env })
      const pinned = options.env?.BEADS_DIR !== undefined
      const status = !pinned && options.cwd === root ? target : session
      const data = [{ id: "delivery-17", status, metadata: { merge_sha: f.merge } }]
      return Promise.resolve(success(JSON.stringify({ schema_version: 1, data })))
    }
    return { run, details: scripted.details }
  }

  async function fromSubdirectory(f: Fixture, session: string, target: string, env: NodeJS.ProcessEnv) {
    const sub = join(f.main, "sub")
    mkdirSync(sub, { recursive: true })
    const { run, details } = twoLedgers(f, session, target)
    const result = await cleanupDelivery({ receipt: f.receiptPath }, sub, {
      run,
      now: () => NOW + 10,
      env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    return { result, details }
  }

  test("reads from the target root with every session pin variable removed", async () => {
    const f = await fixture("bd-env")
    const { result, details } = await fromSubdirectory(f, "closed", "closed", { ...f.env, ...PIN })
    expect(result.ok).toBe(true)
    const shows = details.filter((call) => call.argv[0] === "bd")
    expect(shows).toHaveLength(1)
    expect(shows[0]?.cwd).toBe(realpathSync(f.main))
    for (const name of Object.keys(PIN)) expect(shows[0]?.env?.[name]).toBeUndefined()
    expect(shows[0]?.env?.BD_NON_INTERACTIVE).toBe("1")
  }, 60_000)

  test("decides on the target's ledger when the session's says open and the target's says closed", async () => {
    const f = await fixture("bd-session-open")
    const { result } = await fromSubdirectory(f, "open", "closed", { ...f.env, ...PIN })
    expect(result.ok).toBe(true)
    expect(existsSync(f.linked)).toBe(false)
  }, 60_000)

  test("refuses on the target's ledger when the session's says closed and the target's says open", async () => {
    const f = await fixture("bd-session-closed")
    const { result } = await fromSubdirectory(f, "closed", "open", { ...f.env, ...PIN })
    expect(refusal(result)).toContain("beads.delivery-17.status")
    expect(existsSync(f.linked)).toBe(true)
  })
})

describe("delivery_cleanup Git options in its own repository", () => {
  /** Cleanup with the real Git behind the runner, raw argv included, so overrides actually take effect. */
  function realGitRunner(f: Fixture): { run: CliRunner; raw: string[][] } {
    const scripted = runner(f, {})
    const raw: string[][] = []
    const run: CliRunner = (argv, options) => {
      if (argv[0] === "git") raw.push([...argv])
      const verb = withoutSafeGit(argv)
      if (verb[0] !== "git" || verb[1] === "remote" || verb.includes("ls-remote")) return scripted.run(verb, options)
      return runCli(argv, options)
    }
    return { run, raw }
  }

  test("every checkout-bound Git command carries the literal safe options", async () => {
    const f = await fixture("safe-literal")
    const { run, raw } = realGitRunner(f)
    const result = await cleanupDeliveryUnwrapped({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(result.ok).toBe(true)
    const bound = raw.filter((argv) => !argv.includes("ls-remote"))
    expect(bound.some((argv) => argv.includes("status"))).toBe(true)
    for (const argv of bound) expect(argv.slice(0, 1 + EXPECTED_SAFE_GIT.length)).toEqual(["git", ...EXPECTED_SAFE_GIT])
  }, 60_000)

  test("hooks and filter drivers of the checkout do not run during a full cleanup", async () => {
    const f = await fixture("safe-hooks")
    const { markers } = hostileConfig(f)
    for (const marker of Object.values(markers)) rmSync(marker, { force: true }) // setup reads may have fired some
    const { run } = realGitRunner(f)
    const result = await cleanupDeliveryUnwrapped({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    // The attribute-selected filter driver is not covered by the options; the hooks and
    // the fsmonitor are. This is the session's own repository, which it already trusts.
    expect(result.ok).toBe(true)
    for (const name of ["fsmonitor", "hook-post-checkout", "hook-reference-transaction", "hook-post-index-change"]) {
      expect(existsSync(markers[name] ?? "")).toBe(false)
    }
    // Sanity: plain Git does fire the reference-transaction hook for the same kind of write.
    git(f.main, ["update-ref", "refs/heads/zz-sanity", "HEAD"])
    expect(existsSync(markers["hook-reference-transaction"] ?? "")).toBe(true)
  }, 60_000)

  test("a refused cleanup leaves the index byte-identical", async () => {
    const f = await fixture("safe-index")
    const indexPath = join(git(f.linked, ["rev-parse", "--absolute-git-dir"]), "index")
    const tracked = git(f.linked, ["ls-files"]).split("\n")[0] ?? ""
    writeFileSync(join(f.linked, tracked), readFileSync(join(f.linked, tracked)))
    writeFileSync(join(f.linked, "untracked.txt"), "dirty\n")
    const before = readFileSync(indexPath)
    const { run } = realGitRunner(f)
    const result = await cleanupDeliveryUnwrapped({ receipt: f.receiptPath }, f.main, {
      run,
      now: () => NOW + 10,
      env: f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
    })
    expect(refusal(result)).toContain("worktree.status")
    expect(readFileSync(indexPath).equals(before)).toBe(true)
    // Sanity: plain `git status` refreshes the stat-dirty entry, so the check above can fail.
    git(f.linked, ["status", "--porcelain"])
    expect(readFileSync(indexPath).equals(before)).toBe(false)
  }, 60_000)
})

describe("delivery_cleanup pins Git to the verified worktree", () => {
  test("a marker swapped after verification does not redirect Git", async () => {
    const f = await fixture("pinned-swap")
    const foreign = await fixture("pinned-swap-foreign")
    const { markers } = hostileConfig(foreign)
    for (const marker of Object.values(markers)) rmSync(marker, { force: true })
    let swapped = false
    const { result, details } = await invoke(
      f,
      { receipt: f.receiptPath },
      {
        before: (argv) => {
          if (swapped || argv[1] !== "status") return
          swapped = true
          writeFileSync(join(f.linked, ".git"), readFileSync(join(foreign.linked, ".git")))
        },
      },
    )
    expect(swapped).toBe(true)
    // The first status ran after the swap, yet against the verified repository: its env pins
    // the session's admin directory and the worktree, so the changed marker was never consulted.
    const status = details.find((call) => call.argv.includes("status"))
    expect(status?.env?.GIT_DIR?.startsWith(join(f.main, ".git", "worktrees"))).toBe(true)
    expect(status?.env?.GIT_WORK_TREE).toBe(f.linked)
    expect(status?.env?.GIT_COMMON_DIR).toBe(join(f.main, ".git"))
    // The next verification reads the swapped marker and refuses before the removal.
    expect(refusal(result)).toContain("worktree.marker")
    expect(ranMarkers(markers)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("the removal and branch deletion run pinned to a verified main worktree", async () => {
    const f = await fixture("pinned-exec")
    const { result, details } = await invoke(f)
    expect(result.ok).toBe(true)
    for (const verb of [["worktree", "remove"], ["branch", "-d"]]) {
      const call = details.find((entry) => entry.argv.includes(verb[0] as string) && entry.argv.includes(verb[1] as string))
      expect(call?.env?.GIT_DIR).toBe(join(f.main, ".git"))
      expect(call?.env?.GIT_WORK_TREE).toBe(f.main)
    }
  }, 60_000)
})

describe("delivery_cleanup resolves the target path once", () => {
  test("a symlinked parent switched between steps cannot move any step to another tree", async () => {
    const f = await fixture("resolve-once")
    const foreign = await fixture("resolve-once-foreign")
    const alias = join(scratch("alias"), "parent")
    symlinkSync(f.root, alias, "dir")
    const viaAlias = join(alias, basename(f.linked))
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      worktree: { path: viaAlias, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: f.receipt,
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
    let switched = false
    const { result, details } = await invoke(
      f,
      { receipt: path },
      {
        before: (argv) => {
          if (switched || argv[1] !== "status") return
          switched = true
          rmSync(alias)
          symlinkSync(foreign.root, alias, "dir")
        },
      },
    )
    expect(switched).toBe(true)
    // Every command run in the target used the one physical path, never the alias.
    const inTarget = details.filter((call) => call.cwd !== undefined && call.cwd !== f.main && call.argv[0] === "git")
    expect(inTarget.length).toBeGreaterThan(0)
    for (const call of inTarget) {
      expect(call.cwd).toBe(f.linked)
      expect(call.env?.GIT_WORK_TREE).toBe(f.linked)
    }
    expect(details.some((call) => call.cwd?.includes(alias) === true)).toBe(false)
    // The next verification resolves the receipt path afresh and no longer finds a registered worktree.
    expect(refusal(result)).toContain("worktree.")
    expect(mutationCalls(details.map((call) => call.argv))).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 60_000)

  test("a receipt path that does not resolve is treated as already gone and no Git runs in it", async () => {
    const f = await fixture("resolve-missing")
    const receipt = buildReceipt({
      ...f.receipt,
      now: NOW + 1,
      worktree: { path: join(f.root, "missing"), removed: false, localRefDeleted: false, absenceVerifiedAt: null },
      continues: f.receipt,
    })
    const path = writeReceipt(receipt, receiptDirectory(f.env, receipt.repo.key))
    const { result, details } = await invoke(f, { receipt: path })
    if (!result.ok) throw new Error(result.reason)
    expect(result.alreadyCleaned).toBe(true)
    expect(details.filter((call) => call.cwd === join(f.root, "missing"))).toEqual([])
  }, 60_000)
})

describe("delivery_cleanup refuses a registered worktree whose directory is not this repository's", () => {
  /** Each way the directory behind an intact registration can stop belonging to the session repository. */
  const replacements: Array<[string, (f: Fixture, foreign: Fixture) => void]> = [
    [
      ".git replaced by a symlink to another repository",
      (f, foreign) => {
        rmSync(join(f.linked, ".git"))
        symlinkSync(join(foreign.main, ".git"), join(f.linked, ".git"))
      },
    ],
    [
      ".git file naming another repository's worktree admin directory",
      (f, foreign) => {
        writeFileSync(join(f.linked, ".git"), readFileSync(join(foreign.linked, ".git")))
      },
    ],
    [
      "directory replaced by another repository's checkout",
      (f, foreign) => {
        rmSync(f.linked, { recursive: true, force: true })
        cpSync(foreign.main, f.linked, { recursive: true })
      },
    ],
    [
      ".git whose gitdir has a leading blank, so Git reads it as a relative name inside the target",
      (f, foreign) => {
        const admin = /^gitdir: (.+)$/m.exec(readFileSync(join(foreign.linked, ".git"), "utf8"))?.[1] ?? ""
        mkdirSync(join(f.linked, ` ${admin}`), { recursive: true })
        writeFileSync(join(f.linked, ` ${admin}`, "commondir"), `${join(f.main, ".git")}\n`)
        writeFileSync(join(f.linked, ".git"), `gitdir:  ${admin}\n`)
      },
    ],
    [
      ".git replaced by a FIFO",
      (f) => {
        rmSync(join(f.linked, ".git"))
        Bun.spawnSync(["mkfifo", join(f.linked, ".git")])
      },
    ],
    [
      "gitdir whose commondir is a FIFO",
      (f) => {
        const evil = scratch("evil-gitdir")
        Bun.spawnSync(["mkfifo", join(evil, "commondir")])
        writeFileSync(join(f.linked, ".git"), `gitdir: ${evil}\n`)
      },
    ],
    [
      "gitdir whose commondir is a symlink to a FIFO",
      (f) => {
        const evil = scratch("evil-gitdir")
        const fifo = join(scratch("fifo"), "pipe")
        Bun.spawnSync(["mkfifo", fifo])
        symlinkSync(fifo, join(evil, "commondir"))
        writeFileSync(join(f.linked, ".git"), `gitdir: ${evil}\n`)
      },
    ],
  ]

  test.each(replacements)("%s", async (_name, replace) => {
    const f = await fixture("marker-target")
    const foreign = await fixture("marker-foreign")
    const { markers } = hostileConfig(foreign)
    for (const marker of Object.values(markers)) rmSync(marker, { force: true })
    replace(f, foreign)

    const spawns = gitSpawnLog()
    const scripted = runner(f, {})
    try {
      const result = await cleanupDelivery({ receipt: f.receiptPath }, f.main, {
        run: scripted.run,
        now: () => NOW + 10,
        env: f.env,
        bounds: HEAVY_FIXTURE_BOUNDS,
      })
      expect(refusal(result)).toContain("worktree.marker")
      // Every Git start, not only those found in the target: each ran in the session's own checkout.
      const log = spawns.log()
      expect(log.length).toBeGreaterThan(0)
      expect(outside(log, f.main)).toEqual([])
    } finally {
      spawns.restore()
    }
    expect(ranMarkers(markers)).toEqual([])
    expect(scripted.details.filter((call) => call.cwd === f.linked)).toEqual([])
    expect(mutationCalls(scripted.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  }, 30_000)
})

/**
 * The host has every session that reports through the idle hook: a report whose own session the host does
 * not have is skipped as a dead reporter's, so a session that reports must exist (a test that wants it
 * gone deletes it from `fake.sessions`).
 */
function hostHasReporters(fake: ReturnType<typeof createFakeContext>, directory: string) {
  const fire = fake.fire.session
  fake.fire.session = ((name: string, input: unknown) => {
    const id = (input as { sessionID?: unknown } | undefined)?.sessionID
    if (name === "experimental.idle" && typeof id === "string" && !fake.sessions.has(id)) fake.sessions.set(id, { id, location: { directory } })
    return fire(name as never, input as never)
  }) as typeof fake.fire.session
}

describe("pending cleanup: one remover per worktree", () => {
  type Harness = Awaited<ReturnType<typeof harness>>
  async function harness(
    name: string,
    over: {
      beadStatus?: string
      maxPerPass?: number
      list?: (query: Record<string, unknown>) => Promise<unknown>
      before?: RunnerOptions["before"]
      after?: RunnerOptions["after"]
      hook?: boolean
      bounds?: Partial<CleanupBounds>
      observe?: GitRunner
      lock?: Record<string, unknown>
      sessionLookupMs?: number
      idlePassMs?: number
      disposeWaitMs?: number
      bound?: (ms: number) => Promise<void>
      retryAt?: ReadonlyArray<"pass" | "check" | "idle">
      /** The host's worktree registry (default: none, so git removes). */
      host?: HostWorktrees
      /** Prime the repository cache as `setupDelivery` does (default); false leaves it cold. */
      prime?: boolean
    } = {},
  ) {
    const f = await fixture(name)
    const options: RunnerOptions = { beadStatus: over.beadStatus ?? "closed", ...(over.before ? { before: over.before } : {}), ...(over.after ? { after: over.after } : {}) }
    const scripted = runner(f, options)
    const fake = createFakeContext({ directory: f.main })
    hostHasReporters(fake, f.main)
    if (over.list) (fake.context.session as unknown as { list: unknown }).list = over.list
    if (over.hook === false) {
      const session = fake.context.session as unknown as { hook: (name: string, callback: unknown) => Promise<unknown> }
      const original = session.hook.bind(session)
      session.hook = (hookName, callback) =>
        hookName === "experimental.idle" ? Promise.reject(new Error("unknown hook")) : original(hookName, callback)
    }
    let clock = NOW + 10
    const pending = createPendingCleanup({
      ctx: fake.context,
      cwd: f.main,
      env: f.env,
      host: () => over.host,
      debounceMs: 1,
      watch: { sleep: async () => {} },
      ...(over.maxPerPass === undefined ? {} : { maxPerPass: over.maxPerPass }),
      cleanup: { run: stripped(scripted.run), now: () => NOW + 10, bounds: over.bounds ?? HEAVY_FIXTURE_BOUNDS },
      now: () => clock,
      // Reports expire on their files' real mtimes; `advance` moves this clock the same way it moves `now`.
      fileNow: () => Date.now() + (clock - (NOW + 10)),
      ...(over.observe === undefined ? {} : { observe: over.observe }),
      ...(over.lock === undefined ? {} : { lock: over.lock }),
      ...(over.sessionLookupMs === undefined ? {} : { sessionLookupMs: over.sessionLookupMs }),
      ...(over.idlePassMs === undefined ? {} : { idlePassMs: over.idlePassMs }),
      ...(over.disposeWaitMs === undefined ? {} : { disposeWaitMs: over.disposeWaitMs }),
      ...(over.bound === undefined ? {} : { bound: over.bound }),
      ...(over.retryAt === undefined ? {} : { retryAt: over.retryAt }),
    })
    if (over.prime !== false) await pending.prime()
    const common = (await repositoryContext(f.main))?.commonDir as string
    const advance = (ms: number) => {
      clock += ms
    }
    const idle = async (sessionID = "ses_lead") => {
      fake.emit({ type: "session.idle", data: { sessionID } })
      await pending.settle()
    }
    const claim = () =>
      writeClaim(common, { directory: f.linked, branch: f.branch, sessionID: "ses_child", parentID: "ses_lead", createdAt: 1 })
    const finish = async () => {
      await pending.dispose()
      rmSync(f.root, { recursive: true, force: true })
    }
    return { f, options, scripted, fake, pending, common, advance, idle, claim, finish }
  }
  const removed = (h: Harness) => !existsSync(h.f.linked)
  const synthetic = (h: Harness) => h.fake.calls.filter((entry) => entry.method === "session.synthetic")

  test("a receipt landed with beads open is nudged once; after the beads close, the next idle removes the worktree", async () => {
    const h = await harness("pending-retry", { beadStatus: "open" })
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    await h.idle()
    expect(synthetic(h)).toHaveLength(1)
    expect(JSON.stringify(synthetic(h)[0]?.input)).toContain("Landed PR #17: close beads delivery-17")
    await h.idle()
    expect(synthetic(h)).toHaveLength(1)
    expect(removed(h)).toBe(false)
    h.options.beadStatus = "closed"
    h.advance(60_000)
    await h.idle()
    expect(removed(h)).toBe(true)
    expect(readLanding(h.common, h.f.receipt.receiptId)).toEqual({ kind: "missing" })
    await h.finish()
  })

  test("a lane's claim keeps delivery from removing the worktree, however many turns end", async () => {
    const h = await harness("pending-claimed")
    await h.pending.record(h.f.receipt, "ses_lead")
    h.claim()
    await h.pending.start()
    await h.idle()
    h.advance(60_000)
    await h.idle()
    expect(removed(h)).toBe(false)
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    expect(readLanding(h.common, h.f.receipt.receiptId).kind).toBe("present")
    await h.finish()
  })

  test("an unreadable claim is not 'no claim': delivery keeps the worktree", async () => {
    const h = await harness("pending-claim-corrupt")
    await h.pending.record(h.f.receipt, "ses_lead")
    mkdirSync(dirname(claimFile(h.common, h.f.linked)), { recursive: true })
    writeFileSync(claimFile(h.common, h.f.linked), "{not json")
    await h.pending.start()
    await h.idle()
    expect(removed(h)).toBe(false)
    await h.finish()
  })

  test("a lane claimed after delivery's snapshot is not removed: ownership is checked again before the removal", async () => {
    let claimed = false
    let h: Harness | undefined
    h = await harness("pending-claimed-late", {
      before: (argv) => {
        if (argv.includes("status") && !claimed) {
          claimed = true
          h?.claim()
        }
      },
    })
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    await h.idle()
    expect(claimed).toBe(true)
    expect(removed(h)).toBe(false)
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    await h.finish()
  })

  test("a denial written after the snapshot blocks the removal at the last check", async () => {
    let written = false
    let h: Harness | undefined
    h = await harness("pending-denied-late", {
      before: (argv) => {
        if (argv.includes("status") && !written && h) {
          written = true
          writeLanding(h.common, {
            receiptId: h.f.receipt.receiptId,
            worktree: h.f.linked,
            headRefOid: h.f.head,
            sessionID: "ses_lead",
            landedAt: 1,
            denied: { at: 2, sessionID: "ses_lead" },
          })
        }
      },
    })
    await h.pending.start()
    await h.idle()
    expect(written).toBe(true)
    expect(removed(h)).toBe(false)
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    await h.finish()
  })

  test("a landing record that cannot be read blocks the removal at the last check", async () => {
    let written = false
    let h: Harness | undefined
    h = await harness("pending-record-corrupt-late", {
      before: (argv) => {
        if (argv.includes("status") && !written && h) {
          written = true
          mkdirSync(dirname(landingFile(h.common, "9-bad")), { recursive: true })
          writeFileSync(landingFile(h.common, "9-bad"), "garbage")
        }
      },
    })
    await h.pending.start()
    await h.idle()
    expect(written).toBe(true)
    expect(removed(h)).toBe(false)
    await h.finish()
  })

  test("once the claim is gone the same receipt is removed", async () => {
    const h = await harness("pending-claim-released")
    await h.pending.record(h.f.receipt, "ses_lead")
    h.claim()
    await h.pending.start()
    await h.idle()
    expect(removed(h)).toBe(false)
    removeClaim(h.common, h.f.linked)
    h.advance(60_000)
    await h.idle()
    expect(removed(h)).toBe(true)
    await h.finish()
  })

  describe("denials", () => {
    test("a denied cleanup is not retried in the background", async () => {
      const h = await harness("pending-denied")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    test("a refused explicit call keeps (and renews) the denial; idle still removes nothing", async () => {
      const h = await harness("pending-denied-again")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      const first = readLanding(h.common, h.f.receipt.receiptId)
      h.advance(60_000)
      await expect(
        authorizeExplicit(h.pending, async () => {
          throw new Error("denied by the user")
        }, "ses_lead", { worktree: h.f.linked }),
      ).rejects.toThrow("denied by the user")
      const second = readLanding(h.common, h.f.receipt.receiptId)
      expect(second.kind === "present" && second.value.denied !== undefined).toBe(true)
      expect(second.kind === "present" && first.kind === "present" && (second.value.denied?.at ?? 0) > (first.value.denied?.at ?? 0)).toBe(true)
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("a refused explicit call on a receipt with no record yet creates the denial", async () => {
      const h = await harness("pending-denied-fresh")
      await expect(
        authorizeExplicit(h.pending, async () => {
          throw new Error("no")
        }, "ses_lead", { worktree: h.f.linked }),
      ).rejects.toThrow("no")
      expect(readLanding(h.common, h.f.receipt.receiptId)).toMatchObject({ kind: "present", value: { denied: { sessionID: "ses_lead" } } })
      await h.finish()
    })

    test("an authorized explicit call re-arms it, and the next idle removes the worktree", async () => {
      const h = await harness("pending-rearmed")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      await authorizeExplicit(h.pending, async () => {}, "ses_lead", { worktree: h.f.linked })
      expect(readLanding(h.common, h.f.receipt.receiptId)).toMatchObject({ kind: "present" })
      const record = readLanding(h.common, h.f.receipt.receiptId)
      expect(record.kind === "present" && record.value.denied).toBeFalsy()
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })
  })

  describe("it fails closed on who is in the worktree", () => {
    const clear = (query: Record<string, unknown>) =>
      Promise.resolve(
        query.cursor === undefined
          ? { data: [{ id: "old", time: { busy: 1, idle: 2 } }], cursor: { next: "p2" } }
          : { data: [{ id: "older", time: { busy: 1, idle: 2 } }] },
      )

    test("a lookup error holds the worktree", async () => {
      const h = await harness("pending-list-error", {
        list: async () => {
          throw new Error("boom")
        },
      })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    test("an owner on the second page holds the worktree", async () => {
      const h = await harness("pending-page-two", {
        list: async (query) =>
          query.cursor === undefined
            ? { data: [{ id: "old", time: { busy: 1, idle: 2 } }], cursor: { next: "p2" } }
            : { data: [{ id: "live", time: { busy: 9, idle: 2 } }] },
      })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("with every page read and no owner the worktree is removed", async () => {
      const h = await harness("pending-page-clear", { list: clear })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })
  })

  test("without the experimental.idle hook the events still retry", async () => {
    const h = await harness("pending-no-hook", { hook: false })
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    expect(h.fake.hooks("session")).not.toContain("experimental.idle")
    h.fake.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_lead" } })
    await h.pending.settle()
    expect(removed(h)).toBe(true)
    await h.finish()
  })

  test("a closed event stream is resubscribed and the next event still retries", async () => {
    const h = await harness("pending-resubscribe", { hook: false })
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    const subscriptions = () => h.fake.calls.filter((entry) => entry.method === "event.subscribe").length
    expect(subscriptions()).toBe(1)
    h.fake.closeEvents()
    while (subscriptions() < 2) await new Promise((done) => setTimeout(done, 0))
    h.fake.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_lead" } })
    await h.pending.settle()
    expect(removed(h)).toBe(true)
    await h.finish()
  })

  test("receipts that need no attempt do not starve one that does", async () => {
    const h = await harness("pending-window", { maxPerPass: 1 })
    const key = (await repoKey(h.f.main)) as string
    const parked = join(h.f.root, "parked worktree")
    mkdirSync(parked)
    const newer = buildReceipt({
      now: NOW + 5000,
      emitter: h.f.receipt.emitter,
      repo: h.f.receipt.repo,
      pr: { ...h.f.receipt.pr, number: 18 },
      branch: { ...h.f.receipt.branch, name: "feat/parked" },
      worktree: { ...h.f.receipt.worktree, path: parked },
      beads: h.f.receipt.beads,
      proof: h.f.receipt.proof,
      outcome: "landed",
    })
    writeReceipt(newer, receiptDirectory(h.f.env, key))
    await h.pending.record(newer, "ses_lead", { denied: true })
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    await h.idle()
    expect(removed(h)).toBe(true)
    expect(existsSync(parked)).toBe(true)
    await h.finish()
  })

  test("a busy lock on one worktree does not delay a report: it is on disk at once, under the store's lease alone", async () => {
    const h = await harness("report-busy-worktree-lock", { lock: { waitMs: 5_000 } })
    const key = (await repoKey(h.f.main)) as string
    const other = join(h.f.root, "other worktree")
    mkdirSync(other)
    const later = buildReceipt({
      now: NOW + 5000,
      emitter: h.f.receipt.emitter,
      repo: h.f.receipt.repo,
      pr: { ...h.f.receipt.pr, number: 18 },
      branch: { ...h.f.receipt.branch, name: "feat/other" },
      worktree: { ...h.f.receipt.worktree, path: other },
      beads: h.f.receipt.beads,
      proof: h.f.receipt.proof,
      outcome: "landed",
    })
    writeReceipt(later, receiptDirectory(h.f.env, key))
    await h.pending.start()
    // Another remover holds a worktree's lock; the report takes no worktree lock, so it does not wait for it.
    mkdirSync(join(h.common, "opencode", "locks"), { recursive: true })
    const busy = lockFile(h.common, other)
    writeFileSync(busy, JSON.stringify({ pid: process.pid, host: hostname().split(".")[0], owner: "subagent-worktree", token: "theirs", taken: NOW + 10, expires: NOW + 10 + 60_000 }))
    const fired = h.fake.fire.session("experimental.idle", {
      sessionID: "ses_lead",
      background: [{ kind: "shell", sessionID: "ses_lead", shellID: "sh_1", command: `make -C '${h.f.linked}' -C '${other}'` }],
    } as never)
    const end = Date.now() + 2_000
    while (readReports(receiptDirectory(h.f.env)).reports.length === 0 && Date.now() < end) await Bun.sleep(20)
    expect(readReports(receiptDirectory(h.f.env)).reports.map((report) => report.sessionID)).toEqual(["ses_lead"])
    rmSync(busy)
    await fired
    await h.finish()
  })

  describe("one removal boundary for every delivery remover", () => {
    const explicitCleanup = (h: Harness) =>
      cleanupDelivery({ receipt: h.f.receiptPath }, h.f.main, {
        run: h.scripted.run,
        now: () => NOW + 10,
        env: h.f.env,
        bounds: HEAVY_FIXTURE_BOUNDS,
        ...h.pending.explicit(async () => {}, "ses_lead"),
      })

    test("an authorized explicit cleanup of an unclaimed worktree with a live hold removes nothing", async () => {
      const h = await harness("explicit-hold")
      setHold(h.common, h.f.linked, "ses_x", [{ kind: "shell", id: "x" }], NOW + 10)
      const result = await explicitCleanup(h)
      expect(result.ok).toBe(false)
      expect(refusal(result)).toContain("worktree.held")
      expect(refusal(result)).toContain("background job")
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    test("the same explicit cleanup removes the worktree once nothing holds it", async () => {
      const h = await harness("explicit-clear")
      const result = await explicitCleanup(h)
      expect(result.ok).toBe(true)
      expect(removed(h)).toBe(true)
      await h.finish()
    })

    test("a lock another remover holds keeps delivery's removal from running", async () => {
      const h = await harness("explicit-locked", { lock: { waitMs: 60 } })
      await h.pending.record(h.f.receipt, "ses_lead")
      mkdirSync(join(h.common, "opencode", "locks"), { recursive: true })
      writeFileSync(
        lockFile(h.common, h.f.linked),
        JSON.stringify({ pid: process.pid, host: hostname().split(".")[0], owner: "subagent-worktree", token: "theirs", taken: NOW + 10, expires: NOW + 10 + 60_000 }),
      )
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      expect(JSON.parse(readFileSync(lockFile(h.common, h.f.linked), "utf8")).token).toBe("theirs")
      await h.finish()
    })

    test("an explicit cleanup reads the target only after another remover's removal, and reports it already cleaned", async () => {
      let waiting = () => {}
      const blocked = new Promise<void>((done) => {
        waiting = done
      })
      const lockWait = async (ms: number) => {
        waiting()
        await Bun.sleep(ms)
      }
      const h = await harness("explicit-proofs-locked", { lock: { sleep: lockWait } })
      let cleanup: Promise<CleanupResult> = Promise.resolve({ ok: false, reason: "the cleanup never started" })
      await withDiskLock(h.common, h.f.linked, { sessionID: "subagent-worktree", now: () => NOW + 10 }, async () => {
        // The other remover is part-way: tracked files are gone and the tree is still registered.
        for (const file of git(h.f.linked, ["ls-files"]).split("\n").filter(Boolean).slice(0, 2)) rmSync(join(h.f.linked, file))
        cleanup = outsideLocks(() => explicitCleanup(h))
        await Promise.race([cleanup, blocked])
        git(h.f.main, ["worktree", "remove", "--force", h.f.linked])
      })
      const result = await cleanup
      if (!result.ok) throw new Error(`refused while another remover removed the worktree: ${result.reason}`)
      expect(result.alreadyCleaned).toBe(true)
      expect(h.scripted.calls.filter(isWorktreeRemove)).toEqual([])
      await h.finish()
    })

    test("a retry whose removal stops part-way tells the session once, keeps the landing record and does not retry", async () => {
      const h = await harness("retry-part-way", {
        // Tracked files go, then git fails to delete the rest: still registered and on disk, part-way.
        before: (argv) => {
          if (!isWorktreeRemove(argv)) return
          for (const file of git(h.f.linked, ["ls-files"]).split("\n").filter(Boolean).slice(0, 2)) rmSync(join(h.f.linked, file))
        },
        after: (argv, result) => {
          if (isWorktreeRemove(argv)) Object.assign(result, { ok: true, exitCode: 255, error: undefined, stderr: `error: failed to delete '${h.f.linked}': Permission denied\n` })
        },
      })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(synthetic(h)).toHaveLength(1)
      const told = JSON.stringify(synthetic(h)[0]?.input)
      expect(told).toContain("removal attempted, partly removed, unverified")
      expect(told).toContain("Delivery does not retry it")
      expect(told).toContain("save any changes in it")
      expect(told).not.toMatch(DESTRUCTIVE_ADVICE)
      expect(readLanding(h.common, h.f.receipt.receiptId).kind).toBe("present")
      await h.idle()
      expect(synthetic(h)).toHaveLength(1)
      expect(h.scripted.calls.filter(isWorktreeRemove)).toHaveLength(1)
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    // Reads happen between the section's first look and the removal call: the tree is scanned a second
    // time (revalidateBoundary). Whatever appears during that scan must still stop the removal.
    const onSecondStatus = (act: () => void): RunnerOptions["before"] => {
      let scans = 0
      return (argv) => {
        if (argv.includes("status") && argv.includes("--porcelain") && ++scans === 2) act()
      }
    }

    test("a denial that appears during the second tree scan stops the removal", async () => {
      let h: Harness | undefined
      h = await harness("final-denial", {
        before: onSecondStatus(() =>
          writeLanding(h!.common, {
            receiptId: h!.f.receipt.receiptId,
            worktree: h!.f.linked,
            headRefOid: h!.f.head,
            sessionID: "ses_lead",
            landedAt: 1,
            denied: { at: 2, sessionID: "ses_lead" },
          }),
        ),
      })
      const result = await explicitCleanup(h)
      expect(refusal(result)).toContain("worktree.held")
      expect(refusal(result)).toContain("denied")
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    test("a hold that appears during the second tree scan stops the removal", async () => {
      let h: Harness | undefined
      h = await harness("final-hold", {
        before: onSecondStatus(() => setHold(h!.common, h!.f.linked, "ses_x", [{ kind: "shell", id: "x" }], NOW + 10)),
      })
      const result = await explicitCleanup(h)
      expect(refusal(result)).toContain("worktree.held")
      expect(refusal(result)).toContain("background job")
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("a claim that appears during the second tree scan stops the removal too", async () => {
      let h: Harness | undefined
      h = await harness("final-claim", { before: onSecondStatus(() => h!.claim()) })
      const result = await explicitCleanup(h)
      expect(refusal(result)).toContain("worktree.held")
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("writers wait for a removal in flight: a hold written from outside lands after it, not inside it", async () => {
      let h: Harness | undefined
      let writer: Promise<void> | undefined
      h = await harness("writers-serialised", {
        before: (argv) => {
          if (argv.includes("remove") && h && writer === undefined) {
            // A competing writer starts while the removal holds the lock.
            writer = lockedWrite(h.common, h.f.linked, { sessionID: "writer", waitMs: 5000 }, () =>
              setHold(h!.common, h!.f.linked, "ses_late", [{ kind: "shell", id: "late" }], NOW + 10),
            )
          }
        },
      })
      const result = await explicitCleanup(h)
      expect(result.ok).toBe(true)
      // The write had to wait for the lock, so it happened after the removal, never in between.
      await writer
      expect(readHolds(h.common, h.f.linked).holds.map((hold) => hold.sessionID)).toEqual(["ses_late"])
      await h.finish()
    })

    test("a denial that could not be written to disk (lock busy) is still remembered, and the retry never removes it", async () => {
      const h = await harness("denied-unwritten", { lock: { waitMs: 40 } })
      mkdirSync(join(h.common, "opencode", "locks"), { recursive: true })
      writeFileSync(
        lockFile(h.common, h.f.linked),
        JSON.stringify({ pid: process.pid, host: hostname().split(".")[0], owner: "other", token: "theirs", taken: NOW + 10, expires: NOW + 10 + 60_000 }),
      )
      await expect(h.pending.record(h.f.receipt, "ses_lead", { denied: true })).rejects.toThrow()
      rmSync(lockFile(h.common, h.f.linked))
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("an abort during the final lookup that then returns clear still stops the removal", async () => {
      const h = await harness("final-abort")
      const controller = new AbortController()
      const result = await cleanupDelivery({ receipt: h.f.receiptPath }, h.f.main, {
        run: h.scripted.run,
        now: () => NOW + 10,
        env: h.f.env,
        bounds: HEAVY_FIXTURE_BOUNDS,
        signal: controller.signal,
        finalCheck: async () => {
          controller.abort()
          return undefined
        },
      })
      expect(refusal(result)).toContain("signal")
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    describe("the lane's sessions are moved home after the worktree goes", () => {
      const moves = (h: Harness) =>
        h.fake.calls.filter((entry) => entry.method === "session.move").map((entry) => entry.input as { sessionID: string; directory: string })
      const inLane = (h: Harness) => {
        h.fake.sessions.set("ses_lead", { id: "ses_lead", location: { directory: h.f.main }, time: { busy: 1, idle: 2 } })
        h.fake.sessions.set("ses_lane", { id: "ses_lane", parentID: "ses_lead", location: { directory: h.f.linked }, time: { busy: 1, idle: 2 } })
      }

      test("the worktree is removed first, then the lane's session inside it moves to the main checkout", async () => {
        let movedBeforeRemoval: number | undefined
        let h: Harness | undefined
        h = await harness("move-after", {
          before: (argv) => {
            if (argv.includes("remove") && h) movedBeforeRemoval = moves(h).length
          },
        })
        inLane(h)
        const result = await explicitCleanup(h)
        expect(result.ok).toBe(true)
        expect(movedBeforeRemoval).toBe(0)
        expect(removed(h)).toBe(true)
        expect(moves(h)).toEqual([{ sessionID: "ses_lane", directory: realpathSync(h.f.main) }])
        await h.finish()
      })

      test("a session in the worktree that is not part of the lane stays where it is", async () => {
        const h = await harness("move-outside-lane")
        inLane(h)
        h.fake.sessions.set("ses_stranger", { id: "ses_stranger", location: { directory: h.f.linked }, time: { busy: 1, idle: 2 } })
        h.fake.sessions.set("ses_other_lane", { id: "ses_other_lane", parentID: "ses_stranger", location: { directory: h.f.main }, time: { busy: 1, idle: 2 } })
        const result = await explicitCleanup(h)
        expect(result.ok).toBe(true)
        expect(moves(h).map((move) => move.sessionID)).toEqual(["ses_lane"])
        await h.finish()
      })

      test("a failed move is reported with its reason and the cleanup still succeeds", async () => {
        const h = await harness("move-fails")
        inLane(h)
        ;(h.fake.context.session as unknown as { move: unknown }).move = async () => {
          throw new Error("host refused")
        }
        const result = await explicitCleanup(h)
        expect(result.ok).toBe(true)
        const skipped = result.ok ? result.report.skipped.join("\n") : ""
        expect(skipped).toContain("ses_lane could not be moved")
        expect(skipped).toContain("host refused")
        expect(removed(h)).toBe(true)
        await h.finish()
      })

      test("a session created after the lane was first read, before the removal, is still moved", async () => {
        let h: Harness | undefined
        h = await harness("move-late", {
          before: (argv) => {
            if (argv.includes("remove") && h) {
              h.fake.sessions.set("ses_late", { id: "ses_late", parentID: "ses_lead", location: { directory: h.f.linked }, time: { busy: 1, idle: 2 } })
            }
          },
        })
        inLane(h)
        const result = await explicitCleanup(h)
        expect(result.ok).toBe(true)
        expect(moves(h).map((move) => move.sessionID).sort()).toEqual(["ses_lane", "ses_late"])
        await h.finish()
      })

      test("every landing record's session is a root of the lane", async () => {
        const h = await harness("move-two-roots")
        inLane(h)
        h.fake.sessions.set("ses_lead2", { id: "ses_lead2", location: { directory: h.f.main }, time: { busy: 1, idle: 2 } })
        h.fake.sessions.set("ses_lane2", { id: "ses_lane2", parentID: "ses_lead2", location: { directory: h.f.linked }, time: { busy: 1, idle: 2 } })
        await h.pending.record(h.f.receipt, "ses_lead")
        await h.pending.record({ ...h.f.receipt, receiptId: "other-receipt" }, "ses_lead2")
        const result = await cleanupDelivery({ receipt: h.f.receiptPath }, h.f.main, {
          run: h.scripted.run,
          now: () => NOW + 10,
          env: h.f.env,
          bounds: HEAVY_FIXTURE_BOUNDS,
          ...h.pending.explicit(async () => {}, "ses_unrelated"),
        })
        expect(result.ok).toBe(true)
        expect(moves(h).map((move) => move.sessionID).sort()).toEqual(["ses_lane", "ses_lane2"])
        await h.finish()
      })

      test("a listing that fails is reported as incomplete and the cleanup still succeeds", async () => {
        const h = await harness("move-incomplete")
        inLane(h)
        const session = h.fake.context.session as unknown as { list: (query: Record<string, unknown>) => Promise<unknown> }
        const original = session.list.bind(session)
        session.list = (query) => (typeof query.parentID === "string" ? Promise.reject(new Error("list down")) : original(query))
        const result = await explicitCleanup(h)
        expect(result.ok).toBe(true)
        expect(result.ok ? result.report.skipped.join("\n") : "").toContain("incompletely")
        expect(removed(h)).toBe(true)
        await h.finish()
      })

      test("a session in a subdirectory of the worktree that is running blocks the removal", async () => {
        const h = await harness("move-running-below")
        inLane(h)
        h.fake.sessions.set("ses_deep", { id: "ses_deep", location: { directory: join(h.f.linked, "sub", "dir") }, time: { busy: 9, idle: 2 } })
        const result = await explicitCleanup(h)
        expect(result.ok).toBe(false)
        expect(removed(h)).toBe(false)
        expect(moves(h)).toEqual([])
        await h.finish()
      })

      test("the retry with no landing record uses the session whose turn ended as the lane root", async () => {
        const h = await harness("move-retry-no-record")
        inLane(h)
        await h.pending.start()
        await h.idle("ses_lead")
        expect(removed(h)).toBe(true)
        expect(moves(h).map((move) => move.sessionID)).toEqual(["ses_lane"])
        await h.finish()
      })

      test("a running session in the worktree still blocks the removal, and nothing is moved", async () => {
        const h = await harness("move-running")
        inLane(h)
        h.fake.sessions.set("ses_busy", { id: "ses_busy", location: { directory: h.f.linked }, time: { busy: 9, idle: 2 } })
        const result = await explicitCleanup(h)
        expect(result.ok).toBe(false)
        expect(removed(h)).toBe(false)
        expect(moves(h)).toEqual([])
        await h.finish()
      })

      test("the background retry moves the landing session's lane the same way", async () => {
        const h = await harness("move-retry")
        inLane(h)
        await h.pending.record(h.f.receipt, "ses_lead")
        await h.pending.start()
        await h.idle()
        expect(moves(h).map((move) => move.sessionID)).toEqual(["ses_lane"])
        expect(removed(h)).toBe(true)
        await h.finish()
      })
    })

    test("the removal runs while the shared disk lock is held", async () => {
      let heldDuring = false
      let h: Harness | undefined
      h = await harness("explicit-lock-held", {
        before: (argv) => {
          if (argv.includes("remove") && h) {
            heldDuring = readdirSync(join(h.common, "opencode", "locks")).some((name) => name.endsWith(".lock"))
          }
        },
      })
      const result = await explicitCleanup(h)
      expect(result.ok).toBe(true)
      expect(heldDuring).toBe(true)
      await h.finish()
    })
  })

  describe("a coordination store that cannot be written is unsafe, not empty", () => {
    const needsPermissions = process.getuid?.() === 0 ? test.skip : test
    const lock = (h: Harness) => chmodSync(join(h.common, "opencode"), 0o555) // check-test-executables: directory permission, not a script
    const unlock = (h: Harness) => chmodSync(join(h.common, "opencode"), 0o755) // check-test-executables: directory permission, not a script

    needsPermissions("an unwritable store and a running shell: the idle hook resolves and nothing is removed", async () => {
      const h = await harness("unwritable-shell")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      lock(h)
      try {
        await h.fake.fire.session("experimental.idle", {
          sessionID: "ses_lead",
          background: [{ kind: "shell", sessionID: "ses_x", shellID: "sh1", command: `cd ${h.f.linked} && make` }],
        } as never)
        await h.pending.settle()
        expect(removed(h)).toBe(false)
        expect(mutationCalls(h.scripted.calls)).toEqual([])
      } finally {
        unlock(h)
      }
      await h.finish()
    })

    needsPermissions("with no holds directory and an unwritable store, a plain turn end removes nothing either", async () => {
      const h = await harness("unwritable-missing")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      lock(h)
      try {
        await h.idle()
        expect(removed(h)).toBe(false)
      } finally {
        unlock(h)
      }
      await h.finish()
    })

    needsPermissions("a failed hold write blocks removal even though the holds directory exists and reads as empty", async () => {
      const h = await harness("unwritable-holds-dir")
      await h.pending.record(h.f.receipt, "ses_lead")
      // An older entry makes the holds directory exist; it is then made read-only.
      setHold(h.common, h.f.linked, "ses_old", [{ kind: "shell", id: "old" }], NOW - 25 * 3_600_000)
      const holdsRoot = join(h.common, "opencode", "holds")
      const holdsDir = join(holdsRoot, readdirSync(holdsRoot)[0] as string)
      await h.pending.start()
      chmodSync(holdsDir, 0o555) // check-test-executables: directory permission, not a script
      try {
        await h.fake.fire.session("experimental.idle", {
          sessionID: "ses_lead",
          background: [{ kind: "shell", sessionID: "ses_x", shellID: "sh1", command: `cd ${h.f.linked} && make` }],
        } as never)
        await h.pending.settle()
        expect(removed(h)).toBe(false)
        expect(mutationCalls(h.scripted.calls)).toEqual([])
      } finally {
        chmodSync(holdsDir, 0o755) // check-test-executables: directory permission, not a script
      }
      await h.finish()
    })

    needsPermissions("a later hold write that succeeds clears the unsafe state", async () => {
      const h = await harness("unwritable-recovers")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      lock(h)
      await h.fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [{ kind: "shell", sessionID: "x", command: h.f.linked }] } as never)
      await h.pending.settle()
      expect(removed(h)).toBe(false)
      unlock(h)
      h.advance(60_000)
      await h.fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [] } as never)
      await h.pending.settle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })
  })

  test.each([
    ["a denial is recorded", "cleanup was denied"],
    ["a session in the worktree starts running", "a session is running"],
  ] as const)("%s while any repository observation of the final check runs: the worktree is kept", async (event, reason) => {
    // Every Git observation the final check makes is a wait in which another call can record a
    // denial or a session can start. The change has to be seen whichever of those waits it lands in.
    let observations = 0
    let fireAt = 0
    let fire: () => void = () => {}
    let busy = false
    const observe: GitRunner = (argv, cwd, timeoutMs, signal) => {
      observations++
      if (observations === fireAt) fire()
      return spawnGit(argv, cwd, timeoutMs, signal)
    }
    const list = async () => ({ data: busy ? [{ time: { busy: 2, idle: 1 } }] : [] })
    const dry = await harness("final-check-count", { observe, list })
    observations = 0
    expect(await dry.pending.removalFor("ses_lead").finalCheck(dry.f.linked)).toBeUndefined()
    const total = observations
    await dry.finish()
    expect(total).toBeGreaterThan(0)
    for (let at = 1; at <= total; at++) {
      const h = await harness(`final-check-${reason.split(" ")[1]}-${at}`, { observe, list })
      let recorded: Promise<void> = Promise.resolve()
      busy = false
      fire = () => {
        if (event === "a denial is recorded") recorded = h.pending.record(h.f.receipt, "ses_other", { denied: true })
        else busy = true
      }
      observations = 0
      fireAt = at
      expect(await h.pending.removalFor("ses_lead").finalCheck(h.f.linked)).toContain(reason)
      await recorded
      await h.finish()
    }
  })

  describe("a veto that is still being written is honoured by the final check", () => {
    // While held, every repository observation of this instance waits until released, so a call that
    // makes one is caught in the middle of publishing its veto. While failing, every one answers null.
    let gate: { started: () => void; wait: Promise<void> } | undefined
    let failing = false
    const observe: GitRunner = async (argv, cwd, timeoutMs, signal) => {
      if (failing) return null
      const held = gate
      if (held !== undefined) {
        held.started()
        await held.wait
      }
      return spawnGit(argv, cwd, timeoutMs, signal)
    }
    const holdObservations = () => {
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      gate = { started: started.resolve, wait: release.promise }
      releaseGate = () => {
        gate = undefined
        release.resolve()
      }
      return { started: started.promise, release: releaseGate }
    }
    // A test that fails while holding must not leave the next one's observations held.
    let releaseGate = () => {}
    afterEach(() => {
      releaseGate()
      failing = false
    })
    /** A harness whose priming observed the repository, or, with `primed` false, whose priming failed. */
    const vetoHarness = async (name: string, primed: boolean, over: Parameters<typeof harness>[1] = {}) => {
      failing = !primed
      try {
        return await harness(name, { observe, ...over })
      } finally {
        failing = false
      }
    }
    const refuseExplicit = (h: Harness) =>
      h.pending
        .explicit(() => Promise.reject(new Error("rejected")), "ses_other")
        .authorize({ worktree: h.f.linked })
        .catch(() => {})
    const shellReport = (h: Harness) =>
      h.fake.fire.session("experimental.idle", {
        sessionID: "ses_x",
        background: [{ kind: "shell", sessionID: "ses_x", shellID: "sh1", command: `cd ${h.f.linked} && make test` }],
      } as never)
    /** Another delivery instance in the same repository, with no in-memory state of the first. */
    const otherInstance = (h: Harness) =>
      createPendingCleanup({ ctx: h.fake.context, cwd: h.f.main, env: h.f.env, host: () => undefined, now: () => NOW + 10 })
    const priming = [
      ["primed", true],
      ["unprimed after a failed priming", false],
    ] as const

    test.each(priming)("%s: a refused explicit cleanup's denial is on disk for another instance before any git wait", async (_name, primed) => {
      const h = await vetoHarness(`veto-deny-${primed}`, primed)
      const other = otherInstance(h)
      const held = holdObservations()
      // The refusal finishes publishing, or this instance waits on git first.
      await Promise.race([refuseExplicit(h), held.started])
      expect(await other.removalFor("ses_lead").finalCheck(h.f.linked)).toContain("cleanup was denied")
      held.release()
      await other.dispose()
      await h.finish()
    })

    test.each(priming)("%s: a background shell reported by the idle hook is on disk before any git wait, and the explicit cleanup is refused", async (_name, primed) => {
      const h = await vetoHarness(`veto-report-${primed}`, primed)
      await h.pending.start()
      const held = holdObservations()
      // The hook's first git wait (its cleanup pass) comes only after the report is written.
      await Promise.race([shellReport(h), held.started])
      expect(readReports(receiptDirectory(h.f.env)).reports.map((report) => report.sessionID)).toEqual(["ses_x"])
      held.release()
      await h.pending.settle()
      expect(removed(h)).toBe(false)
      const refused = await h.pending.removalFor("ses_lead").finalCheck(h.f.linked)
      expect(refused).toContain("names the worktree")
      await h.finish()
    })

    // I7: a session lookup that does not answer at removal is a hold, within the bound.
    test("a session lookup that never settles refuses the removal within the lookup bound", async () => {
      const h = await harness("veto-lookup-hung", { sessionLookupMs: 50 })
      ;(h.fake.context.session as unknown as { get: () => Promise<never> }).get = () => new Promise<never>(() => {})
      await h.pending.start()
      await h.fake.fire.session("experimental.idle", {
        sessionID: "ses_x",
        background: [{ kind: "subagent", sessionID: "ses_x", childSessionID: "ses_hung" }],
      } as never)
      expect(await h.pending.removalFor("ses_lead").finalCheck(h.f.linked)).toContain("could not be read")
      await h.finish()
    })

    test("a lookup that fails, or a session found in the worktree, refuses the removal; one the host does not have does not", async () => {
      const h = await harness("veto-lookup-outcomes", { list: async () => ({ data: [] }) })
      const session = h.fake.context.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }
      const real = session.get.bind(session)
      const answers: Record<string, () => Promise<unknown>> = {}
      session.get = (input) => (answers[input.sessionID] ?? (() => real(input)))()
      await h.pending.start()
      const report = (child: string) =>
        h.fake.fire.session("experimental.idle", { sessionID: "ses_x", background: [{ kind: "subagent", sessionID: "ses_x", childSessionID: child }] } as never)
      answers.ses_here = async () => ({ id: "ses_here", location: { directory: h.f.linked } })
      await report("ses_here")
      expect(await h.pending.removalFor("ses_lead").finalCheck(h.f.linked)).toContain("runs in the worktree")
      answers.ses_broken = () => Promise.reject(new Error("the host is down"))
      await report("ses_broken")
      expect(await h.pending.removalFor("ses_lead").finalCheck(h.f.linked)).toContain("could not be read")
      await report("ses_nowhere") // the fake has no such session: not found
      expect(await h.pending.removalFor("ses_lead").finalCheck(h.f.linked)).toBeUndefined()
      await h.finish()
    })

    const needsPermissions = process.getuid?.() === 0 ? test.skip : test
    needsPermissions("a report that fails to be written while the final check lists sessions keeps the worktree", async () => {
      // The final check's session listing waits until released; the report fails meanwhile.
      const listing = Promise.withResolvers<void>()
      const listed = Promise.withResolvers<void>()
      let first = true
      const list = async () => {
        if (first) {
          first = false
          listed.resolve()
          await listing.promise
        }
        return { data: [] }
      }
      const h = await harness("veto-report-unwritable", { list })
      await h.pending.start()
      const reports = runningDirectory(receiptDirectory(h.f.env))
      mkdirSync(reports, { recursive: true })
      const check = h.pending.removalFor("ses_lead").finalCheck(h.f.linked)
      await listed.promise
      chmodSync(reports, 0o555) // check-test-executables: directory permission, not a script
      try {
        await shellReport(h)
      } finally {
        chmodSync(reports, 0o755) // check-test-executables: directory permission, not a script
      }
      listing.resolve()
      // Refused either way: the report is still unwritten, or the pass that wrote it again found the shell it names.
      expect(await check).toMatch(/could not be recorded|has a shell running that names the worktree/)
      await h.finish()
    })
  })

  describe("the repository observations follow the cleanup bound", () => {
    // A git that needs about 6 s: it answers only when allowed at least that long.
    const slowGit: GitRunner = (argv, cwd, timeoutMs) => {
      if (timeoutMs < 6000) return null
      const proc = Bun.spawnSync(["git", ...argv], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
      return proc.exitCode === 0 ? proc.stdout.toString() : null
    }

    test("with the cleanup bound injected (61 s) a 6 s observation succeeds and the worktree is removed", async () => {
      const h = await harness("bound-injected", { bounds: { refReadMs: 61_000 }, observe: slowGit })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })

    test("with a 5 s bound the same observation times out and nothing is removed", async () => {
      const h = await harness("bound-5s", { bounds: { refReadMs: 5_000 }, observe: slowGit })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("the ledger check of an open bead uses the configured observer and bound, so the nudge is sent", async () => {
      // Only the configured observer can classify the ledger: the git on PATH refuses the
      // canonical-root read, and the observer answers only within the 61 s bound.
      const real = Bun.which("git") ?? "git"
      const observer: GitRunner = (argv, cwd, timeoutMs) => {
        if (timeoutMs < 6000) return null
        const proc = Bun.spawnSync([real, ...argv], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
        return proc.exitCode === 0 ? proc.stdout.toString() : null
      }
      const h = await harness("ledger-observer", { beadStatus: "open", bounds: { refReadMs: 61_000 }, observe: observer })
      const bin = scratch("ledger-observer-bin")
      writeExecutable(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --git-common-dir --show-toplevel "*) exit 1;; esac\nexec "${real}" "$@"\n`)
      const before = process.env.PATH
      process.env.PATH = `${bin}:${before ?? ""}`
      try {
        await h.pending.record(h.f.receipt, "ses_lead")
        await h.pending.start()
        await h.idle()
      } finally {
        process.env.PATH = before
      }
      expect(synthetic(h)).toHaveLength(1)
      expect(JSON.stringify(synthetic(h)[0]?.input)).toContain("Landed PR #17: close beads delivery-17")
      expect(removed(h)).toBe(false)
      await h.finish()
    })
  })

  describe("background work", () => {
    const idleHook = (h: Harness, background: unknown[]) =>
      h.fake.fire.session("experimental.idle", { sessionID: "ses_lead", background } as never)

    test("a running shell named by the idle session's background list keeps an unclaimed landed worktree", async () => {
      const h = await harness("pending-bg-shell")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await idleHook(h, [{ kind: "shell", sessionID: "ses_x", shellID: "sh1", command: `cd ${h.f.linked} && make test` }])
      await h.pending.settle()
      expect(removed(h)).toBe(false)
      expect(readReports(receiptDirectory(h.f.env)).reports.map((report) => report.sessionID)).toEqual(["ses_lead"])
      await h.finish()
    })

    test("a job of a session that works in the worktree keeps it too", async () => {
      const h = await harness("pending-bg-session")
      h.fake.sessions.set("ses_in", { id: "ses_in", location: { directory: h.f.linked } })
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await idleHook(h, [{ kind: "shell", sessionID: "ses_in", shellID: "sh2", command: "sleep 30" }])
      await h.pending.settle()
      expect(removed(h)).toBe(false)
      await h.finish()
    })

    test("a hold another instance wrote blocks the final check", async () => {
      const h = await harness("pending-bg-foreign")
      await h.pending.record(h.f.receipt, "ses_lead")
      setHold(h.common, h.f.linked, "ses_child", [{ kind: "shell", id: "x" }], NOW)
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      await h.finish()
    })

    test("when the next idle lists nothing the hold clears and the worktree is removed", async () => {
      const h = await harness("pending-bg-clears")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await idleHook(h, [{ kind: "shell", sessionID: "ses_x", shellID: "sh1", command: `cd ${h.f.linked}` }])
      await h.pending.settle()
      expect(removed(h)).toBe(false)
      h.advance(60_000)
      await idleHook(h, [])
      await h.pending.settle()
      expect(readReports(receiptDirectory(h.f.env)).reports).toEqual([])
      expect(removed(h)).toBe(true)
      await h.finish()
    })
  })

  // What each session last said is running: one raw report per session on disk, judged when a removal asks.
  describe("running reports", () => {
    const needsPermissions = process.getuid?.() === 0 ? test.skip : test
    // The host lists every shell with the session that owns it: the reporting session unless the test says otherwise.
    const reportFrom = (h: Harness, sessionID: string, background: Array<Record<string, unknown>>) =>
      h.fake.fire.session("experimental.idle", { sessionID, background: background.map((job) => ({ sessionID, ...job })) } as never)
    const shellIn = (h: Harness, shellID = "sh1") => ({ kind: "shell", shellID, command: `cd ${h.f.linked} && make` })
    const elsewhere = (shellID = "sh0") => ({ kind: "shell", shellID, command: "sleep 60" })
    const check = (h: Harness) => h.pending.removalFor("ses_lead").finalCheck(h.f.linked)
    const reportIds = (h: Harness) => readReports(receiptDirectory(h.f.env)).reports.map((report) => report.sessionID)

    // I2: only the session that reported clears its report.
    test("another session's report of nothing running does not lift a session's hold; its own does", async () => {
      const h = await harness("running-owner-only")
      await h.pending.start()
      await reportFrom(h, "ses_a", [shellIn(h)])
      await reportFrom(h, "ses_b", [])
      expect(reportIds(h)).toEqual(["ses_a"])
      expect(await check(h)).toContain("names the worktree")
      await reportFrom(h, "ses_a", [])
      expect(reportIds(h)).toEqual([])
      expect(await check(h)).toBeUndefined()
      await h.finish()
    })

    // I3: one report per session, the last one.
    test("three overlapping reports of one session leave exactly the last on disk", async () => {
      const h = await harness("running-last-wins")
      await h.pending.start()
      await Promise.all([reportFrom(h, "ses_a", [shellIn(h, "one")]), reportFrom(h, "ses_a", [shellIn(h, "two")]), reportFrom(h, "ses_a", [elsewhere("three")])])
      const reports = readReports(receiptDirectory(h.f.env)).reports
      expect(reports.map((report) => report.jobs.map((job) => job.shellID))).toEqual([["three"]])
      // The last one names nothing in the worktree: so the earlier ones no longer hold it.
      expect(await check(h)).toBeUndefined()
      await h.finish()
    })

    // I4: a failed write is a hold until the session's next successful write.
    needsPermissions("a report that cannot be written refuses removal until storage recovers and a pass writes it again", async () => {
      const h = await harness("running-write-fails")
      await h.pending.start()
      const directory = runningDirectory(receiptDirectory(h.f.env))
      mkdirSync(directory, { recursive: true })
      chmodSync(directory, 0o555) // check-test-executables: directory permission, not a script
      try {
        await reportFrom(h, "ses_a", [elsewhere()])
        expect(await check(h)).toContain("the running work of ses_a could not be recorded")
      } finally {
        chmodSync(directory, 0o755) // check-test-executables: directory permission, not a script
      }
      // With storage back, any session's idle hook writes the report again from its snapshot.
      await reportFrom(h, "ses_b", [elsewhere("other")])
      expect(h.pending.unsettledCount()).toBe(0)
      expect(reportIds(h).sort()).toEqual(["ses_a", "ses_b"])
      expect(await check(h)).toBeUndefined()
      await h.finish()
    })

    // I5: a store that cannot be read or written proves nothing.
    test.each([
      ["written", (directory: string) => writeFileSync(directory, "a file where the directory goes"), "not writable"],
      ["read", (directory: string) => (mkdirSync(directory, { recursive: true }), writeFileSync(join(directory, "damaged.json"), "{not json")), "cannot be read"],
    ] as const)("a running-work store that cannot be %s refuses removal", async (_name, damage, why) => {
      const h = await harness(`running-store-${why.split(" ")[0]}`)
      await h.pending.start()
      damage(runningDirectory(receiptDirectory(h.f.env)))
      expect(await check(h)).toContain(why)
      await h.finish()
    })

    // I6: reports that cannot mean running work do not hold.
    test("after the session's deletion the worktree is removed", async () => {
      const h = await harness("running-deleted")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await reportFrom(h, "ses_a", [shellIn(h)])
      await h.idle()
      expect(removed(h)).toBe(false)
      await h.fake.emit({ type: "session.deleted", data: { sessionID: "ses_a" } })
      expect(reportIds(h)).toEqual([])
      h.advance(60_000)
      await h.idle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })

    test("a report of another server on this host whose process is gone does not hold the worktree", async () => {
      const h = await harness("running-dead-pid")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      const dead = Number(execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim())
      h.fake.sessions.set("ses_a", { id: "ses_a", location: { directory: h.f.root } })
      writeReport(receiptDirectory(h.f.env), { sessionID: "ses_a", jobs: [shellIn(h)], at: NOW + 10, pid: dead, host: hostname(), instance: "another-server" })
      await h.idle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })

    test("a report whose reporter runs on another host holds until it expires, whatever the local processes say", async () => {
      const h = await harness("running-other-host")
      await h.pending.start()
      const dead = Number(execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim())
      h.fake.sessions.set("ses_a", { id: "ses_a", location: { directory: h.f.root } })
      writeReport(receiptDirectory(h.f.env), { sessionID: "ses_a", jobs: [shellIn(h)], at: NOW + 10, pid: dead, host: "another-host", instance: "far-server" })
      expect(await check(h)).toContain("names the worktree")
      h.advance(25 * 3_600_000)
      expect(await check(h)).toBeUndefined()
      await h.finish()
    })

    test("a job whose session the host does not have does not hold the worktree", async () => {
      const h = await harness("running-job-gone")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await reportFrom(h, "ses_a", [{ kind: "subagent", sessionID: "ses_a", childSessionID: "ses_gone" }])
      await h.idle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })

    // The store's lease: every write, and a removal from its last read to its end, holds it.
    const lockPath = (h: Harness) => runningLeaseFile(receiptDirectory(h.f.env))
    /** Another process takes the store's lease and keeps it until `release`. */
    const takeLease = async (h: Harness) => {
      mkdirSync(receiptDirectory(h.f.env), { recursive: true })
      let release: () => void = () => {}
      const entered = Promise.withResolvers<void>()
      const done = outsideLocks(() =>
        withLease(lockPath(h), { owner: "another process" }, () => new Promise<void>((resolve) => {
          release = resolve
          entered.resolve()
        })),
      )
      await entered.promise
      return { release: () => release(), done }
    }
    /** Lock options whose every wait on a busy lock lasts until the test settles it, in the order the waits began. */
    const queuedWaits = () => {
      const waits: Array<() => void> = []
      let notify: () => void = () => {}
      const sleep = () =>
        new Promise<void>((go) => {
          waits.push(go)
          notify()
        })
      const reached = async (n: number) => {
        while (waits.length < n) await new Promise<void>((done) => (notify = done))
      }
      return { lock: { waitMs: 30_000, sleep }, waits, reached }
    }
    /** A removal section whose body is `inside`, after the last look at the running work the way `cleanupDelivery` takes it. */
    const removalWith = async (h: Harness, inside: (reason: string | undefined) => Promise<void>) => {
      const removal = h.pending.removalFor("ses_lead")
      await removal.removalSection(h.f.linked, async () => {
        await inside(await removal.finalCheck(h.f.linked))
        return { ok: false, reason: "test: nothing is removed" } as never
      })
    }

    // Two writers racing for the lease: the one stamped first may take it last, and must then change nothing.
    test.each([
      ["a report", (h: Harness) => reportFrom(h, "ses_a", [shellIn(h, "older")])],
      ["a clear", (h: Harness) => reportFrom(h, "ses_a", [])],
    ] as const)("two writers racing: the older %s neither replaces nor deletes the newer report, whichever takes the lease last", async (_name, olderWrite) => {
      const queue = queuedWaits()
      const h = await harness("running-race", { lock: queue.lock })
      await h.pending.start()
      const holder = await takeLease(h)
      const older = outsideLocks(() => olderWrite(h))
      await queue.reached(1)
      const newer = outsideLocks(() => reportFrom(h, "ses_a", [elsewhere("newer")]))
      await queue.reached(2)
      holder.release()
      await holder.done
      queue.waits[1]?.() // the newer takes the lease first ...
      await newer
      queue.waits[0]?.() // ... and the older, stamped before it, comes last
      await older
      expect(readReports(receiptDirectory(h.f.env)).reports.map((report) => report.jobs.map((job) => job.shellID))).toEqual([["newer"]])
      await h.finish()
    })

    // A report that changed between the first read and the last is judged by fresh lookups.
    test("a report that changes between the first read and the final one is judged by fresh lookups", async () => {
      const h = await harness("running-fresh-lookups", { list: async () => ({ data: [] }) })
      await h.pending.start()
      h.fake.sessions.set("ses_x", { id: "ses_x", location: { directory: "/elsewhere" } })
      await reportFrom(h, "ses_a", [{ kind: "subagent", childSessionID: "ses_x" }])
      const session = h.fake.context.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }
      const real = session.get.bind(session)
      let lookups = 0
      const gate = Promise.withResolvers<void>()
      const gated = Promise.withResolvers<void>()
      // The removal's own lookup of ses_x (its second: the section's pre-check made the first) answers late, with where ses_x was.
      session.get = async (input) => {
        if (input.sessionID !== "ses_x" || ++lookups !== 2) return real(input)
        const where = await real(input)
        gated.resolve()
        await gate.promise
        return where
      }
      let reason: string | undefined
      const removal = removalWith(h, async (found) => {
        reason = found
      })
      await gated.promise
      // While that lookup is out, ses_x starts working in the worktree and its session reports it.
      h.fake.sessions.set("ses_x", { id: "ses_x", location: { directory: h.f.linked } })
      await reportFrom(h, "ses_a", [{ kind: "subagent", childSessionID: "ses_x" }, { kind: "shell", shellID: "extra", command: "sleep 1" }])
      gate.resolve()
      await removal
      expect(reason).toContain("runs in the worktree")
      await h.finish()
    })

    // The final lookups, made under the lease for a report that changed, are awaited: an idle hook that fires meanwhile marks its session unsettled at once.
    test("an idle hook that fires while the final lookups are pending refuses the removal", async () => {
      const h = await harness("running-unsettled-during-lookups", { list: async () => ({ data: [] }) })
      await h.pending.start()
      h.fake.sessions.set("ses_x", { id: "ses_x", location: { directory: "/elsewhere" } })
      await reportFrom(h, "ses_a", [{ kind: "subagent", childSessionID: "ses_x" }])
      const session = h.fake.context.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }
      const real = session.get.bind(session)
      let lookups = 0
      const first = { arrived: Promise.withResolvers<void>(), go: Promise.withResolvers<void>() }
      const last = { arrived: Promise.withResolvers<void>(), go: Promise.withResolvers<void>() }
      // The lookups of ses_x: the section's pre-check (1), the check's first (2) and, for the changed report, its last (3, under the lease).
      session.get = async (input) => {
        if (input.sessionID !== "ses_x") return real(input)
        const n = ++lookups
        const where = await real(input)
        const gate = n === 2 ? first : n === 3 ? last : undefined
        gate?.arrived.resolve()
        await gate?.go.promise
        return where
      }
      let reason: string | undefined
      const removal = removalWith(h, async (found) => {
        reason = found
      })
      await first.arrived.promise
      await reportFrom(h, "ses_a", [{ kind: "subagent", childSessionID: "ses_x" }, { kind: "shell", shellID: "extra", command: "sleep 1" }])
      first.go.resolve()
      await last.arrived.promise
      const late = outsideLocks(() => reportFrom(h, "ses_b", [elsewhere()]))
      last.go.resolve()
      await removal
      expect(reason).toContain("ses_b")
      await late
      await h.finish()
    })

    /**
     * The real `cleanupDelivery`, with the real coordination of a pending cleanup and a host registry that
     * names the worktree. `stages` wraps the final check and the last check before the dispatch.
     */
    const endToEnd = async (
      h: Harness,
      stages: {
        afterFinalCheck?: () => void
        afterBeforeRemoval?: () => void
        /** Read when the host removal is dispatched. */
        probe?: () => boolean
      } = {},
    ) => {
      await h.pending.start()
      let dispatched = false
      let probed: boolean | undefined
      const host: HostWorktrees = {
        list: async () => [{ directory: h.f.linked }],
        remove: async () => {
          dispatched = true
          probed = stages.probe?.()
        },
      }
      const removal = h.pending.removalFor("ses_lead")
      const result = await cleanupDelivery({ receipt: h.f.receiptPath }, h.f.main, {
        run: h.scripted.run,
        now: () => NOW + 10,
        env: h.f.env,
        bounds: HEAVY_FIXTURE_BOUNDS,
        host,
        proofSection: removal.proofSection,
        removalSection: removal.removalSection,
        finalCheck: async (worktree, spellings) => {
          const reason = await removal.finalCheck(worktree, spellings)
          stages.afterFinalCheck?.() // after the check's last await
          return reason
        },
        beforeRemoval: () => {
          const reason = removal.beforeRemoval()
          stages.afterBeforeRemoval?.()
          return reason
        },
      })
      return { result, dispatched: () => dispatched, probed: () => probed }
    }

    test("a session marked after the final check's last await refuses the removal: the host removal is never dispatched", async () => {
      const h = await harness("running-mark-before-dispatch")
      let late: Promise<void> | undefined
      const run = await endToEnd(h, {
        afterFinalCheck: () => {
          late = outsideLocks(() => reportFrom(h, "ses_b", [elsewhere()]))
        },
      })
      expect(run.dispatched()).toBe(false)
      expect(refusal(run.result)).toContain("ses_b")
      expect(removed(h)).toBe(false)
      await late
      await h.finish()
    })

    test("nothing is awaited between the last check and the host removal's dispatch", async () => {
      const h = await harness("running-no-await-before-dispatch")
      let marked = false
      // A microtask queued by the last check runs at the first await after it, and so before a later dispatch.
      const run = await endToEnd(h, {
        afterBeforeRemoval: () =>
          queueMicrotask(() => {
            marked = true
          }),
        probe: () => marked,
      })
      expect(run.dispatched()).toBe(true)
      expect(run.probed()).toBe(false)
      await h.finish()
    })

    // A report that arrives while a removal runs waits for the lease the removal holds from its last read.
    test("a report that arrives during a removal waits on the lease until the removal ends", async () => {
      const h = await harness("running-lease-during-removal")
      await h.pending.start()
      let during: Promise<void> | undefined
      let seen: string[] = []
      await removalWith(h, async (reason) => {
        expect(reason).toBeUndefined()
        during = outsideLocks(() => reportFrom(h, "ses_a", [shellIn(h)]))
        await new Promise((done) => setTimeout(done, 250))
        seen = reportIds(h)
      })
      expect(seen).toEqual([])
      await during
      expect(reportIds(h)).toEqual(["ses_a"])
      await h.finish()
    })

    // Another server's reports are judged by their pid, never by what this host's sessions say.
    test("a report of another server whose sessions this host does not have still holds the worktree", async () => {
      const h = await harness("running-other-server")
      await h.pending.start()
      writeReport(receiptDirectory(h.f.env), {
        sessionID: "ses_far",
        jobs: [{ kind: "shell", sessionID: "ses_far", shellID: "sh1", command: "sleep 60" }],
        at: 1,
        pid: process.pid,
        host: hostname(),
        instance: "another-server",
      })
      expect(await check(h)).toContain("another server")
      await h.finish()
    })

    // A job whose working directory cannot be established holds.
    test.each([
      ["a session with no working directory", { kind: "shell", sessionID: "ses_o", shellID: "sh1", command: "sleep 60" }, "no working directory"],
      ["no owning session at all", { kind: "codemode", jobID: "j1" }, "unknown"],
    ] as const)("%s holds the worktree: its cwd cannot be established", async (_name, job, why) => {
      const h = await harness("running-cwd-unknown")
      await h.pending.start()
      h.fake.sessions.set("ses_o", { id: "ses_o", location: {} })
      await h.fake.fire.session("experimental.idle", { sessionID: "ses_a", background: [job] } as never)
      expect(await check(h)).toContain(why)
      await h.finish()
    })

    // A session's deletion forgets the failure to record its report, whether or not its file can be removed.
    needsPermissions("a deleted session's unrecorded mark goes though its file cannot be removed", async () => {
      const h = await harness("running-deleted-unlink-fails")
      await h.pending.start()
      const directory = runningDirectory(receiptDirectory(h.f.env))
      await reportFrom(h, "ses_a", [elsewhere()])
      chmodSync(directory, 0o555) // check-test-executables: directory permission, not a script
      try {
        await reportFrom(h, "ses_a", [elsewhere("again")])
        expect(h.pending.unsettledCount()).toBe(1)
        await h.fake.emit({ type: "session.deleted", data: { sessionID: "ses_a" } })
        expect(h.pending.unsettledCount()).toBe(0)
      } finally {
        chmodSync(directory, 0o755) // check-test-executables: directory permission, not a script
      }
      await h.finish()
    })

    // Two server instances for one session: each writes and clears only its own file, so one's clear never hides the other's report.
    test("another instance's report of the same session still holds after this instance clears its own, whatever the clocks say", async () => {
      const h = await harness("running-two-instances")
      await h.pending.start()
      await reportFrom(h, "ses_a", [shellIn(h)])
      writeReport(receiptDirectory(h.f.env), {
        sessionID: "ses_a",
        jobs: [{ kind: "shell", sessionID: "ses_a", shellID: "sh9", command: `cd ${h.f.linked} && make` }],
        at: 1, // an earlier clock than this instance's
        pid: process.pid,
        host: hostname(),
        instance: "another-server",
      })
      expect(readReports(receiptDirectory(h.f.env)).reports).toHaveLength(2)
      await reportFrom(h, "ses_a", []) // this instance clears
      expect(readReports(receiptDirectory(h.f.env)).reports.map((report) => report.instance)).toEqual(["another-server"])
      expect(await check(h)).toContain("names the worktree")
      await h.finish()
    })

    // A deletion that could not be carried out is retried with a token: a new incarnation of the session that wrote meanwhile is not undone.
    needsPermissions("a pending delete retried after the session's new incarnation wrote leaves the live report", async () => {
      const h = await harness("running-delete-new-incarnation")
      await h.pending.start()
      await reportFrom(h, "ses_a", [shellIn(h)])
      const directory = runningDirectory(receiptDirectory(h.f.env))
      chmodSync(directory, 0o555) // check-test-executables: directory permission, not a script
      try {
        await h.fake.emit({ type: "session.deleted", data: { sessionID: "ses_a" } })
        await Bun.sleep(100)
        expect(h.pending.pendingDeleteCount()).toBe(1)
      } finally {
        chmodSync(directory, 0o755) // check-test-executables: directory permission, not a script
      }
      // The new incarnation takes the lease and writes; the retry of the old deletion runs after it.
      await reportFrom(h, "ses_a", [shellIn(h, "sh2")])
      await reportFrom(h, "ses_b", [])
      expect(h.pending.pendingDeleteCount()).toBe(0)
      expect(reportIds(h)).toEqual(["ses_a"])
      expect(await check(h)).toContain("names the worktree")
      await h.finish()
    })

    // A FIFO where a report is read never stops a removal check; it makes the store unreadable.
    test("a FIFO in the store makes it unreadable at once and stops no check", async () => {
      const h = await harness("running-fifo")
      await h.pending.start()
      const directory = runningDirectory(receiptDirectory(h.f.env))
      mkdirSync(directory, { recursive: true })
      execFileSync("mkfifo", [join(directory, "stuck.json")])
      expect(await check(h)).toContain("cannot be read")
      await h.finish()
    })

    // A report waiting on the lease is a report not yet recorded: removal holds meanwhile.
    test("a removal is refused while a session's report waits on the lease", async () => {
      const queue = queuedWaits()
      const h = await harness("running-unsettled-waiting", { lock: queue.lock })
      await h.pending.start()
      const holder = await takeLease(h)
      const waiting = outsideLocks(() => reportFrom(h, "ses_a", [elsewhere()]))
      await queue.reached(1)
      const verdict = await Promise.race([check(h), Bun.sleep(1_500).then(() => "the check hung")])
      expect(verdict).toContain("ses_a")
      expect(h.pending.unsettledCount()).toBe(1)
      holder.release()
      await holder.done
      queue.waits[0]?.()
      await waiting
      expect(h.pending.unsettledCount()).toBe(0)
      await h.finish()
    })

    needsPermissions("an older write that completes after a newer one failed neither clears the hold nor replaces the newer report", async () => {
      const queue = queuedWaits()
      const h = await harness("running-unsettled-order", { lock: queue.lock })
      await h.pending.start()
      const directory = runningDirectory(receiptDirectory(h.f.env))
      mkdirSync(directory, { recursive: true })
      const holder = await takeLease(h)
      const older = outsideLocks(() => reportFrom(h, "ses_a", [elsewhere("older")]))
      await queue.reached(1)
      const newer = outsideLocks(() => reportFrom(h, "ses_a", [elsewhere("newer")]))
      await queue.reached(2)
      holder.release()
      await holder.done
      chmodSync(directory, 0o555) // check-test-executables: directory permission, not a script
      try {
        queue.waits[1]?.() // the newer takes the lease first and fails to write
        await newer
        expect(h.pending.unsettledCount()).toBe(1)
        expect(await check(h)).toContain("ses_a")
      } finally {
        chmodSync(directory, 0o755) // check-test-executables: directory permission, not a script
      }
      queue.waits[0]?.() // the older then runs: it is not the session's current report, so it writes nothing
      await older
      // Storage is back: the pass the older hook started wrote the newer snapshot, and only that one.
      expect(readReports(receiptDirectory(h.f.env)).reports.map((report) => report.jobs.map((job) => job.shellID))).toEqual([["newer"]])
      expect(h.pending.unsettledCount()).toBe(0)
      await h.finish()
    })

    test("a report still queued for the lease when its session is deleted writes no file and leaves no hold", async () => {
      const queue = queuedWaits()
      const h = await harness("running-unsettled-deleted", { lock: queue.lock })
      await h.pending.start()
      const holder = await takeLease(h)
      const waiting = outsideLocks(() => reportFrom(h, "ses_a", [elsewhere()]))
      await queue.reached(1)
      const deleting = outsideLocks(() => h.fake.emit({ type: "session.deleted", data: { sessionID: "ses_a" } }))
      await queue.reached(2)
      holder.release()
      await holder.done
      queue.waits[1]?.() // the deletion's file removal runs first ...
      await deleting
      queue.waits[0]?.() // ... and the queued report only after it
      await waiting
      expect(reportIds(h)).toEqual([])
      expect(h.pending.unsettledCount()).toBe(0)
      expect(await check(h)).toBeUndefined()
      await h.finish()
    })

    // The receipt spells the worktree through a symlink; git registers the physical path. A shell that names only the receipt's spelling still holds.
    test("a shell naming only the receipt's alternate spelling of the worktree holds the removal", async () => {
      const h = await harness("running-alias-spelling")
      const home = join(scratch("alias-spelling"), "home")
      symlinkSync(h.f.root, home, "dir")
      const aliased = join(home, relative(h.f.root, h.f.linked))
      const receipt = buildReceipt({
        now: NOW + 1,
        emitter: h.f.receipt.emitter,
        repo: h.f.receipt.repo,
        pr: h.f.receipt.pr,
        branch: h.f.receipt.branch,
        worktree: { ...h.f.receipt.worktree, path: aliased },
        beads: h.f.receipt.beads,
        proof: h.f.receipt.proof,
        outcome: "landed",
      })
      rmSync(h.f.receiptPath)
      writeReceipt(receipt, receiptDirectory(h.f.env, h.f.receipt.repo.key))
      await h.pending.record(receipt, "ses_lead")
      await h.pending.start()
      await reportFrom(h, "ses_a", [{ kind: "shell", shellID: "sh1", command: `make -C ${aliased}` }])
      await h.idle()
      expect(removed(h)).toBe(false)
      await reportFrom(h, "ses_a", [])
      await h.idle()
      expect(removed(h)).toBe(true)
      await h.finish()
    })

    test("the final check holds for a shell that names only a spelling it is given besides git's path", async () => {
      const h = await harness("running-final-spelling")
      await h.pending.start()
      const home = join(scratch("final-spelling"), "home")
      symlinkSync(h.f.root, home, "dir")
      const aliased = join(home, relative(h.f.root, h.f.linked))
      await reportFrom(h, "ses_a", [{ kind: "shell", shellID: "sh1", command: `make -C ${aliased}` }])
      const removal = h.pending.removalFor("ses_lead")
      expect(await removal.finalCheck(h.f.linked)).toBeUndefined()
      expect(await removal.finalCheck(h.f.linked, [aliased])).toContain("names the worktree")
      await h.finish()
    })

    /**
     * Bounds the test ends by hand, in place of wall-clock timers, so these tests do not depend on how loaded the machine is.
     * `end(ms)` ends every bound that was asked for `ms` milliseconds.
     */
    const handBounds = () => {
      const open: Array<{ ms: number; ended: boolean; end: () => void }> = []
      return {
        bound: (ms: number) => new Promise<void>((done) => open.push({ ms, ended: false, end: done })),
        /** Waits until a bound of `ms` has been asked for, then ends every such bound. */
        end: async (ms: number) => {
          while (!open.some((candidate) => candidate.ms === ms && !candidate.ended)) await Bun.sleep(2)
          for (const entry of open.filter((candidate) => candidate.ms === ms && !candidate.ended)) {
            entry.ended = true
            entry.end()
          }
        },
      }
    }
    const IDLE_BOUND = 1_111
    const DISPOSE_BOUND = 2_222
    /** A host registry whose removal of the worktree never answers until `release` is called. */
    const hungHost = () => {
      const removing = Promise.withResolvers<void>()
      const never = Promise.withResolvers<void>()
      const state = { directory: "" }
      const host: HostWorktrees = {
        list: async () => [{ directory: state.directory }],
        remove: async () => {
          removing.resolve()
          await never.promise
        },
      }
      return { host, state, removing: removing.promise, release: () => never.resolve() }
    }

    // The host's removal takes no AbortSignal, so a removal that never answers keeps the lease: writers and other removals give up at once (waitMs 0).
    test("a host removal that never answers neither blocks an idle hook indefinitely nor lets another removal proceed", async () => {
      const hung = hungHost()
      const bounds = handBounds()
      const h = await harness("running-hung-removal", { lock: { waitMs: 0 }, host: hung.host, idlePassMs: IDLE_BOUND, bound: bounds.bound })
      try {
        hung.state.directory = h.f.linked
        await h.pending.record(h.f.receipt, "ses_lead")
        await h.pending.start()
        // The host's own idle hook, not the event helper: its pass reaches the hung removal.
        const hook = outsideLocks(() => h.fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [] } as never))
        await hung.removing
        // The hook returns once its bound ends, with the removal still hung.
        await bounds.end(IDLE_BOUND)
        await hook
        // Another session's idle hook cannot take the lease: its report stays unsettled, a hold, and the hook returns.
        const second = outsideLocks(() => reportFrom(h, "ses_b", [elsewhere()]))
        await bounds.end(IDLE_BOUND)
        await second
        expect(h.pending.unsettledCount()).toBe(1)
        expect(reportIds(h)).toEqual([])
        // With that session gone nothing is unsettled, so the next removal is stopped by the lease alone.
        await h.fake.emit({ type: "session.deleted", data: { sessionID: "ses_b" } })
        while (h.pending.unsettledCount() !== 0) await Bun.sleep(5)
        // Another removal, of another worktree, gives up on the lease and refuses.
        const other = join(h.f.root, "another worktree")
        mkdirSync(other)
        let reason: string | undefined
        let ran = false
        const removal = h.pending.removalFor("ses_lead")
        await removal.removalSection(other, async () => {
          reason = await removal.finalCheck(other)
          ran = reason === undefined
          return { ok: false, reason: "test: nothing is removed" } as never
        })
        expect(ran).toBe(false)
        expect(reason).toContain("lease could not be taken")
      } finally {
        hung.release()
        await h.finish()
      }
    })

    test("disposal waits a bounded time for a hung host removal and leaves its lease in place", async () => {
      const hung = hungHost()
      const bounds = handBounds()
      const h = await harness("running-hung-dispose", { lock: { waitMs: 0 }, host: hung.host, idlePassMs: IDLE_BOUND, disposeWaitMs: DISPOSE_BOUND, bound: bounds.bound })
      try {
        hung.state.directory = h.f.linked
        await h.pending.record(h.f.receipt, "ses_lead")
        await h.pending.start()
        void outsideLocks(() => h.fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [] } as never))
        await hung.removing
        const disposing = h.pending.dispose()
        // Disposal is still waiting for the chain until its bound ends; ending it lets disposal return with the removal hung.
        await bounds.end(DISPOSE_BOUND)
        await disposing
        // The removal is still running, so disposal let go of nothing: its lease stays for the pid and stale rules to reclaim.
        expect(existsSync(runningLeaseFile(receiptDirectory(h.f.env)))).toBe(true)
      } finally {
        hung.release()
        await h.finish()
      }
    })

    // A write that failed is written again from its stored snapshot by each of three triggers. Each runs here alone, the others
    // switched off, and the report must be on disk when it returns, before any fallback could have run.
    needsPermissions.each([
      ["the start of a pass", "pass", (h: Harness) => h.idle("ses_lead")],
      ["a removal's final check", "check", (h: Harness) => h.pending.removalFor("ses_lead").finalCheck(h.f.linked)],
      ["another session's idle hook", "idle", (h: Harness) => reportFrom(h, "ses_b", [])],
    ] as const)("a report whose write failed is written again by %s alone", async (_name, trigger, fire) => {
      const h = await harness("running-unsettled-retry", { retryAt: [trigger] })
      await h.pending.start()
      const directory = runningDirectory(receiptDirectory(h.f.env))
      mkdirSync(directory, { recursive: true })
      chmodSync(directory, 0o555) // check-test-executables: directory permission, not a script
      try {
        await reportFrom(h, "ses_a", [elsewhere()])
        expect(h.pending.unsettledCount()).toBe(1)
      } finally {
        chmodSync(directory, 0o755) // check-test-executables: directory permission, not a script
      }
      expect(reportIds(h)).toEqual([])
      await fire(h)
      expect(reportIds(h)).toContain("ses_a")
      expect(h.pending.unsettledCount()).toBe(0)
      await h.finish()
    })

    // A deletion that could not be carried out is kept and retried; it is not a hold of its own (the report file still holds while its pid lives).
    needsPermissions("a deletion that failed during a storage failure is retried by the next pass, which then removes the worktree", async () => {
      const h = await harness("running-delete-retried")
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.start()
      await reportFrom(h, "ses_a", [shellIn(h)])
      expect(reportIds(h)).toEqual(["ses_a"])
      const directory = runningDirectory(receiptDirectory(h.f.env))
      chmodSync(directory, 0o555) // check-test-executables: directory permission, not a script
      try {
        await h.fake.emit({ type: "session.deleted", data: { sessionID: "ses_a" } })
        await Bun.sleep(100)
        expect(h.pending.pendingDeleteCount()).toBe(1)
        expect(h.pending.unsettledCount()).toBe(0)
      } finally {
        chmodSync(directory, 0o755) // check-test-executables: directory permission, not a script
      }
      expect(reportIds(h)).toEqual(["ses_a"]) // the file still holds, which fails closed
      await h.idle("ses_lead")
      expect(h.pending.pendingDeleteCount()).toBe(0)
      expect(reportIds(h)).toEqual([])
      expect(removed(h)).toBe(true)
      await h.finish()
    })

    // I8: nothing accumulates per session. Each idle hook also starts a serial pass, so the count is what
    // that costs (about 0.25 s a hook); twenty-five sessions, fired together, leak as visibly as a hundred.
    needsPermissions("after sessions whose reports failed are deleted, no failure is remembered", async () => {
      const SESSIONS = 25
      const ids = Array.from({ length: SESSIONS }, (_unused, index) => `ses_${index}`)
      const h = await harness("running-unrecorded-drained", { idlePassMs: 1 })
      await h.pending.start()
      const directory = runningDirectory(receiptDirectory(h.f.env))
      mkdirSync(directory, { recursive: true })
      chmodSync(directory, 0o555) // check-test-executables: directory permission, not a script
      try {
        await Promise.all(ids.map((id) => reportFrom(h, id, [elsewhere()])))
        expect(h.pending.unsettledCount()).toBe(SESSIONS)
        // Deleted while storage still refuses writes: no pass can settle them first, so only the deletion empties the map.
        await Promise.all(ids.map((id) => h.fake.emit({ type: "session.deleted", data: { sessionID: id } })))
        expect(h.pending.unsettledCount()).toBe(0)
      } finally {
        chmodSync(directory, 0o755) // check-test-executables: directory permission, not a script
      }
      await h.finish()
    })
  })

  describe("writes and cleanup of records decide under the lock", () => {
    const denialOf = (h: Harness) => {
      const record = readLanding(h.common, h.f.receipt.receiptId)
      return record.kind === "present" ? record.value.denied : undefined
    }

    /** Start the writers while another process holds the lock, so both are queued before either has written. */
    const queuedBehindALock = async (h: Harness, start: () => Promise<unknown>[]) => {
      let writers: Promise<unknown>[] = []
      await withDiskLock(h.common, h.f.linked, { sessionID: "other process", now: () => NOW + 10 }, async () => {
        writers = outsideLocks(start)
        await new Promise((done) => setTimeout(done, 60))
      })
      await Promise.all(writers)
    }

    test("two queued writers, the first a denial and the second a plain record: the denial survives", async () => {
      const h = await harness("writes-denial-first")
      await queuedBehindALock(h, () => [
        h.pending.record(h.f.receipt, "ses_lead", { denied: true }),
        h.pending.record(h.f.receipt, "ses_lead"),
      ])
      expect(denialOf(h)).toMatchObject({ sessionID: "ses_lead" })
      await h.finish()
    })

    test("an update never overwrites an unreadable landing record", async () => {
      const h = await harness("writes-unreadable")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      const file = landingFile(h.common, h.f.receipt.receiptId)
      writeFileSync(file, "{ this record is damaged")
      const before = readFileSync(file)
      // A plain update would otherwise replace the damaged record (and the denial it may hold) with a clean one.
      await expect(h.pending.record(h.f.receipt, "ses_lead")).rejects.toThrow("cannot be read")
      expect(readFileSync(file).equals(before)).toBe(true)
      // And the retry keeps its hands off the worktree.
      await h.pending.start()
      await h.idle()
      expect(removed(h)).toBe(false)
      expect(mutationCalls(h.scripted.calls)).toEqual([])
      expect(readFileSync(file).equals(before)).toBe(true)
      await h.finish()
    })

    test("only an authorized re-arm clears a denial", async () => {
      const h = await harness("writes-rearm")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      await h.pending.record(h.f.receipt, "ses_lead")
      expect(denialOf(h)).toBeDefined()
      await h.pending.arm(h.f.linked)
      expect(denialOf(h)).toBeUndefined()
      await h.finish()
    })

    test("cleanup that checked before a denial was written, then waited on the lock, does not delete the record", async () => {
      const h = await harness("gc-waits-for-lock")
      const key = (await repoKey(h.f.main)) as string
      writeReceipt(
        buildReceipt({
          now: NOW + 5000,
          emitter: h.f.receipt.emitter,
          repo: h.f.receipt.repo,
          pr: h.f.receipt.pr,
          branch: h.f.receipt.branch,
          worktree: { ...h.f.receipt.worktree, removed: true },
          beads: h.f.receipt.beads,
          proof: h.f.receipt.proof,
          outcome: "cleaned",
          supersedes: h.f.receipt.receiptId,
        }),
        receiptDirectory(h.f.env, key),
      )
      await h.pending.record(h.f.receipt, "ses_lead") // plain, and its receipt is superseded: deletable evidence
      let collecting: Promise<void> | undefined
      // Same clock as delivery's, so the lease it takes is not already expired in its eyes.
      await withDiskLock(h.common, h.f.linked, { sessionID: "other writer", now: () => NOW + 10 }, async () => {
        // The cleanup starts and queues for the lock (it is another process, so it does not share this chain) ...
        collecting = outsideLocks(() => h.pending.gc())
        await new Promise((done) => setTimeout(done, 80))
        // ... and a denial lands while it waits.
        writeLanding(h.common, {
          receiptId: h.f.receipt.receiptId,
          worktree: h.f.linked,
          headRefOid: h.f.head,
          sessionID: "ses_lead",
          landedAt: 1,
          denied: { at: 2, sessionID: "ses_lead" },
        })
      })
      await collecting
      expect(denialOf(h)).toMatchObject({ sessionID: "ses_lead" })
      await h.finish()
    })

    test("cleanup still drops a plain record whose evidence holds", async () => {
      const h = await harness("gc-still-drops")
      const key = (await repoKey(h.f.main)) as string
      writeReceipt(
        buildReceipt({
          now: NOW + 5000,
          emitter: h.f.receipt.emitter,
          repo: h.f.receipt.repo,
          pr: h.f.receipt.pr,
          branch: h.f.receipt.branch,
          worktree: { ...h.f.receipt.worktree, removed: true },
          beads: h.f.receipt.beads,
          proof: h.f.receipt.proof,
          outcome: "cleaned",
          supersedes: h.f.receipt.receiptId,
        }),
        receiptDirectory(h.f.env, key),
      )
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.gc()
      expect(readLanding(h.common, h.f.receipt.receiptId)).toEqual({ kind: "missing" })
      await h.finish()
    })
  })

  describe("a landing record is dropped only on positive evidence", () => {
    const receiptsDir = async (h: Harness) => receiptDirectory(h.f.env, (await repoKey(h.f.main)) as string)

    test("a missing receipt directory deletes nothing, denial or not", async () => {
      const h = await harness("gc-no-dir")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      rmSync((await receiptsDir(h)), { recursive: true, force: true })
      await h.pending.gc()
      expect(readLanding(h.common, h.f.receipt.receiptId)).toMatchObject({ kind: "present", value: { denied: { sessionID: "ses_lead" } } })
      await h.finish()
    })

    test("a receipt that cannot be parsed deletes nothing", async () => {
      const h = await harness("gc-corrupt")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      await h.pending.record({ ...h.f.receipt, receiptId: "9-other" } as never, "ses_lead")
      writeFileSync(join((await receiptsDir(h)), `${h.f.receipt.receiptId}.json`), "{not json")
      await h.pending.gc()
      expect(readLanding(h.common, h.f.receipt.receiptId).kind).toBe("present")
      expect(readLanding(h.common, "9-other").kind).toBe("present")
      await h.finish()
    })

    test("a superseded receipt's record is dropped, but a denial never is", async () => {
      const h = await harness("gc-superseded")
      const key = (await repoKey(h.f.main)) as string
      const later = buildReceipt({
        now: NOW + 5000,
        emitter: h.f.receipt.emitter,
        repo: h.f.receipt.repo,
        pr: h.f.receipt.pr,
        branch: h.f.receipt.branch,
        worktree: { ...h.f.receipt.worktree, removed: true },
        beads: h.f.receipt.beads,
        proof: h.f.receipt.proof,
        outcome: "cleaned",
        supersedes: h.f.receipt.receiptId,
      })
      writeReceipt(later, receiptDirectory(h.f.env, key))
      await h.pending.record(h.f.receipt, "ses_lead")
      await h.pending.gc()
      expect(readLanding(h.common, h.f.receipt.receiptId)).toEqual({ kind: "missing" })
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      await h.pending.gc()
      expect(readLanding(h.common, h.f.receipt.receiptId).kind).toBe("present")
      await h.finish()
    })

    test("a pass over a worktree that is gone keeps a denial", async () => {
      const h = await harness("gc-gone-denied")
      await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
      rmSync(h.f.linked, { recursive: true, force: true })
      await h.pending.start()
      await h.idle()
      expect(readLanding(h.common, h.f.receipt.receiptId).kind).toBe("present")
      await h.finish()
    })
  })

  test("a worktree that is already gone is done and takes no slot", async () => {
    const h = await harness("pending-gone", { maxPerPass: 1 })
    const key = (await repoKey(h.f.main)) as string
    const gone = buildReceipt({
      now: NOW + 5000,
      emitter: h.f.receipt.emitter,
      repo: h.f.receipt.repo,
      pr: { ...h.f.receipt.pr, number: 19 },
      branch: { ...h.f.receipt.branch, name: "feat/gone" },
      worktree: { ...h.f.receipt.worktree, path: join(h.f.root, "no such worktree") },
      beads: h.f.receipt.beads,
      proof: h.f.receipt.proof,
      outcome: "landed",
    })
    writeReceipt(gone, receiptDirectory(h.f.env, key))
    await h.pending.record(gone, "ses_lead")
    await h.pending.start()
    await h.idle()
    expect(removed(h)).toBe(true)
    expect(readLanding(h.common, gone.receiptId)).toEqual({ kind: "missing" })
    expect(existsSync(landingFile(h.common, gone.receiptId))).toBe(false)
    await h.finish()
  })
})

describe("cleanup of another repository's landing runs against that repository", () => {
  // The session works in `s`, whose remote names other/session; the landing is `f`'s (owner/repo).
  const SESSION_URL = "https://github.com/other/session.git\n"
  async function foreignHarness(
    name: string,
    over: {
      sessions?: (f: Fixture) => Array<Record<string, unknown> & { id: string }>
      hostListsTarget?: boolean
      beadStatus?: string
      observe?: GitRunner
      lock?: Record<string, unknown>
      layout?: FixtureLayout
    } = {},
  ) {
    const f = await fixture(name, `feat/${name}`, "active", over.layout)
    const s = await fixture(`${name}-session`)
    const options: RunnerOptions = { beadStatus: over.beadStatus ?? "closed" }
    const scripted = runner(f, options)
    const run: CliRunner = (argv, commandOptions) =>
      argv[0] === "git" && argv.slice(-3, -1).join(" ") === "remote get-url" && commandOptions.cwd === s.main
        ? Promise.resolve(success(SESSION_URL))
        : scripted.run(argv, commandOptions)
    const fake = createFakeContext({ directory: s.main, projectID: "prj_session", sessions: over.sessions?.(f) ?? [] })
    hostHasReporters(fake, s.main)
    const hostRemoved: Array<{ projectID: string; directory: string }> = []
    const make = () => createPendingCleanup({
      ctx: fake.context,
      cwd: s.main,
      env: f.env,
      host: () => undefined,
      ...(over.hostListsTarget === undefined
        ? {}
        : {
            hostFor: () => (projectID: string) => ({
              list: async () => (over.hostListsTarget ? [{ directory: f.linked }] : []),
              remove: async (directory: string) => {
                hostRemoved.push({ projectID, directory })
                git(f.main, ["worktree", "remove", directory])
              },
            }),
          }),
      debounceMs: 1,
      cleanup: { run: stripped(run), now: () => NOW + 10, bounds: HEAVY_FIXTURE_BOUNDS },
      now: () => NOW + 10,
      ...(over.observe === undefined ? {} : { observe: over.observe }),
      ...(over.lock === undefined ? {} : { lock: over.lock }),
    })
    const pending = make()
    await pending.prime()
    const targetCommon = (await repositoryContext(f.main))?.commonDir as string
    const sessionCommon = (await repositoryContext(s.main))?.commonDir as string
    const sessionKey = (await repositoryContext(s.main))?.key as string
    const explicit = (ask: () => Promise<void> = async () => {}) =>
      cleanupDelivery({ receipt: f.receiptPath, repo: "owner/repo", repoPath: f.main }, s.main, {
        run,
        now: () => NOW + 10,
        env: f.env,
        bounds: HEAVY_FIXTURE_BOUNDS,
        ...pending.explicit(ask, "ses_lead"),
      })
    const idle = async () => {
      fake.emit({ type: "session.idle", data: { sessionID: "ses_lead" } })
      await pending.settle()
    }
    const finish = async () => {
      await pending.dispose()
      rmSync(f.root, { recursive: true, force: true })
      rmSync(s.root, { recursive: true, force: true })
    }
    return { f, s, run, scripted, fake, pending, another: make, targetCommon, sessionCommon, sessionKey, explicit, idle, hostRemoved, finish }
  }
  const idleSession = (id: string, projectID: string, directory: string) => ({ id, projectID, location: { directory }, time: { updated: 1 } })

  test("an explicit cleanup removes the worktree and writes the continuation receipt under the target's key", async () => {
    const h = await foreignHarness("foreign-explicit")
    const result = await h.explicit()
    expect(result.ok).toBe(true)
    expect(existsSync(h.f.linked)).toBe(false)
    expect(existsSync(h.s.linked)).toBe(true)
    const cleaned = listReceipts(receiptDirectory(h.f.env, h.f.receipt.repo.key)).filter((receipt) => receipt.outcome === "cleaned")
    expect(cleaned.map((receipt) => receipt.supersedes)).toEqual([h.f.receipt.receiptId])
    await h.finish()
  })

  test("a clone whose .git switches to another repository's store during authorization is refused and nothing is removed", async () => {
    const h = await foreignHarness("foreign-switch", { layout: "separate-git-dir" })
    const store = join(h.f.root, "store.git")
    const copy = join(h.f.root, "store-copy.git")
    let switched = false
    const result = await cleanupDelivery({ receipt: h.f.receiptPath, repo: "owner/repo", repoPath: h.f.main }, h.s.main, {
      run: h.run,
      now: () => NOW + 10,
      env: h.f.env,
      bounds: HEAVY_FIXTURE_BOUNDS,
      coordinate: async () => ({
        // The prompt waits on a person: meanwhile the clone's marker and the worktree's both move to a
        // copy of the store, a complete repository of its own, so every later proof is consistent with it.
        authorize: async () => {
          cpSync(store, copy, { recursive: true })
          writeFileSync(join(h.f.main, ".git"), `gitdir: ${copy}\n`)
          const marker = join(h.f.linked, ".git")
          writeFileSync(marker, readFileSync(marker, "utf8").replaceAll(store, copy))
          switched = true
        },
      }),
    })
    expect(switched).toBe(true)
    // The marker proofs (#94) refuse it; the coordination's own `repo.common` refusal has its test below.
    expect(refusal(result)).toContain("worktree.executionCwd")
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    expect(existsSync(h.f.linked)).toBe(true)
    await h.finish()
  })

  test("a lane claim in the target repository defers the cleanup to its owner", async () => {
    const h = await foreignHarness("foreign-claimed")
    writeClaim(h.targetCommon, { directory: h.f.linked, branch: h.f.branch, sessionID: "ses_child", parentID: "ses_other", createdAt: 1 })
    await expect(h.explicit()).rejects.toBeInstanceOf(CleanupDeferred)
    expect(existsSync(h.f.linked)).toBe(true)
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    await h.finish()
  })

  test("a running session of another project in the target worktree keeps it", async () => {
    const h = await foreignHarness("foreign-live", {
      sessions: (f) => [{ id: "ses_target", projectID: "prj_target", location: { directory: f.linked }, time: { updated: 1, busy: 5, idle: 1 } }],
    })
    const result = await h.explicit()
    expect(refusal(result)).toContain(`a session is running in ${h.f.linked}`)
    expect(existsSync(h.f.linked)).toBe(true)
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    await h.finish()
  })

  test("an OpenCode project the target's sessions do not name exactly once refuses the removal", async () => {
    const h = await foreignHarness("foreign-ambiguous", {
      hostListsTarget: true,
      sessions: (f) => [idleSession("ses_root", "prj_a", f.main), idleSession("ses_lane", "prj_b", f.linked)],
    })
    const reason = refusal(await h.explicit())
    expect(reason).toContain("host worktree.list failed")
    expect(reason).toContain("prj_a")
    expect(reason).toContain("prj_b")
    expect(h.hostRemoved).toEqual([])
    expect(existsSync(h.f.linked)).toBe(true)
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    await h.finish()
  })

  test("the target's one project id is the one its worktree is removed through", async () => {
    const h = await foreignHarness("foreign-project", {
      hostListsTarget: true,
      sessions: (f) => [idleSession("ses_root", "prj_target", f.main), idleSession("ses_lane", "prj_target", f.linked)],
    })
    const result = await h.explicit()
    expect(result.ok).toBe(true)
    expect(h.hostRemoved).toEqual([{ projectID: "prj_target", directory: h.f.linked }])
    await h.finish()
  })

  test("a refused prompt is recorded as a denial in the target's common directory", async () => {
    const h = await foreignHarness("foreign-refused")
    await expect(h.explicit(async () => Promise.reject(new Error("denied by the user")))).rejects.toThrow("denied by the user")
    expect(readLanding(h.targetCommon, h.f.receipt.receiptId)).toMatchObject({ kind: "present", value: { denied: { sessionID: "ses_lead" } } })
    expect(readLanding(h.sessionCommon, h.f.receipt.receiptId).kind).toBe("missing")
    expect(existsSync(h.f.linked)).toBe(true)
    await h.finish()
  })

  test("a clone that resolves to another common directory than it was identified by is refused", async () => {
    const h = await foreignHarness("foreign-moved")
    const coordinated = await h.pending.coordinate("ses_lead")({ common: h.sessionCommon, root: h.f.main })
    expect(coordinated).toMatchObject({ ok: false, reason: expect.stringContaining("repo.common") })
    await h.finish()
  })

  test("the beads reminder for another repository's landing runs its commands in that clone", async () => {
    const h = await foreignHarness("foreign-nudge", { beadStatus: "open" })
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    await h.idle()
    const texts = h.fake.calls.filter((call) => call.method === "session.synthetic").map((call) => JSON.stringify(call.input))
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain(`bd -C '${h.f.main}' close delivery-17`)
    expect(existsSync(h.f.linked)).toBe(true)
    await h.finish()
  })

  test("a receipt id the session's repository also has does not keep the target's worktree from its retry", async () => {
    const h = await foreignHarness("foreign-same-id")
    // Both fixtures come from one template, so their receipts share the id.
    expect(h.s.receipt.receiptId).toBe(h.f.receipt.receiptId)
    writeReceipt(h.s.receipt, receiptDirectory(h.f.env, h.s.receipt.repo.key))
    git(h.s.main, ["worktree", "remove", h.s.linked])
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    await h.idle()
    expect(existsSync(h.f.linked)).toBe(false)
    await h.finish()
  })

  test("a landing record for the target's worktree is written in the target's common directory", async () => {
    const h = await foreignHarness("foreign-record")
    await h.pending.record(h.f.receipt, "ses_lead")
    expect(readLanding(h.targetCommon, h.f.receipt.receiptId).kind).toBe("present")
    expect(readLanding(h.sessionCommon, h.f.receipt.receiptId).kind).toBe("missing")
    await h.finish()
  })

  test("a deferred cleanup is retried at a turn end against the receipt's repository", async () => {
    const h = await foreignHarness("foreign-retry")
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    await h.idle()
    expect(existsSync(h.f.linked)).toBe(false)
    expect(readLanding(h.targetCommon, h.f.receipt.receiptId)).toEqual({ kind: "missing" })
    await h.finish()
  })

  test("an instance started later retries the clone an earlier one registered", async () => {
    const h = await foreignHarness("foreign-fresh")
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.dispose()
    const fresh = h.another()
    await fresh.prime()
    await fresh.start()
    h.fake.emit({ type: "session.idle", data: { sessionID: "ses_lead" } })
    await fresh.settle()
    expect(existsSync(h.f.linked)).toBe(false)
    await fresh.dispose()
    await h.finish()
  })

  /** A receipt-named file in `key`'s receipt directory that does not parse. */
  const unparseableReceipt = (env: NodeJS.ProcessEnv, key: string) => {
    mkdirSync(receiptDirectory(env, key), { recursive: true })
    writeFileSync(join(receiptDirectory(env, key), "1800000000000-aaaaaaaaaaaa.json"), "{not json")
  }

  test("a clone whose observation stalls does not delay the report: it is on disk at once, and the worktree is kept", async () => {
    let release: () => void = () => {}
    const stalled = new Promise<void>((done) => {
      release = done
    })
    const staleRoot = scratch("foreign-stale-root")
    const h = await foreignHarness("foreign-stale", {
      observe: async (argv, at, timeoutMs, signal) => {
        if (at === staleRoot) {
          await stalled
          return null
        }
        return spawnGit(argv, at, timeoutMs, signal)
      },
    })
    const STALE = "d".repeat(16)
    unparseableReceipt(h.f.env, STALE)
    await addClone(h.f.env, h.sessionKey, { key: STALE, root: staleRoot }, () => true)
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    const fired = h.fake.fire.session("experimental.idle", {
      sessionID: "ses_lead",
      background: [{ kind: "shell", shellID: "sh_1", command: `ls '${h.f.linked}'` }],
    })
    // Written before the hook awaited anything: no wait on a clone stands before it.
    expect(readReports(receiptDirectory(h.f.env)).reports.map((report) => report.sessionID)).toEqual(["ses_lead"])
    release()
    await fired
    expect(existsSync(h.f.linked)).toBe(true)
    await h.finish()
  })

  test("a clone whose receipts cannot be read is kept when the registry is full", async () => {
    const h = await foreignHarness("foreign-prune")
    const kept = { key: "e".repeat(16), root: "/repos/unreadable" }
    unparseableReceipt(h.f.env, kept.key)
    await addClone(h.f.env, h.sessionKey, kept, () => true)
    for (let index = 0; index < MAX_CLONES - 1; index++) {
      await addClone(h.f.env, h.sessionKey, { key: index.toString(16).padStart(16, "0"), root: `/repos/${index}` }, () => true)
    }
    await h.pending.record(h.f.receipt, "ses_lead")
    const entries = readClones(h.f.env, h.sessionKey)
    expect(entries).toHaveLength(MAX_CLONES)
    expect(entries).toContainEqual(kept)
    await h.finish()
  })

  // Nothing is pending in this clone; only the target's landing records can keep it registered. The
  // registration under pressure is delivery's own (`record`), so the predicate it passes is the one tested.
  const collectionMarks = [
    ["its landing record", (common: string) => writeLanding(common, { receiptId: "r1", worktree: "/w", headRefOid: "a".repeat(40), sessionID: "s", landedAt: 1 }), () => {}],
    [
      "a landing record it cannot read",
      (common: string) => {
        mkdirSync(dirname(landingFile(common, "r9")), { recursive: true })
        writeFileSync(landingFile(common, "r9"), "garbage")
      },
      () => {},
    ],
    [
      "landing records hidden by a parent's permissions",
      (common: string) => {
        writeLanding(common, { receiptId: "r1", worktree: "/w", headRefOid: "a".repeat(40), sessionID: "s", landedAt: 1 })
        chmodSync(join(common, "opencode"), 0o000) // check-test-executables: directory permission, not a script
      },
      (common: string) => chmodSync(join(common, "opencode"), 0o700), // check-test-executables: directory permission, not a script
    ],
  ] as const
  test.each(collectionMarks)("a clone whose target still has %s is kept when delivery's registration fills the registry", async (_name, mark, unmark) => {
    if (process.getuid?.() === 0) return // root reads any directory
    const h = await foreignHarness("foreign-uncollected")
    const commonDir = scratch("foreign-uncollected-common")
    const kept = { key: "f".repeat(16), root: "/repos/uncollected", commonDir, receiptIds: ["r1"] }
    mark(commonDir)
    try {
      await addClone(h.f.env, h.sessionKey, kept, () => true)
      for (let index = 0; index < MAX_CLONES - 1; index++) {
        await addClone(h.f.env, h.sessionKey, { key: index.toString(16).padStart(16, "0"), root: `/repos/${index}` }, () => true)
      }
      await h.pending.record(h.f.receipt, "ses_lead")
      const entries = readClones(h.f.env, h.sessionKey)
      expect(entries).toHaveLength(MAX_CLONES)
      // The incoming clone was registered, so retention is not a write that failed.
      expect(entries.map((entry) => entry.key)).toContain(h.f.receipt.repo.key)
      expect(entries.map((entry) => entry.key)).toContain(kept.key)
    } finally {
      unmark(commonDir)
    }
    await h.finish()
  })

  test("a clone whose landing records are collected is evicted, oldest first, when delivery's registration fills the registry", async () => {
    const h = await foreignHarness("foreign-collected")
    // The target's records directory exists and holds nothing for its receipts: collected.
    const commonDir = scratch("foreign-collected-common")
    writeLanding(commonDir, { receiptId: "r1", worktree: "/w", headRefOid: "a".repeat(40), sessionID: "s", landedAt: 1 })
    rmSync(landingFile(commonDir, "r1"))
    const collected = { key: "f".repeat(16), root: "/repos/collected", commonDir, receiptIds: ["r1"] }
    await addClone(h.f.env, h.sessionKey, collected, () => true)
    for (let index = 0; index < MAX_CLONES - 1; index++) {
      await addClone(h.f.env, h.sessionKey, { key: index.toString(16).padStart(16, "0"), root: `/repos/${index}` }, () => true)
    }
    await h.pending.record(h.f.receipt, "ses_lead")
    const keys = readClones(h.f.env, h.sessionKey).map((entry) => entry.key)
    expect(keys).toHaveLength(MAX_CLONES)
    expect(keys).toContain(h.f.receipt.repo.key)
    expect(keys).not.toContain(collected.key)
    await h.finish()
  })

  /** The target's receipt directory made unreadable while `work` runs. */
  const unreadableTarget = async (h: { f: Fixture }, work: () => Promise<unknown>) => {
    const directory = receiptDirectory(h.f.env, h.f.receipt.repo.key)
    chmodSync(directory, 0o000) // check-test-executables: directory permission, not a script
    try {
      await work()
    } finally {
      chmodSync(directory, 0o755) // check-test-executables: directory permission, not a script
    }
  }
  /** A report of `sessionID` with a shell in the target worktree. */
  const shellReport = (h: { f: Fixture; fake: ReturnType<typeof createFakeContext> }, sessionID: string) =>
    h.fake.fire.session("experimental.idle", {
      sessionID,
      background: [{ kind: "shell", sessionID, shellID: "sh_1", command: `cd '${h.f.linked}' && make` }],
    } as never)
  /** Take the target worktree's disk lock as another writer; it stays held until `release`. */
  const holdTargetLock = async (h: { f: Fixture; targetCommon: string }) => {
    let release: () => void = () => {}
    let acquired: () => void = () => {}
    const taken = new Promise<void>((done) => {
      acquired = done
    })
    const held = withDiskLock(h.targetCommon, h.f.linked, { sessionID: "other writer", now: () => NOW + 10 }, () =>
      new Promise<void>((done) => {
        release = done
        acquired()
      }))
    await taken
    return { release: () => release(), held }
  }
  test("a shell reported while the target's receipts cannot be listed still keeps its worktree until the session reports none", async () => {
    const h = await foreignHarness("foreign-holds-unknown")
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    const directory = receiptDirectory(h.f.env, h.f.receipt.repo.key)
    chmodSync(directory, 0o000) // check-test-executables: directory permission, not a script
    try {
      await h.fake.fire.session("experimental.idle", {
        sessionID: "ses_lead",
        background: [{ kind: "shell", shellID: "sh_1", command: `ls '${h.f.linked}'` }],
      })
    } finally {
      chmodSync(directory, 0o755) // check-test-executables: directory permission, not a script
    }
    // The report is kept whole, whatever could be listed when it came: nothing is removed under it.
    await h.idle()
    expect(existsSync(h.f.linked)).toBe(true)
    // The session's own report of nothing running lifts it.
    await h.fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [] })
    await h.idle()
    expect(existsSync(h.f.linked)).toBe(false)
    await h.finish()
  })

  test("an unreadable clone registry keeps the retry from finding the receipt, and a readable one lets it clean", async () => {
    const h = await foreignHarness("foreign-registry-unreadable")
    await h.pending.record(h.f.receipt, "ses_lead")
    await h.pending.start()
    const file = registryFile(h.f.env, h.sessionKey)
    chmodSync(file, 0o000) // check-test-executables: registry file permission, not a script
    try {
      await h.idle()
      expect(existsSync(h.f.linked)).toBe(true)
    } finally {
      chmodSync(file, 0o600) // check-test-executables: registry file permission, not a script
    }
    await h.idle()
    expect(existsSync(h.f.linked)).toBe(false)
    await h.finish()
  })

  test("a denial kept only in memory survives another repository's re-arm of the same receipt id", async () => {
    const h = await foreignHarness("foreign-collide", { lock: { waitMs: 50 } })
    expect(h.s.receipt.receiptId).toBe(h.f.receipt.receiptId)
    // Another holder has the session repository's lock, so this denial cannot reach disk.
    const busy = lockFile(h.sessionCommon, h.s.linked)
    mkdirSync(dirname(busy), { recursive: true })
    writeFileSync(busy, JSON.stringify({ host: hostname(), pid: process.pid, owner: "elsewhere", token: "t", taken: NOW, expires: NOW + 600_000 }))
    await expect(h.pending.record(h.s.receipt, "ses_lead", { denied: true })).rejects.toThrow()
    rmSync(busy)
    await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
    await h.pending.repositoryCoordination({ common: h.targetCommon, root: h.f.receipt.repo.canonicalRoot }).arm(h.f.linked)
    expect(await h.pending.removalFor("ses_lead").finalCheck(h.s.linked)).toContain("cleanup was denied")
    await h.finish()
  })

  test("this instance's registration wins over a stale root in the registry file", async () => {
    const h = await foreignHarness("foreign-stale-disk")
    await h.pending.record(h.f.receipt, "ses_lead")
    writeFileSync(registryFile(h.f.env, h.sessionKey), JSON.stringify([{ key: h.f.receipt.repo.key, root: join(h.f.root, "moved-away") }]))
    await h.pending.start()
    await h.idle()
    expect(existsSync(h.f.linked)).toBe(false)
    await h.finish()
  })

  test.each([
    ["the worktree's", "worktree.marker", "git", false],
    ["the worktree's", "worktree.marker", "the host registry", true],
    ["the execution checkout's", "worktree.executionCwd", "git", false],
    ["the execution checkout's", "worktree.executionCwd", "the host registry", true],
  ] as const)("%s .git swapped while the final session listing waits refuses the removal (%s) through %s", async (which, field, _route, host) => {
    const execution = which === "the execution checkout's"
    const h = await foreignHarness(`foreign-swap-${execution ? "exec" : "target"}-${host ? "host" : "git"}`, {
      hostListsTarget: host,
      sessions: (f) => [idleSession("ses_root", "prj_target", f.main)],
    })
    // The removal runs from the linked checkout of the base branch when there is one; give it one,
    // distinct from the main checkout, so its marker is the one that can be swapped.
    const executionCheckout = join(h.f.root, "execution checkout")
    if (execution) {
      git(h.f.main, ["checkout", "-q", "--detach"])
      git(h.f.main, ["worktree", "add", "-q", executionCheckout, h.f.receipt.pr.baseRefName])
    }
    const swappedMarker = join(execution ? executionCheckout : h.f.linked, ".git")
    const session = h.fake.context.session as unknown as { list: (query: Record<string, unknown>) => Promise<unknown> }
    const list = session.list.bind(session)
    let swapped = false
    let listings = 0
    session.list = async (query) => {
      // The worktree's session listings: the section's recheck under the lock, then the final check
      // just before the removal. The second is suspended here, after every identity proof.
      if (query.archived === false && query.directory === h.f.linked && ++listings === 2) {
        swapped = true
        writeFileSync(swappedMarker, readFileSync(join(h.s.linked, ".git")))
      }
      return list(query)
    }
    const reason = refusal(await h.explicit())
    expect(swapped).toBe(true)
    expect(reason).toContain(`${field}:`)
    expect(commandCalls(h.scripted.calls, "git").filter((argv) => argv[1] === "worktree" && argv[2] === "remove")).toEqual([])
    expect(h.hostRemoved).toEqual([])
    expect(existsSync(h.f.linked)).toBe(true)
    await h.finish()
  })

  test("a denied landing in the target repository is not retried", async () => {
    const h = await foreignHarness("foreign-denied")
    await h.pending.record(h.f.receipt, "ses_lead", { denied: true })
    await h.pending.start()
    await h.idle()
    expect(existsSync(h.f.linked)).toBe(true)
    expect(mutationCalls(h.scripted.calls)).toEqual([])
    await h.finish()
  })
})

const OID_A = "a".repeat(40)
const OID_B = "b".repeat(40)

/** A validated receipt for `pr` on `branch`, landed (or cleaned) at `now`, with a canned worktree path. */
function candidate(
  f: Fixture,
  pr: number,
  branch: string,
  oid: string,
  options: { now?: number; removed?: boolean; nameWithOwner?: string } = {},
): ReceiptCandidate {
  const receipt = buildReceipt({
    now: options.now ?? NOW + pr,
    emitter: f.receipt.emitter,
    repo: { ...f.receipt.repo, nameWithOwner: options.nameWithOwner ?? f.receipt.repo.nameWithOwner },
    pr: { ...f.receipt.pr, number: pr, headRefName: branch, headRefOid: oid },
    branch: { ...f.receipt.branch, name: branch },
    worktree: {
      path: join(f.root, `wt-${pr}`),
      removed: options.removed === true,
      localRefDeleted: options.removed === true,
      absenceVerifiedAt: options.removed === true ? "2027-01-15T09:00:00.000Z" : null,
    },
    beads: f.receipt.beads,
    proof: f.receipt.proof,
    outcome: options.removed === true ? "cleaned" : "landed",
  })
  return { receipt, path: join(f.root, `${receipt.receiptId}.json`) }
}

function selectionRefusal(result: ReturnType<typeof selectReceipt>): string {
  if (result.ok) throw new Error("expected a refusal")
  return result.reason
}

// Built at collection time, as the describe body did before the fixture became async.
const selectPure = await fixture("select-pure")

describe("selectReceipt", () => {
  const f = selectPure
  const one = candidate(f, 1, "feat/one", OID_A)
  const two = candidate(f, 2, "feat/two", OID_B)
  const pool = [two, one] // newest first, as listReceipts returns them

  test("two uncleaned receipts and no selector are ambiguous and the refusal lists each PR, branch and path", () => {
    const reason = selectionRefusal(selectReceipt(pool, {}))
    for (const c of pool) {
      expect(reason).toContain(`pr ${c.receipt.pr.number}`)
      expect(reason).toContain(c.receipt.branch.name)
      expect(reason).toContain(c.path)
    }
  })

  test("an explicit PR number picks that receipt even when another is newer", () => {
    expect(selectReceipt(pool, { pr: 1 })).toEqual({ ok: true, candidate: one })
  })

  test("a lone uncleaned receipt is chosen without a selector, skipping cleaned ones", () => {
    const cleaned = candidate(f, 3, "feat/three", OID_A, { removed: true, now: NOW + 99 })
    expect(selectReceipt([cleaned, one], {})).toEqual({ ok: true, candidate: one })
  })

  test("only the newest receipt of a PR counts, so a landed receipt superseded by its cleaned one is not a candidate", () => {
    const cleaned = candidate(f, 1, "feat/one", OID_A, { removed: true, now: NOW + 500 })
    expect(selectReceipt([cleaned, one, two], {})).toEqual({ ok: true, candidate: two })
  })

  test("receipts of the same PR number in two repositories both survive, so a repo selector finds the older one", () => {
    const other = candidate(f, 1, "feat/one", OID_A, { nameWithOwner: "other/repo", now: NOW + 900 })
    expect(selectReceipt([other, one], { pr: 1, repo: "owner/repo" })).toEqual({ ok: true, candidate: one })
    expect(selectReceipt([other, one], { pr: 1, repo: "other/repo" })).toEqual({ ok: true, candidate: other })
  })

  test("a second receipt of the same PR in the same repository is still deduped to the newest", () => {
    const newer = candidate(f, 1, "feat/one", OID_A, { now: NOW + 900 })
    expect(selectReceipt([newer, one], { pr: 1 })).toEqual({ ok: true, candidate: newer })
  })

  test("a repo-only selector finds that repository's cleaned receipt while another repository has an uncleaned one", () => {
    const cleaned = candidate(f, 1, "feat/one", OID_A, { removed: true })
    const elsewhere = candidate(f, 2, "feat/two", OID_B, { nameWithOwner: "other/repo" })
    expect(selectReceipt([elsewhere, cleaned], { repo: "owner/repo" })).toEqual({ ok: true, candidate: cleaned })
  })

  test("the worktree's HEAD oid picks the receipt whose reviewed head it is", () => {
    expect(selectReceipt(pool, { head: { branch: "other-name", oid: OID_A } })).toEqual({ ok: true, candidate: one })
  })

  test("the worktree's HEAD branch picks the receipt when no oid matches", () => {
    expect(selectReceipt(pool, { head: { branch: "feat/two", oid: "c".repeat(40) } })).toEqual({
      ok: true,
      candidate: two,
    })
  })

  test("the worktree path picks the receipt that recorded it", () => {
    expect(selectReceipt(pool, { worktree: one.receipt.worktree.path as string })).toEqual({ ok: true, candidate: one })
  })

  test("a selector that matches nothing is refused with the candidates listed", () => {
    const reason = selectionRefusal(selectReceipt(pool, { head: { branch: "zzz", oid: "d".repeat(40) } }))
    expect(reason).toContain("feat/one")
    expect(reason).toContain("feat/two")
  })

  test("an empty directory keeps the plain no-receipt refusal", () => {
    expect(selectionRefusal(selectReceipt([], { pr: 999 }))).toContain("the newest validated receipt for pr 999")
  })
})

describe("acceptWorktree", () => {
  const receipt = { branch: { name: "feat/x" }, pr: { headRefOid: OID_A } }
  test.each([
    ["the receipt branch", { head: OID_A, branch: "refs/heads/feat/x", detached: false }, "same"],
    ["a renamed branch", { head: OID_A, branch: "refs/heads/oll-final", detached: false }, "renamed"],
    ["a detached HEAD", { head: OID_A, branch: null, detached: true }, "detached"],
  ])("accepts the reviewed head on %s", (_name, record, branch) => {
    expect(acceptWorktree(record, receipt)).toEqual({ ok: true, branch: branch as "same" })
  })

  test.each([
    ["the receipt branch", { head: OID_B, branch: "refs/heads/feat/x", detached: false }],
    ["a renamed branch", { head: OID_B, branch: "refs/heads/oll-final", detached: false }],
    ["a detached HEAD", { head: OID_B, branch: null, detached: true }],
  ])("refuses any other head on %s", (_name, record) => {
    const verdict = acceptWorktree(record, receipt)
    expect(verdict.ok).toBe(false)
    expect((verdict as { reason: string }).reason).toContain("worktree.HEAD")
  })
})

describe("planLocalRef", () => {
  test.each([
    [null, "absent"],
    [OID_A, "delete"],
    [OID_B, "moved"],
  ])("a branch ref at %s is %s", (observed, plan) => {
    expect(planLocalRef(observed, OID_A)).toBe(plan as "delete")
  })
})

describe("delivery_cleanup receipt selection", () => {
  test("with two receipts in one repository, the worktree argument picks its own, not the newest", async () => {
    const f = await fixture("two-receipts")
    const newer = candidate(f, 18, "feat/newer", OID_B, { now: NOW + 5000 })
    writeReceipt(newer.receipt, receiptDirectory(f.env, newer.receipt.repo.key))
    const { result } = await invoke(f, { worktree: f.linked })
    if (!result.ok) throw new Error(result.reason)
    expect(result.receipt.pr.number).toBe(17)
    expect(existsSync(f.linked)).toBe(false)
  })

  test("with two uncleaned receipts and no selector nothing is removed and both are listed", async () => {
    const f = await fixture("two-receipts-ambiguous")
    const newer = candidate(f, 18, "feat/newer", OID_B, { now: NOW + 5000 })
    writeReceipt(newer.receipt, receiptDirectory(f.env, newer.receipt.repo.key))
    const { result, calls } = await invoke(f, {})
    const reason = refusal(result)
    expect(reason).toContain("pr 17")
    expect(reason).toContain("pr 18")
    expect(reason).toContain(f.branch)
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })
})

describe("delivery_cleanup worktree acceptance", () => {
  test("a worktree renamed off the receipt branch at the reviewed head is removed and the leftover branch reported", async () => {
    const f = await fixture("renamed")
    git(f.linked, ["branch", "-m", "renamed-branch"])
    const { result } = await invoke(f)
    if (!result.ok) throw new Error(result.reason)
    expect(existsSync(f.linked)).toBe(false)
    expect(result.alreadyCleaned).toBe(false)
    expect(result.report.removed.join("\n")).toContain("linked worktree")
    expect(result.report.skipped.join("\n")).toContain("renamed-branch")
  })

  test("a worktree detached after its branch was deleted is removed", async () => {
    const f = await fixture("deleted-branch")
    git(f.linked, ["checkout", "-q", "--detach"])
    git(f.main, ["branch", "-D", f.branch])
    const { result } = await invoke(f)
    if (!result.ok) throw new Error(result.reason)
    expect(existsSync(f.linked)).toBe(false)
    expect(result.report.skipped.join("\n")).toContain(f.branch)
  })

  test("a renamed worktree whose HEAD moved past the reviewed head is still refused", async () => {
    const f = await fixture("renamed-moved")
    git(f.linked, ["branch", "-m", "renamed-branch"])
    writeFileSync(join(f.linked, "more.txt"), "more\n")
    git(f.linked, ["add", "more.txt"])
    git(f.linked, ["commit", "-q", "-m", "more"])
    const { result, calls } = await invoke(f)
    expect(refusal(result)).toContain("worktree.HEAD")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a second cleanup of an already cleaned landing succeeds without touching anything", async () => {
    const f = await fixture("idempotent")
    const first = await invoke(f, { pr: 17 })
    if (!first.result.ok) throw new Error(first.result.reason)
    const second = await invoke(f, { pr: 17 })
    if (!second.result.ok) throw new Error(second.result.reason)
    expect(second.result.alreadyCleaned).toBe(true)
    expect(second.result.report.skipped.join("\n")).toContain("already cleaned")
    expect(mutationCalls(second.calls)).toEqual([])
  })

  test("a worktree recreated at the cleaned path is refused with its path and HEAD, and kept", async () => {
    const f = await fixture("reappeared")
    const first = await invoke(f, { pr: 17 })
    expect(first.result.ok).toBe(true)
    git(f.main, ["worktree", "add", "-q", "-b", "reborn", f.linked])
    writeFileSync(join(f.linked, "new.txt"), "new\n")
    git(f.linked, ["add", "new.txt"])
    git(f.linked, ["commit", "-q", "-m", "new work"])
    const head = git(f.linked, ["rev-parse", "HEAD"]).trim()
    const second = await invoke(f, { pr: 17 })
    const reason = refusal(second.result)
    expect(reason).toContain(f.linked)
    expect(reason).toContain(head)
    expect(mutationCalls(second.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a plain directory at the cleaned path is refused and kept", async () => {
    const f = await fixture("reappeared-dir")
    const first = await invoke(f, { pr: 17 })
    expect(first.result.ok).toBe(true)
    mkdirSync(f.linked)
    writeFileSync(join(f.linked, "mine.txt"), "mine\n")
    const second = await invoke(f, { pr: 17 })
    expect(refusal(second.result)).toContain(f.linked)
    expect(mutationCalls(second.calls)).toEqual([])
    expect(existsSync(join(f.linked, "mine.txt"))).toBe(true)
  })

  test("a cleaned landing whose path is absent but still registered is refused with the path and registered HEAD", async () => {
    const f = await fixture("registered-absent")
    const first = await invoke(f, { pr: 17 })
    expect(first.result.ok).toBe(true)
    const head = "1234567890abcdef1234567890abcdef12345678"
    const second = await invoke(f, { pr: 17 }, { registerAbsent: { path: f.linked, head } })
    const reason = refusal(second.result)
    expect(reason).toContain(f.linked)
    expect(reason).toContain(head)
    expect(mutationCalls(second.calls)).toEqual([])
  })

  test("a registration spelled through a symlinked parent still names the cleaned path", async () => {
    const f = await fixture("registered-alias")
    const first = await invoke(f, { pr: 17 })
    expect(first.result.ok).toBe(true)
    const alias = join(dirname(f.linked), "alias-parent")
    symlinkSync(dirname(f.linked), alias)
    const head = "abcdef1234567890abcdef1234567890abcdef12"
    const spelled = join(alias, basename(f.linked))
    const second = await invoke(f, { pr: 17 }, { registerAbsent: { path: spelled, head } })
    const reason = refusal(second.result)
    expect(reason).toContain(f.linked)
    expect(reason).toContain(head)
    expect(mutationCalls(second.calls)).toEqual([])
  })

  test("a cleaned landing whose worktree list cannot be read is refused, not treated as gone", async () => {
    const f = await fixture("list-unreadable")
    const first = await invoke(f, { pr: 17 })
    expect(first.result.ok).toBe(true)
    const second = await invoke(f, { pr: 17 }, { worktreeListTimeout: true })
    expect(refusal(second.result)).toContain("worktree.list")
    expect(mutationCalls(second.calls)).toEqual([])
  })

  test("a directory created while the worktree list is read is still caught", async () => {
    const f = await fixture("created-during-read")
    const first = await invoke(f, { pr: 17 })
    expect(first.result.ok).toBe(true)
    const second = await invoke(
      f,
      { pr: 17 },
      {
        after: (argv) => {
          if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "list") mkdirSync(f.linked)
        },
      },
    )
    expect(refusal(second.result)).toContain(f.linked)
    expect(mutationCalls(second.calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test.each([
    ["absent", "absent", "absent"],
    ["present", "absent", "present"],
    ["absent", "present", "present"],
    ["unknown", "absent", "unknown"],
    ["absent", "unknown", "unknown"],
    ["unknown", "present", "present"],
  ] as const)("target absence: disk %s and registration %s give %s", (disk, registration, expected) => {
    expect(targetAbsence(disk, registration)).toBe(expected)
  })

  test("a worktree deleted by hand before cleanup is treated as already cleaned", async () => {
    const f = await fixture("gone-by-hand")
    git(f.main, ["worktree", "remove", "--force", f.linked])
    const { result, calls } = await invoke(f)
    if (!result.ok) throw new Error(result.reason)
    expect(result.alreadyCleaned).toBe(true)
    expect(mutationCalls(calls)).toEqual([])
  })
})

describe("delivery_cleanup stash gate on a renamed branch", () => {
  test("a stash on the worktree's renamed branch refuses and removes nothing", async () => {
    const f = await fixture("renamed-stash")
    git(f.linked, ["branch", "-m", "renamed-branch"])
    writeFileSync(join(f.linked, "stashed.txt"), "x\n")
    git(f.linked, ["stash", "push", "-u", "-q", "-m", "keep me"])
    const { result, calls } = await invoke(f)
    expect(refusal(result)).toContain("worktree.stash: observed")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  test("a stash made under the receipt's former branch name still refuses after a rename", async () => {
    const f = await fixture("former-stash")
    writeFileSync(join(f.linked, "stashed.txt"), "x\n")
    git(f.linked, ["stash", "push", "-u", "-q", "-m", "keep me"])
    git(f.linked, ["branch", "-m", "renamed-branch"])
    const { result, calls } = await invoke(f)
    expect(refusal(result)).toContain("worktree.stash: observed")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })
})

describe("reportFromCleanup over the real cleanup", () => {
  test("a receipt ref that moved is preserved and the report says the ref was not deleted", async () => {
    const f = await fixture("report-preserved")
    git(f.linked, ["branch", "-m", "renamed-branch"])
    git(f.main, ["branch", f.branch, f.merge])
    const { result } = await invoke(f)
    const report = reportFromCleanup(result)
    expect(report).toMatchObject({ ok: true, localRefDeleted: false, alreadyCleaned: false })
    expect(report.kept?.join("\n")).toContain("no longer points at the reviewed head")
    expect(git(f.main, ["rev-parse", `refs/heads/${f.branch}`])).toBe(f.merge)
    expect(existsSync(f.linked)).toBe(false)
  })

  test("a worktree already gone is reported as already cleaned with nothing removed", async () => {
    const f = await fixture("report-gone")
    git(f.main, ["worktree", "remove", "--force", f.linked])
    const { result } = await invoke(f)
    const report = reportFromCleanup(result)
    expect(report).toMatchObject({ ok: true, alreadyCleaned: true, localRefDeleted: false })
    expect(report.removed).toBeUndefined()
  })

  test("a removed worktree and deleted branch are reported as removed with the ref deleted", async () => {
    const f = await fixture("report-removed")
    const { result } = await invoke(f)
    expect(reportFromCleanup(result)).toMatchObject({ ok: true, localRefDeleted: true, alreadyCleaned: false, kept: [] })
  })
})

describe("delivery_cleanup round 2", () => {
  test("a stash made while detached at the reviewed head refuses and removes nothing", async () => {
    const f = await fixture("detached-stash")
    git(f.linked, ["checkout", "-q", "--detach"])
    writeFileSync(join(f.linked, "stashed.txt"), "x\n")
    git(f.linked, ["stash", "push", "-u", "-q", "-m", "keep me"])
    expect(git(f.linked, ["stash", "list", "--format=%gs"])).toContain("(no branch)")
    const { result, calls } = await invoke(f)
    expect(refusal(result)).toContain("worktree.stash: observed")
    expect(mutationCalls(calls)).toEqual([])
    expect(existsSync(f.linked)).toBe(true)
  })

  /** Fails the last `show-ref` probe, the one after the removal and the branch step, as a timeout would. */
  const failFinalProbe = (): NonNullable<RunnerOptions["after"]> => {
    let removed = false
    let probes = 0
    return (argv, result) => {
      if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove") removed = true
      if (removed && argv[0] === "git" && argv[1] === "show-ref") {
        probes += 1
        if (probes === 2) Object.assign(result, { ok: false, exitCode: null, error: "timeout" })
      }
    }
  }

  test.each([
    ["a preserved moved ref", (f: Fixture) => git(f.main, ["branch", f.branch, f.merge])],
    ["an already absent ref", () => undefined],
  ])("an unknown final local-ref probe on %s is reported, and the cleaned receipt records the ref unknown", async (_name, arrange) => {
    const f = await fixture("probe-unknown")
    git(f.linked, ["branch", "-m", "renamed-branch"])
    arrange(f)
    const before = listReceipts(receiptDirectory(f.env, f.receipt.repo.key)).length
    const { result } = await invoke(f, { receipt: f.receiptPath }, { after: failFinalProbe() })
    const done = removal(result)
    expect(done.report.skipped.join("\n")).toContain(`local branch ${f.branch}: observed unknown afterwards`)
    expect(done.localRefDeleted).toBe(false)
    expect(done.receipt.worktree).toMatchObject({ removed: true, localRefDeleted: false })
    expect(done.receipt.proof.evidence).toMatchObject({ localRef: "unknown" })
    expect(listReceipts(receiptDirectory(f.env, f.receipt.repo.key))).toHaveLength(before + 1)
  })

  test("a ref that was already absent is reported as such, never as deleted", async () => {
    const f = await fixture("absent-not-deleted")
    git(f.linked, ["branch", "-m", "renamed-branch"])
    const { result } = await invoke(f)
    if (!result.ok) throw new Error(result.reason)
    expect(result.localRefDeleted).toBe(false)
    const report = reportFromCleanup(result)
    expect(report).toMatchObject({ ok: true, localRefDeleted: false })
    expect(report.kept?.join("\n")).toContain("was already gone")
    expect(textAfterCleanup("landed", report)).not.toContain("and its local branch")
  })

  test("a ref cleanup deleted is reported as deleted", async () => {
    const f = await fixture("deleted-reported")
    const { result } = await invoke(f)
    if (!result.ok) throw new Error(result.reason)
    expect(result.localRefDeleted).toBe(true)
  })
})
