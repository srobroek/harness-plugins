import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, setDefaultTimeout, setSystemTime, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { landingFile, readLanding, removeClaim, writeClaim } from "@srobroek/opencode-lib/worktree-claims"
import { holdsState } from "@srobroek/opencode-lib/worktree-locks"
import type { CleanupDeps, CleanupResult } from "./cleanup.ts"
import * as realCleanup from "./cleanup.ts"
import { registryFile } from "./clone-registry.ts"
import { type CliRunner, runCli } from "./forge-adapter.ts"
import * as realLand from "./land.ts"
import { buildReceipt, type GitRunner, type LandingReceipt, listReceipts, receiptDirectory, repositoryContext, writeReceipt } from "./landing-receipt.ts"

// Landing needs a forge and cleanup needs a real remote; both are replaced so the test sees only how
// the registered tools and the turn-end retry chain them across two real repositories: the session's
// (A) and the one a landing targets (B).
const originalCleanup = { ...realCleanup }
// These tests run real git (two `git init` repositories and observed git calls). The 14 tests of this file
// and clone-registry.test.ts took 15 s together alone (about 1 s each); under full-suite load fixtures took
// 20 s or more. 60 s keeps three times that headroom; Bun's 5 s default fails when machines are busy.
setDefaultTimeout(60_000)
const originalLand = { ...realLand }

let repoA = ""
let repoB = ""
let commonA = ""
let commonB = ""
let receiptsRoot = ""
let worktree = ""
let sequence = 0
/** Bead ids the mocked landing records; non-empty makes the target's ledger active. */
let beadIds: string[] = []
let cleanupResult: CleanupResult
/** Called for each mocked cleanup; a result it returns replaces `cleanupResult` for that call. */
let onCleanup: ((params: Record<string, unknown>) => CleanupResult | undefined) | undefined
let cleanupCalls: Array<{ params: Record<string, unknown>; deps: CleanupDeps }> = []
const env = (): NodeJS.ProcessEnv => ({ HOME: process.env.HOME ?? "", DELIVERY_RECEIPTS_DIR: receiptsRoot })
const disposers: Array<() => Promise<void>> = []

const FAILED: CleanupResult = { ok: false, reason: "worktree.status: dirty" }
const REMOVED = { ok: true, path: "/r", receipt: { branch: { name: "feat" }, worktree: { path: "/w" } }, remoteBranchAbsence: "absent", alreadyCleaned: false, localRefDeleted: true, report: { removed: ["worktree"], skipped: [] } } as never

async function receiptIn(repoRoot: string, now: number, over: Partial<Parameters<typeof buildReceipt>[0]> = {}): Promise<LandingReceipt> {
  const context = await repositoryContext(repoRoot)
  if (context === null) throw new Error("fixture repository has no context")
  return buildReceipt({
    now,
    emitter: { plugin: "test", version: "0", tool: "delivery_land" },
    repo: { key: context.key, canonicalRoot: context.ledger.root, remote: "origin", forge: "github", nameWithOwner: "o/b" },
    pr: {
      number: 7,
      url: "https://github.com/o/b/pull/7",
      state: "MERGED",
      baseRefName: "main",
      headRefName: "feat",
      headRefOid: "a".repeat(40),
      mergeCommitOid: "b".repeat(40),
      mergedAt: "2027-01-15T08:00:00.000Z",
    },
    branch: { name: "feat", deletedRemote: true, remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z", autoDeleteSetting: "on" },
    worktree: { path: worktree, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
    beads: { ids: [], ledgerActive: false },
    proof: { method: "gh pr view", observedAt: "2027-01-15T08:00:00.000Z", evidence: { state: "MERGED" } },
    outcome: "landed",
    ...over,
  })
}

beforeAll(async () => {
  const init = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "clones-repo-"))
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
    return dir
  }
  repoA = init()
  repoB = init()
  commonA = (await repositoryContext(repoA))?.commonDir as string
  commonB = (await repositoryContext(repoB))?.commonDir as string
  mock.module("./cleanup.ts", () => ({
    ...originalCleanup,
    cleanupDelivery: async (params: Record<string, unknown>, _cwd: string, deps: CleanupDeps) => {
      cleanupCalls.push({ params, deps })
      return onCleanup?.(params) ?? cleanupResult
    },
  }))
  mock.module("./land.ts", () => ({
    ...originalLand,
    landPullRequest: async () => {
      const receipt = await receiptIn(repoB, Date.now() + ++sequence, beadIds.length === 0 ? {} : { beads: { ids: beadIds, ledgerActive: true } })
      const receiptPath = writeReceipt(receipt, receiptDirectory(env(), receipt.repo.key))
      return { ok: true, receipt, receiptPath, text: "landed", next: [] }
    },
  }))
})
afterAll(() => {
  rmSync(repoA, { recursive: true, force: true })
  rmSync(repoB, { recursive: true, force: true })
  mock.module("./cleanup.ts", () => originalCleanup)
  mock.module("./land.ts", () => originalLand)
})
beforeEach(() => {
  receiptsRoot = mkdtempSync(join(tmpdir(), "clones-receipts-"))
  worktree = mkdtempSync(join(tmpdir(), "clones-worktree-"))
  cleanupCalls = []
  cleanupResult = FAILED
  onCleanup = undefined
  beadIds = []
})
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  removeClaim(commonB, worktree)
  rmSync(receiptsRoot, { recursive: true, force: true })
  rmSync(worktree, { recursive: true, force: true })
})

type Result = { output: Record<string, unknown>; content: string }
type Session = {
  fake: ReturnType<typeof createFakeContext>
  land: () => Promise<Result>
  cleanup: (input: Record<string, unknown>) => Promise<Result>
  /** What the host does at a turn end for the session. */
  idle: (background?: unknown[]) => Promise<void>
  dispose: () => Promise<void>
}

/** A fresh `setupDelivery`: a new process, as after a server restart. */
async function session(
  sessionID = "s",
  cleanup?: NonNullable<Parameters<typeof import("./index.ts").setupDelivery>[1]>["cleanup"],
  observe?: GitRunner,
): Promise<Session> {
  const fake = createFakeContext({ directory: repoA })
  const context = fake.context as unknown as { location: unknown; worktree: unknown; options: unknown }
  context.location = { ...(context.location as object), project: { id: "prj" } }
  context.options = { receiptsDirectory: receiptsRoot }
  context.worktree = { list: async () => [], remove: async () => {} }
  const { setupDelivery, LAND_ACTION, CLEANUP_ACTION } = await import("./index.ts")
  const dispose = await setupDelivery(fake.context, {
    debounceMs: 0,
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(observe === undefined ? {} : { observe }),
  })
  disposers.push(dispose)
  const call = { sessionID, agent: "a", messageID: "m", id: "c", signal: new AbortController().signal }
  const run = (name: string, input: unknown): Promise<Result> => {
    const execute = fake.tools.get(name)?.execute as ((i: unknown, c: unknown) => Promise<Result>) | undefined
    if (!execute) throw new Error(`${name} is not registered`)
    return execute(input, call)
  }
  return {
    fake,
    land: () => run(LAND_ACTION, { pr: 7, repo: "o/b", repoPath: repoB }),
    cleanup: (input) => run(CLEANUP_ACTION, input),
    idle: async (background = []) => {
      await fake.fire.session("experimental.idle", { sessionID, background })
    },
    dispose,
  }
}

/** The session repository's registry: a JSON list of entries; undefined when absent or empty. */
const registryOf = async () => {
  const file = registryFile(env(), (await repositoryContext(repoA))?.key as string)
  if (!existsSync(file)) return undefined
  const clones = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>
  return clones.length === 0 ? undefined : { clones }
}

test("a landing whose cleanup did not finish is registered under .clones and retried at the turn end", async () => {
  const s = await session()
  const landed = await s.land()
  expect(landed.output.cleanup).toMatchObject({ ok: false })
  expect(registryFile(env(), (await repositoryContext(repoA))?.key as string).startsWith(join(receiptsRoot, ".clones"))).toBe(true)
  const registry = await registryOf()
  expect(registry).toMatchObject({ clones: [{ commonDir: commonB, root: (await repositoryContext(repoB))?.ledger.root, repo: "o/b" }] })
  expect(registry?.clones[0]?.receiptIds).toHaveLength(1)
  const [receiptId] = (registry?.clones[0]?.receiptIds as string[] | undefined) ?? []
  expect(readLanding(commonB, receiptId as string).kind).toBe("present")
  expect(readLanding(commonA, receiptId as string).kind).toBe("missing")

  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle()
  const params = cleanupCalls.map((c) => c.params)
  expect(params).toEqual([
    { receipt: join(receiptDirectory(env(), registry?.clones[0]?.key as string), `${receiptId}.json`), repo: "o/b", repoPath: (await repositoryContext(repoB))?.ledger.root },
  ])
  expect((await registryOf())).toBeUndefined()
})

test("a fresh setupDelivery after a restart still finds the registered receipts", async () => {
  const first = await session()
  await first.land()
  await first.dispose()
  cleanupCalls = []
  cleanupResult = REMOVED
  const restarted = await session()
  await restarted.idle()
  expect(cleanupCalls).toHaveLength(1)
  expect(cleanupCalls[0]?.params).toMatchObject({ repo: "o/b" })
})

test("a lane claim in the target keeps the retry from cleaning, and the registration stays", async () => {
  const s = await session()
  await s.land()
  writeClaim(commonB, { directory: worktree, branch: "lane-a", sessionID: "c", parentID: "p", createdAt: 1 })
  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle()
  expect(cleanupCalls).toEqual([])
  expect((await registryOf())?.clones).toHaveLength(1)
})

/** Land in B, then write the cleaned receipt that settles it; returns what the tests need to clean it up. */
async function landAndSettle(s: Session) {
  await s.land()
  return settleRegistered()
}

/** Write the cleaned receipt that settles the registered landing in B. */
async function settleRegistered() {
  const registry = await registryOf()
  const [receiptId] = (registry?.clones[0]?.receiptIds as string[] | undefined) ?? []
  const directory = receiptDirectory(env(), registry?.clones[0]?.key as string)
  const landed = JSON.parse(readFileSync(join(directory, `${receiptId}.json`), "utf8")) as LandingReceipt
  writeReceipt(
    await receiptIn(repoB, Date.now() + 5000, {
      continues: landed,
      outcome: "cleaned",
      worktree: { path: worktree, removed: true, localRefDeleted: true, absenceVerifiedAt: "2027-01-15T08:00:02.000Z" },
    }),
    directory,
  )
  return { receiptId: receiptId as string, directory, receiptPath: join(directory, `${receiptId}.json`), landed }
}

test("an explicit cleanup that settles the receipt also collects the target's landing record before unregistering", async () => {
  const s = await session()
  const { receiptId, receiptPath, landed } = await landAndSettle(s)
  expect(readLanding(commonB, receiptId).kind).toBe("present")
  cleanupResult = { ...(REMOVED as object), receipt: landed } as never
  await s.cleanup({ receipt: receiptPath, repo: "o/b", repoPath: repoB })
  expect((await registryOf())).toBeUndefined()
  expect(readLanding(commonB, receiptId).kind).toBe("missing")
})

test("a clone stays registered while another receipt of its repository is still pending", async () => {
  const s = await session()
  const { directory } = await landAndSettle(s)
  // A second landing in the same repository, for another worktree, that this session never registered.
  const other = mkdtempSync(join(tmpdir(), "clones-worktree2-"))
  try {
    const second = await receiptIn(repoB, Date.now() + 100, {
      pr: {
        number: 8,
        url: "https://github.com/o/b/pull/8",
        state: "MERGED",
        baseRefName: "main",
        headRefName: "feat-two",
        headRefOid: "c".repeat(40),
        mergeCommitOid: "d".repeat(40),
        mergedAt: "2027-01-15T08:00:00.000Z",
      },
      branch: { name: "feat-two", deletedRemote: true, remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z", autoDeleteSetting: "on" },
      worktree: { path: other, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
    })
    writeReceipt(second, directory)
    // The first receipt is settled, so the pass settles its registration; the second is not.
    cleanupResult = FAILED
    await s.idle()
    expect((await registryOf())?.clones).toHaveLength(1)
    // The clone is still discovered: a shell in the second worktree holds it ...
    await s.idle([{ kind: "shell", shellID: "sh1", command: `tail -f ${other}/log` }])
    expect(holdsState(commonB, other, Date.now())).toBeDefined()
    // ... and its cleanup is retried once the retry window has passed.
    cleanupCalls = []
    cleanupResult = REMOVED
    setSystemTime(new Date(Date.now() + 60_000))
    try {
      await s.idle([])
    } finally {
      setSystemTime()
    }
    expect(cleanupCalls.map((call) => call.params.receipt)).toContain(join(directory, `${second.receiptId}.json`))
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

// bun lists lazily, so chmod 000 fails at the first read; a directory that is gone fails when it is opened, as
// an unreadable one does under Node. Both must keep the registration: only a listing can say nothing is pending.
test.each([
  ["unreadable (chmod 000)", "chmod"],
  ["missing", "rename"],
] as const)("a receipt directory that is %s keeps the clone registered while another receipt is pending", async (_name, how) => {
  if (how === "chmod" && process.getuid?.() === 0) return // root reads any directory
  const s = await session()
  await s.land()
  const registry = await registryOf()
  const [receiptId] = (registry?.clones[0]?.receiptIds as string[] | undefined) ?? []
  const directory = receiptDirectory(env(), registry?.clones[0]?.key as string)
  const receiptPath = join(directory, `${receiptId}.json`)
  const away = `${directory}.away`
  const other = mkdtempSync(join(tmpdir(), "clones-worktree2-"))
  try {
    // R2: another landing in the same repository, for another worktree, that this session never registered.
    const second = await receiptIn(repoB, Date.now() + 100, {
      pr: {
        number: 8,
        url: "https://github.com/o/b/pull/8",
        state: "MERGED",
        baseRefName: "main",
        headRefName: "feat-two",
        headRefOid: "c".repeat(40),
        mergeCommitOid: "d".repeat(40),
        mergedAt: "2027-01-15T08:00:00.000Z",
      },
      branch: { name: "feat-two", deletedRemote: true, remoteAbsenceVerifiedAt: "2027-01-15T08:00:01.000Z", autoDeleteSetting: "on" },
      worktree: { path: other, removed: false, localRefDeleted: false, absenceVerifiedAt: null },
    })
    writeReceipt(second, directory)
    // R1's cleanup succeeds, and the directory becomes unreadable right after it, before the settlement;
    // R2's cleanup does not finish.
    onCleanup = (params) => {
      if (params.receipt !== receiptPath) return FAILED
      if (how === "chmod") chmodSync(directory, 0o000) // check-test-executables: directory permission, not a script
      else renameSync(directory, away)
      return REMOVED
    }
    try {
      await s.idle()
    } finally {
      if (existsSync(away)) renameSync(away, directory)
      chmodSync(directory, 0o700) // check-test-executables: directory permission, not a script
    }
    expect((await registryOf())?.clones).toHaveLength(1)
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test("a landing record the target cannot read keeps the registration: collection is incomplete", async () => {
  const s = await session()
  const { receiptId, receiptPath, landed } = await landAndSettle(s)
  writeFileSync(landingFile(commonB, `${receiptId}-broken`), "{not json")
  cleanupResult = { ...(REMOVED as object), receipt: landed } as never
  await s.cleanup({ receipt: receiptPath, repo: "o/b", repoPath: repoB })
  expect((await registryOf())?.clones).toHaveLength(1)
  expect(readLanding(commonB, receiptId).kind).toBe("present")
  rmSync(landingFile(commonB, `${receiptId}-broken`), { force: true })
  await s.cleanup({ receipt: receiptPath, repo: "o/b", repoPath: repoB })
  expect((await registryOf())).toBeUndefined()
})

test("the end-of-turn pass keeps a superseded receipt registered while the target has an unreadable landing record", async () => {
  const s = await session()
  const { receiptId } = await landAndSettle(s)
  writeFileSync(landingFile(commonB, `${receiptId}-broken`), "{not json")
  await s.idle()
  expect((await registryOf())?.clones).toHaveLength(1)
  expect(readLanding(commonB, receiptId).kind).toBe("present")
  rmSync(landingFile(commonB, `${receiptId}-broken`), { force: true })
  await s.idle()
  expect((await registryOf())).toBeUndefined()
  expect(readLanding(commonB, receiptId).kind).toBe("missing")
})

test("a registry that cannot be written is reported, not hidden: at landing and when collecting", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    // At landing: `.clones` is a file, so the registration cannot be written.
    writeFileSync(join(receiptsRoot, ".clones"), "not a directory")
    const s = await session()
    await s.land()
    expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toContain("could not record the clone")
    const recorded = errors.mock.calls.find((call) => String(call[0]).includes("could not record the clone"))?.[1] as Error | undefined
    expect(recorded).toBeInstanceOf(Error)
    rmSync(join(receiptsRoot, ".clones"), { force: true })

    // When collecting: the entry is settled but the registry directory refuses the change.
    errors.mockClear()
    await s.land()
    const registry = await registryOf()
    const [receiptId] = (registry?.clones[0]?.receiptIds as string[] | undefined) ?? []
    const directory = receiptDirectory(env(), registry?.clones[0]?.key as string)
    const landed = JSON.parse(readFileSync(join(directory, `${receiptId}.json`), "utf8")) as LandingReceipt
    // Both landings of this test (the first one's registration was only in memory) are settled, so nothing pending keeps the clone.
    for (const [index, earlier] of listReceipts(directory).entries()) {
      writeReceipt(
        await receiptIn(repoB, Date.now() + 5000 + index, {
          continues: earlier,
          outcome: "cleaned",
          worktree: { path: worktree, removed: true, localRefDeleted: true, absenceVerifiedAt: "2027-01-15T08:00:02.000Z" },
        }),
        directory,
      )
    }
    const registryDirectory = join(receiptsRoot, ".clones")
    chmodSync(registryDirectory, 0o500) // check-test-executables: directory permission, not a script
    try {
      cleanupResult = { ...(REMOVED as object), receipt: landed } as never
      await s.cleanup({ receipt: join(directory, `${receiptId}.json`), repo: "o/b", repoPath: repoB })
    } finally {
      chmodSync(registryDirectory, 0o700) // check-test-executables: directory permission, not a script
    }
    expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toContain("clone registry")
  } finally {
    errors.mockRestore()
  }
})

test("a source repository that cannot be observed does not hide a background shell in the target worktree: nothing is removed", async () => {
  const real = (argv: readonly string[], cwd: string, timeoutMs: number): string | null => {
    try {
      return execFileSync("git", [...argv], { cwd, timeout: timeoutMs, encoding: "utf8" })
    } catch {
      return null
    }
  }
  // Observing the session's own repository fails; the target's works.
  const observe: GitRunner = (argv, cwd, timeoutMs) => (cwd === repoA ? null : real(argv, cwd, timeoutMs))
  const s = await session("s", undefined, observe)
  await s.land()
  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle([{ kind: "shell", shellID: "sh1", command: `tail -f ${worktree}/log` }])
  expect(cleanupCalls).toEqual([])
  expect((await registryOf())?.clones).toHaveLength(1)
})

test("control: with the same unobservable source and no background shell the retry does clean the target", async () => {
  const observe: GitRunner = (argv, cwd, timeoutMs) => {
    if (cwd === repoA) return null
    try {
      return execFileSync("git", [...argv], { cwd, timeout: timeoutMs, encoding: "utf8" })
    } catch {
      return null
    }
  }
  const s = await session("s", undefined, observe)
  await s.land()
  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle([])
  expect(cleanupCalls).toHaveLength(1)
})

test("the reminder for a registered landing in another repository runs its close-out in that clone, without the session's bead pin", async () => {
  mkdirSync(join(repoB, ".beads"))
  try {
    beadIds = ["omp-1"]
    const open: CliRunner = async (argv, options) =>
      argv[0] === "bd"
        ? { ok: true, exitCode: 0, stdout: JSON.stringify({ schema_version: 1, data: [{ id: "omp-1", status: "open", metadata: {} }] }), stderr: "" }
        : runCli(argv, options)
    const s = await session("s", { run: open })
    await s.land()
    await s.idle()
    const reminders = s.fake.calls.filter((call) => call.method === "session.synthetic").map((call) => JSON.stringify(call.input))
    expect(reminders).toHaveLength(1)
    const root = (await repositoryContext(repoB))?.ledger.root as string
    const text = String((JSON.parse(reminders[0] as string) as { text: string }).text)
    expect(text).toContain(`bd -C '${root}' update omp-1`)
    expect(text).toContain(`bd -C '${root}' close omp-1`)
    expect(text).not.toMatch(/(^|; |\()bd (update|close)/)
  } finally {
    rmSync(join(repoB, ".beads"), { recursive: true, force: true })
  }
})

test("a receipt id the session's repository also has does not keep the target's worktree from its retry", async () => {
  const s = await session()
  await s.land()
  const [receiptId] = ((await registryOf())?.clones[0]?.receiptIds as string[] | undefined) ?? []
  // The same id in the session's own repository (one clock tick and one merge commit), whose worktree is gone:
  // that pass marks the id done, and the clone's receipt must not be taken for it.
  const sameId = await receiptIn(repoA, Number((receiptId as string).split("-")[0]), {
    worktree: { path: join(worktree, "gone"), removed: false, localRefDeleted: false, absenceVerifiedAt: null },
  })
  expect(sameId.receiptId).toBe(receiptId as string)
  writeReceipt(sameId, receiptDirectory(env(), sameId.repo.key))
  cleanupCalls = []
  cleanupResult = REMOVED
  await s.idle()
  expect(cleanupCalls.map((call) => call.params.repo)).toEqual(["o/b"])
})

test("a shell another session reports in the target worktree is held, though that session did not land there", async () => {
  const lander = await session("lander")
  await lander.land()
  const reporter = await session("reporter")
  await reporter.idle([{ kind: "shell", shellID: "sh1", command: `tail -f ${worktree}/log` }])
  expect(holdsState(commonB, worktree, Date.now())).toBeDefined()
  cleanupCalls = []
  cleanupResult = REMOVED
  await lander.idle()
  expect(cleanupCalls).toEqual([])
})

test("a registration that cannot be persisted stays in memory: the retry and the holds still reach the clone", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    // `.clones` is a file, so the registry cannot be written.
    writeFileSync(join(receiptsRoot, ".clones"), "not a directory")
    const s = await session()
    await s.land()
    cleanupCalls = []
    cleanupResult = REMOVED
    await s.idle([{ kind: "shell", shellID: "sh1", command: `tail -f ${worktree}/log` }])
    expect(holdsState(commonB, worktree, Date.now())).toBeDefined()
    expect(cleanupCalls).toEqual([])
    await s.idle([])
    expect(cleanupCalls).toHaveLength(1)
  } finally {
    errors.mockRestore()
  }
})

/** The target's identity as a cleanup in its clone hands it to `coordinate`. */
const targetIdentity = async () => ({ common: commonB, root: (await repositoryContext(repoB))?.ledger.root as string })

/** The coordination a cleanup in the target gets from the last cleanup call's deps. */
const lastCoordination = async () => {
  const deps = cleanupCalls.at(-1)?.deps as unknown as { coordinate: (identity: unknown) => Promise<{ finalCheck: (worktree: string) => Promise<string | undefined> }> }
  return deps.coordinate(await targetIdentity())
}

/** Make the target's receipt directory unreadable while `work` runs. */
const withUnreadableReceipts = async (work: () => Promise<unknown>) => {
  const directory = receiptDirectory(env(), (await repositoryContext(repoB))?.key as string)
  chmodSync(directory, 0o000) // check-test-executables: directory permission, not a script
  try {
    await work()
  } finally {
    chmodSync(directory, 0o700) // check-test-executables: directory permission, not a script
  }
}

const SHELL = () => [{ kind: "shell", shellID: "sh1", command: `tail -f ${worktree}/log` }]

test("a fresh instance runs discovery before an explicit cleanup in the target: an unreadable registry refuses it", async () => {
  if (process.getuid?.() === 0) return // root reads any file
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const first = await session()
    await first.land()
    const receiptId = (((await registryOf())?.clones[0]?.receiptIds as string[] | undefined) ?? [])[0] as string
    await first.dispose()
    const file = registryFile(env(), (await repositoryContext(repoA))?.key as string)
    // No idle pass runs in the fresh instance: only the removal's own checks can see the registry.
    const fresh = await session()
    let refused: string | undefined
    onCleanup = (() =>
      (async () => {
        chmodSync(file, 0o000) // check-test-executables: registry file permission, not a script
        try {
          refused = await (await lastCoordination()).finalCheck(worktree)
        } finally {
          chmodSync(file, 0o600) // check-test-executables: registry file permission, not a script
        }
        return FAILED
      })()) as never
    await fresh.cleanup({ receipt: join(receiptDirectory(env(), (await repositoryContext(repoB))?.key as string), `${receiptId}.json`), repo: "o/b", repoPath: repoB })
    expect(refused).toContain("clone registry")
    // Readable again, the same check allows it.
    expect(await (await lastCoordination()).finalCheck(worktree)).toBeUndefined()
  } finally {
    errors.mockRestore()
  }
})

test("a report that missed the clones keeps the target's worktree until that session reports again, though the registry is readable again", async () => {
  if (process.getuid?.() === 0) return // root reads any file
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const s = await session()
    await s.land()
    cleanupResult = REMOVED
    const file = registryFile(env(), (await repositoryContext(repoA))?.key as string)
    chmodSync(file, 0o000) // check-test-executables: registry file permission, not a script
    try {
      await s.fake.fire.session("experimental.idle", { sessionID: "a", background: SHELL() })
    } finally {
      chmodSync(file, 0o600) // check-test-executables: registry file permission, not a script
    }
    cleanupCalls = []
    await s.fake.fire.session("experimental.idle", { sessionID: "b", background: [] })
    expect(cleanupCalls).toEqual([])
    await s.fake.fire.session("experimental.idle", { sessionID: "a", background: [] })
    expect(cleanupCalls).toHaveLength(1)
  } finally {
    errors.mockRestore()
  }
})

test.each([
  ["its receipts cannot be listed", "receipts"],
  ["the clone cannot be resolved", "clone"],
] as const)("when %s, one session's failed report holds the target until that session reports again, whatever another session reports", async (_name, how) => {
  if (how === "receipts" && process.getuid?.() === 0) return // root reads any directory
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const s = await session()
    await s.land()
    cleanupResult = REMOVED
    const report = () => s.fake.fire.session("experimental.idle", { sessionID: "a", background: SHELL() })
    if (how === "receipts") await withUnreadableReceipts(report)
    else {
      const away = `${repoB}.away`
      renameSync(repoB, away)
      try {
        await report()
      } finally {
        renameSync(away, repoB)
      }
      // The veto is reported where it is set.
      expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toContain("could not be resolved to record the running work of a")
    }
    cleanupCalls = []
    await s.fake.fire.session("experimental.idle", { sessionID: "b", background: [] })
    expect(cleanupCalls).toEqual([])
    await s.fake.fire.session("experimental.idle", { sessionID: "a", background: [] })
    expect(cleanupCalls).toHaveLength(1)
  } finally {
    errors.mockRestore()
  }
})

test("a hold scan that fails while the final check lists sessions refuses the removal", async () => {
  if (process.getuid?.() === 0) return // root reads any directory
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const s = await session()
    await s.land()
    const client = s.fake.context.session as unknown as { list: (query: Record<string, unknown>) => Promise<unknown> }
    const list = client.list.bind(client)
    let gate: { started: () => void; release: Promise<void> } | undefined
    client.list = async (query) => {
      const held = gate
      if (held !== undefined && "directory" in query) {
        gate = undefined
        held.started()
        await held.release
      }
      return list(query)
    }
    const receiptId = (((await registryOf())?.clones[0]?.receiptIds as string[] | undefined) ?? [])[0] as string
    let refused: string | undefined
    onCleanup = (() =>
      (async () => {
        let started: () => void = () => {}
        let release: () => void = () => {}
        const listing = new Promise<void>((done) => {
          started = done
        })
        gate = { started, release: new Promise<void>((done) => (release = done)) }
        const check = (await lastCoordination()).finalCheck(worktree)
        await listing
        // While the listing is awaited, a report's hold scan in the target fails and the report finishes.
        await withUnreadableReceipts(() => s.fake.fire.session("experimental.idle", { sessionID: "a", background: SHELL() }))
        release()
        refused = await check
        return FAILED
      })()) as never
    await s.cleanup({ receipt: join(receiptDirectory(env(), (await repositoryContext(repoB))?.key as string), `${receiptId}.json`), repo: "o/b", repoPath: repoB })
    expect(refused).toContain("the running work of a could not be recorded")
  } finally {
    errors.mockRestore()
  }
})

/** The receipt path of the session's registered landing in the target. */
const landedReceipt = async () => {
  const receiptId = (((await registryOf())?.clones[0]?.receiptIds as string[] | undefined) ?? [])[0] as string
  return join(receiptDirectory(env(), (await repositoryContext(repoB))?.key as string), `${receiptId}.json`)
}

/** Let an emitted event reach the plugin's subscription. */
const delivered = () => new Promise((done) => setTimeout(done, 20))

test("an empty report whose hold scan fails creates no veto", async () => {
  if (process.getuid?.() === 0) return // root reads any directory
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const s = await session()
    await s.land()
    cleanupResult = REMOVED
    await withUnreadableReceipts(() => s.fake.fire.session("experimental.idle", { sessionID: "a", background: [] }))
    cleanupCalls = []
    await s.fake.fire.session("experimental.idle", { sessionID: "b", background: [] })
    expect(cleanupCalls).toHaveLength(1)
  } finally {
    errors.mockRestore()
  }
})

test("a deleted session's veto goes, and while it holds the log names the session and what lifts it", async () => {
  if (process.getuid?.() === 0) return // root reads any directory
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const s = await session()
    await s.land()
    cleanupResult = REMOVED
    await withUnreadableReceipts(() => s.fake.fire.session("experimental.idle", { sessionID: "a", background: SHELL() }))
    cleanupCalls = []
    errors.mockClear()
    await s.fake.fire.session("experimental.idle", { sessionID: "b", background: [] })
    expect(cleanupCalls).toEqual([])
    const logged = errors.mock.calls.map((call) => String(call[0])).join("\n")
    expect(logged).toContain("held for session a until it reports again with its running work recorded, reports no running work, or is deleted")
    s.fake.emit({ type: "session.deleted", data: { sessionID: "a" } })
    await delivered()
    await s.fake.fire.session("experimental.idle", { sessionID: "b", background: [] })
    expect(cleanupCalls).toHaveLength(1)
  } finally {
    errors.mockRestore()
  }
})

test("a veto on a clone the next report leaves out (nothing pending there) goes with that report", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const s = await session()
    await s.land()
    // A pending receipt there, but this session's shell report cannot reach the clone: a veto there.
    const away = `${repoB}.away`
    renameSync(repoB, away)
    try {
      await s.fake.fire.session("experimental.idle", { sessionID: "a", background: SHELL() })
    } finally {
      renameSync(away, repoB)
    }
    // Settled now: the next report of running work lists the clones, and this one is left out.
    await settleRegistered()
    await s.fake.fire.session("experimental.idle", { sessionID: "a", background: [{ kind: "shell", shellID: "sh2", command: "sleep 60" }] })
    // A new landing there is cleaned: the old veto is gone.
    await s.land()
    cleanupCalls = []
    cleanupResult = REMOVED
    await s.fake.fire.session("experimental.idle", { sessionID: "b", background: [] })
    expect(cleanupCalls).toHaveLength(1)
  } finally {
    errors.mockRestore()
  }
})

test("a registry that becomes unreadable while the final check lists sessions refuses the removal", async () => {
  if (process.getuid?.() === 0) return // root reads any file
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const s = await session()
    await s.land()
    const file = registryFile(env(), (await repositoryContext(repoA))?.key as string)
    const client = s.fake.context.session as unknown as { list: (query: Record<string, unknown>) => Promise<unknown> }
    const list = client.list.bind(client)
    let armed = false
    client.list = async (query) => {
      if (armed && "directory" in query) {
        armed = false
        // No idle report notices this: only the final check's own reread can.
        chmodSync(file, 0o000) // check-test-executables: registry file permission, not a script
      }
      return list(query)
    }
    let refused: string | undefined
    onCleanup = (() =>
      (async () => {
        armed = true
        try {
          refused = await (await lastCoordination()).finalCheck(worktree)
        } finally {
          chmodSync(file, 0o600) // check-test-executables: registry file permission, not a script
        }
        return FAILED
      })()) as never
    await s.cleanup({ receipt: await landedReceipt(), repo: "o/b", repoPath: repoB })
    expect(refused).toContain("clone registry")
  } finally {
    errors.mockRestore()
  }
})

/** Hide the session's repository from git and from its `.git` marker while `work` runs. */
const withoutSourceRepository = async (work: () => Promise<void>) => {
  const marker = join(repoA, ".git")
  const away = `${marker}.away`
  renameSync(marker, away)
  try {
    await work()
  } finally {
    renameSync(away, marker)
  }
}

test("a fresh instance whose own repository resolves neither by git nor by its .git marker refuses cleanup in the target", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const first = await session()
    await first.land()
    const receipt = await landedReceipt()
    await first.dispose()
    let refused: string | undefined
    await withoutSourceRepository(async () => {
      const fresh = await session()
      onCleanup = (() =>
        (async () => {
          refused = await (await lastCoordination()).finalCheck(worktree)
          return FAILED
        })()) as never
      await fresh.cleanup({ receipt, repo: "o/b", repoPath: repoB })
    })
    expect(refused).toContain("the session's repository could not be resolved")
  } finally {
    errors.mockRestore()
  }
})

test("a report of running work while the session's repository resolves neither way holds the target after it resolves again", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const first = await session()
    await first.land()
    const receipt = await landedReceipt()
    await first.dispose()
    let fresh: Session | undefined
    await withoutSourceRepository(async () => {
      fresh = await session()
      await fresh.fake.fire.session("experimental.idle", { sessionID: "a", background: SHELL() })
    })
    let refused: string | undefined
    onCleanup = (() =>
      (async () => {
        refused = await (await lastCoordination()).finalCheck(worktree)
        return FAILED
      })()) as never
    await fresh?.cleanup({ receipt, repo: "o/b", repoPath: repoB })
    expect(refused).toContain("held for session a")
  } finally {
    errors.mockRestore()
  }
})
