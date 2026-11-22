import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { landingFile, readClaim, removeClaim, writeClaim, writeLanding } from "@srobroek/opencode-lib/worktree-claims"
import { lockFile, readHolds, setHold, withDiskLock } from "@srobroek/opencode-lib/worktree-locks"
import type { RunResult } from "./git.ts"
import { createPlugin } from "./index.ts"
import { type Lane, laneKey } from "./lane.ts"
import { type Lifecycle, within } from "./lifecycle.ts"

const PARENT = "ses_parent"
const CHILD = "ses_child"
/** A child that exists and is idle (resumable): its lane is kept. */
const IDLE = { [CHILD]: { busy: 1, idle: 2 } }
const REPO = "/repo"
const WT = "/wt/lane-a"
const BASE = "b".repeat(40)
const TIP = "t".repeat(40)
const TIP2 = "u".repeat(40)
const MAIN0 = "m".repeat(40)
const NOW = 100_000_000
const COMMONS: string[] = []
// Removed after each test, not once at the end: under `--rerun-each 20` the end-of-file hook deleted thousands of
// directories at once and, on a loaded machine, exceeded bun's 5 s hook timeout (bead harness-plugins-a2n.8).
afterEach(() => {
  for (const root of COMMONS.splice(0)) rmSync(root, { recursive: true, force: true })
})

type World = {
  ahead: number
  porcelain: string
  /** `merge-base --is-ancestor` exit code. */
  ancestor: number
  /** Refs whose answer overrides `ancestor`: the commits each ref contains. */
  contains?: Record<string, string[]>
  /** The tip is already reachable from the main commit the lane was created at: no work of its own. */
  inMainAtCreation?: boolean
  openBranches: string[]
  /** `git stash list` subjects. */
  stash?: string
  /** Session `time` by id. */
  time: Record<string, Record<string, number>>
  exists: boolean
  now: number
  /** HEAD of the worktree, and what `refs/heads/lane-a` points at. */
  head: string
  branchOid: string
  /** The worktree is on its branch (not detached). */
  onBranch: boolean
  updateRefFails: boolean
  resumedByB?: boolean
  /** Paths that do not exist on disk, whatever `exists` says. */
  missing?: string[]
  /** Paths whose existence check fails with this errno code instead of answering. */
  statErrors?: Record<string, string>
  /** Called after each existence check, with its path and answer. */
  onExists?: (path: string, exists: boolean) => void
  /** Called inside the host removal. */
  onRemove?: () => void
  /** Called with every git command before it is answered. */
  /** `log` is the asking instance's own command log, so a test can tell two instances apart. */
  onGit?: (cmd: string, log: string[][]) => Promise<void> | void
}

type Fake = ReturnType<typeof createFakeContext>

const lane = (over: Partial<Lane> = {}): Lane => ({
  child: CHILD,
  parent: PARENT,
  projectID: "prj",
  directory: WT,
  branch: "lane-a",
  base: BASE,
  mainAtCreation: MAIN0,
  parentDir: REPO,
  title: "Write hello",
  state: "active",
  ...over,
})

function runner(world: World, log: string[][]) {
  return async (argv: string[]): Promise<RunResult> => {
    log.push(argv)
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" })
    // Only the open pull request list is read: it quiets the idle gate's unresolved-lane nudge.
    if (argv[0] === "gh") return ok(JSON.stringify(world.openBranches.map((headRefName) => ({ headRefName }))))
    if (argv.includes("ls-files")) return ok()
    const cmd = argv.slice(3).join(" ")
    await world.onGit?.(cmd, log)
    if (cmd.startsWith("rev-list --count")) return ok(`${world.ahead}\n`)
    if (cmd === "status --porcelain") return ok(world.porcelain)
    if (cmd.startsWith("rev-parse --verify --quiet HEAD")) return ok(`${world.head}\n`)
    if (cmd.startsWith("rev-parse --verify --quiet refs/heads/")) return ok(`${world.branchOid}\n`)
    if (cmd === "symbolic-ref --quiet --short HEAD") return world.onBranch ? ok("lane-a\n") : { code: 1, stdout: "", stderr: "" }
    if (cmd.startsWith("update-ref -d")) return { code: world.updateRefFails ? 1 : 0, stdout: "", stderr: "" }
    if (cmd.startsWith("merge-base --is-ancestor")) {
      // Only the commit the proof was about is an ancestor; a different tip is not.
      const [, , oid, ref] = cmd.split(" ")
      if (ref === MAIN0) return { code: world.inMainAtCreation && oid === TIP ? 0 : 1, stdout: "", stderr: "" }
      const contained = ref === undefined ? undefined : world.contains?.[ref]
      if (contained !== undefined) return { code: oid !== undefined && contained.includes(oid) ? 0 : 1, stdout: "", stderr: "" }
      return { code: world.ancestor === 0 && oid === TIP ? 0 : 1, stdout: "", stderr: "" }
    }
    if (cmd === "rev-parse --absolute-git-dir") return ok("/nonexistent/gitdir\n")
    if (cmd.startsWith("stash list")) return ok(world.stash ?? "")
    return ok()
  }
}

async function start(
  world: Partial<World> = {},
  options: {
    stored?: Lane[]
    options?: Record<string, unknown>
    debounceMs?: number
    /** Share the git common directory and the world with another instance. */
    common?: string
    world?: World
    lock?: Record<string, unknown>
  } = {},
) {
  const state: World = options.world ?? {
    ahead: 2,
    porcelain: "",
    ancestor: 1,
    openBranches: [],
    time: {},
    exists: true,
    now: NOW,
    head: TIP,
    branchOid: TIP,
    onBranch: true,
    updateRefFails: false,
    ...world,
  }
  const fake = createFakeContext({
    directory: REPO,
    options: options.options,
    sessions: [
      { id: PARENT, projectID: "prj", location: { directory: REPO }, time: { busy: 1, idle: 2 } },
      // Archived by default: only a deleted or archived child releases its lane. Tests of a live child override this.
      { id: CHILD, parentID: PARENT, projectID: "prj", location: { directory: WT }, time: { busy: 1, idle: 2, archived: 3 } },
    ],
  })
  for (const stored of options.stored ?? [lane()]) fake.storage.set(laneKey(stored.child), stored)
  for (const [id, time] of Object.entries(state.time)) {
    const session = fake.sessions.get(id)
    if (session) session.time = time
  }
  const worktree: Array<{ method: string; input: Record<string, unknown> }> = []
  Object.assign(fake.context, {
    location: { ...(fake.context.location as object), directory: REPO, project: { id: "prj" } },
    worktree: {
      list: async () => [{ directory: WT }],
      remove: async (input: Record<string, unknown>) => {
        worktree.push({ method: "remove", input })
        state.onRemove?.()
      },
      refresh: async (input: Record<string, unknown>) => void worktree.push({ method: "refresh", input }),
    },
  })
  const common = options.common ?? mkdtempSync(join(tmpdir(), "common-"))
  if (!options.common) COMMONS.push(common)
  // Counts the events the plugin has handled: its loop handles each event synchronously, then asks for the next one.
  const events = { handled: 0 }
  const event = fake.context.event as unknown as { subscribe: (input: unknown) => AsyncIterable<unknown> }
  const subscribe = event.subscribe.bind(event)
  event.subscribe = (input) => {
    const iterable = subscribe(input)
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = iterable[Symbol.asyncIterator]()
        let holding = false
        return {
          next: async () => {
            if (holding) events.handled++
            const result = await iterator.next()
            holding = !result.done
            return result
          },
          return: async () => (await iterator.return?.()) ?? { done: true as const, value: undefined },
        }
      },
    }
  }
  const log: string[][] = []
  let lifecycle: Lifecycle | undefined
  const plugin = createPlugin({
    lifecycle: (created) => {
      lifecycle = created
    },
    commonDir: async () => common,
    run: runner(state, log),
    lookupMs: 20,
    directoryExists: async (path: string) => {
      const code = state.statErrors?.[path]
      if (code !== undefined) throw Object.assign(new Error(`cannot stat ${path}`), { code })
      const exists = state.exists && !(state.missing ?? []).includes(path)
      state.onExists?.(path, exists)
      return exists
    },
    now: () => state.now,
    debounceMs: options.debounceMs ?? 1,
    ...(options.lock === undefined ? {} : { lock: options.lock }),
  })
  const cleanup = (await plugin.setup(fake.context)) as () => Promise<void>
  return {
    fake,
    state,
    worktree,
    log,
    cleanup,
    common,
    events,
    /** Resolves once no pass is scheduled and the lifecycle's serial chain is quiet: every queued recovery has run. */
    quiet: () => lifecycle?.settle() ?? Promise.resolve(),
    lifecycle: (): Lifecycle => {
      if (lifecycle === undefined) throw new Error("the lifecycle was not created")
      return lifecycle
    },
  }
}

const stored = (fake: Fake, child = CHILD) => fake.storage.get(laneKey(child)) as Lane
const synthetic = (fake: Fake) =>
  fake.calls.filter((entry) => entry.method === "session.synthetic").map((entry) => entry.input as { sessionID: string; text: string })
const settle = (ms = 30) => new Promise((done) => setTimeout(done, ms))
/** Wait until `condition` holds (a pass does real file I/O and takes longer under load than a fixed sleep), or `ms` pass. */
const until = async (condition: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!condition() && Date.now() < deadline) await settle(10)
}
const tool = { sessionID: PARENT, agent: "a", messageID: "m", id: "t" }

/**
 * The lane's states in the order the plugin writes them. A removal records `removing` first and then either
 * restores `active` (a refusal) or retires the lane, so the first write after `removing` is the removal's decision.
 */
const laneWrites = (fake: Fake, child = CHILD) => {
  const states: string[] = []
  const storage = fake.context.storage as unknown as { set: (key: string, value: unknown) => Promise<void> }
  const original = storage.set.bind(storage)
  storage.set = (key, value) => {
    if (key === laneKey(child)) states.push((value as Lane).state)
    return original(key, value)
  }
  return states
}
/** Wait for that decision, and return the states from `removing` on. */
const decision = async (states: string[]) => {
  await until(() => states.includes("removing") && states.length > states.indexOf("removing") + 1)
  return states.slice(states.indexOf("removing"), states.indexOf("removing") + 2)
}
/** Emit `event` and wait until the plugin has handled it. */
const deliver = async (fake: Fake, events: { handled: number }, event: unknown) => {
  const before = events.handled
  fake.emit(event)
  await until(() => events.handled > before)
}

describe("lane sync on a landing", () => {
  test("a delivery_cleanup result that removed the worktree retires the lane as landed and refreshes", async () => {
    const { fake, worktree, cleanup } = await start()
    await fake.fire.tool("execute.after", {
      tool: "delivery_cleanup",
      sessionID: PARENT,
      id: "c",
      input: {},
      status: "completed",
      result: { content: "ok", metadata: { ok: true, worktree: WT } },
    } as never)
    expect(stored(fake).state).toBe("landed")
    expect(worktree).toEqual([{ method: "refresh", input: { projectID: "prj" } }])
    await cleanup()
  })

  test("a result for a worktree that is not a lane changes nothing", async () => {
    const { fake, cleanup } = await start()
    await fake.fire.tool("execute.after", {
      tool: "delivery_cleanup",
      sessionID: PARENT,
      id: "c",
      input: {},
      status: "completed",
      result: { content: "ok", metadata: { ok: true, worktree: "/wt/elsewhere" } },
    } as never)
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a landed lane no longer shows in the lane list", async () => {
    const { fake, cleanup } = await start({}, { stored: [lane({ state: "landed" })] })
    const list = fake.tools.get("subagent_worktree_merge")?.execute as (i: unknown, c: unknown) => Promise<{ content: string }>
    const result = await list({ method: "list" }, tool)
    expect(JSON.stringify(result.content)).not.toContain("lane-a")
    await cleanup()
  })
})

describe("execution events", () => {
  test("a failed child with commits sends exactly one notice to its parent, even when the event repeats", async () => {
    const { fake, cleanup } = await start()
    const event = { type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "model gone" } } }
    fake.emit(event)
    fake.emit(event)
    await settle()
    fake.emit(event)
    await settle()
    const sent = synthetic(fake)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.sessionID).toBe(PARENT)
    expect(sent[0]?.text).toBe(
      "<system-reminder>Subagent ses_child (Write hello) failed: model gone. Its lane lane-a at /wt/lane-a has 2 commits ahead, uncommitted changes: no. Resume it with subagent sessionID ses_child, merge it with subagent_worktree_merge, or discard it.</system-reminder>",
    )
    expect(stored(fake).outcome).toMatchObject({ kind: "failed", reason: "model gone" })
    await cleanup()
  })

  test("an empty lane is not removed when its child succeeds", async () => {
    const { fake, worktree, cleanup } = await start({ ahead: 0 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    fake.emit({ type: "session.idle", data: { sessionID: CHILD } })
    await settle()
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("the parent going idle removes a landed, clean lane without force, then deletes the branch", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0 })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree.map((entry) => [entry.method, entry.input.force])).toEqual([
      ["remove", false],
      ["refresh", undefined],
    ])
    expect(stored(fake).state).toBe("landed")
    expect(log).toContainEqual(["git", "-C", REPO, "update-ref", "-d", "refs/heads/lane-a", TIP])
    expect(log.some((argv) => argv.includes("-D"))).toBe(false)
    await cleanup()
  })

  test("a lane resumed a minute before the parent's idle pass, when landed and clean, is removed", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 }, { stored: [lane({ resumedAt: NOW - 60_000 })] })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await until(() => worktree.length > 0)
    expect(worktree.map((entry) => entry.method)).toEqual(["remove", "refresh"])
    expect(stored(fake).state).toBe("landed")
    await cleanup()
  })

  test("the event loop ends on dispose", async () => {
    const { fake, cleanup } = await start()
    await cleanup()
    expect(fake.active()).toBe(0)
    fake.emit({ type: "session.execution.failed", data: { sessionID: CHILD, error: {} } })
    await settle()
    expect(synthetic(fake)).toEqual([])
  })

  test("dispose waits for a follow-up that a running pass queues while dispose waits", async () => {
    let disposing: Promise<void> | undefined
    let followUpDone = false
    let gateGone = false
    const { fake, lifecycle, cleanup } = await start({
      onGit: async () => {
        if (disposing !== undefined) return
        disposing = cleanup()
        // The barrier: dispose unregisters the idle gate as its last step before it waits on the chains, so once the
        // gate is gone it is waiting, and the follow-up is queued behind this pass after that wait began.
        await until(() => !fake.hooks("session").includes("experimental.idle"))
        gateGone = !fake.hooks("session").includes("experimental.idle")
        void lifecycle()
          .sweep("report")
          .then(() => {
            followUpDone = true
          })
      },
    })
    await lifecycle().sweep("report")
    await disposing
    expect({ gateGone, followUpDone }).toEqual({ gateGone: true, followUpDone: true })
  })
})

describe("idle gates", () => {
  const idle = (fake: Fake, sessionID: string, background: unknown[] = []) =>
    fake.fire.session("experimental.idle", { sessionID, background } as never)

  test("a dirty child is nudged once per dirty state", async () => {
    const { fake, state, cleanup } = await start({ porcelain: " M a.txt\n" })
    await idle(fake, CHILD)
    await idle(fake, CHILD)
    expect(synthetic(fake)).toEqual([
      { sessionID: CHILD, text: `<system-reminder>Commit your work in ${WT}, or reply why it stays uncommitted.</system-reminder>` },
    ])
    state.porcelain = " M b.txt\n"
    state.now += 20_000
    await idle(fake, CHILD)
    expect(synthetic(fake)).toHaveLength(2)
    await cleanup()
  })

  test("a lead with its child still listed as running hears nothing", async () => {
    const { fake, cleanup } = await start()
    await idle(fake, PARENT, [
      { kind: "subagent", sessionID: PARENT, childSessionID: CHILD, agent: "general", description: "d" },
    ])
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("the gate removes a landed, clean lane that was resumed a minute earlier", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 }, { stored: [lane({ resumedAt: NOW - 60_000 })] })
    await idle(fake, PARENT)
    expect(worktree.map((entry) => entry.method)).toEqual(["remove", "refresh"])
    expect(stored(fake).state).toBe("landed")
    await cleanup()
  })

  test("a lead with a finished, unresolved lane hears once", async () => {
    const { fake, cleanup } = await start()
    await idle(fake, PARENT)
    expect(synthetic(fake)).toHaveLength(1)
    await idle(fake, PARENT)
    expect(synthetic(fake)).toHaveLength(1)
    await cleanup()
  })

  test("an open PR counts as resolved", async () => {
    const { fake, cleanup } = await start({ openBranches: ["lane-a"] })
    await idle(fake, PARENT)
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a registered keep stops the nudge", async () => {
    const { fake, cleanup } = await start()
    const merge = fake.tools.get("subagent_worktree_merge")?.execute as (i: unknown, c: unknown) => Promise<{ metadata: { ok: boolean } }>
    const result = await merge({ method: "keep", sessionID: CHILD, reason: "later" }, tool)
    expect(result.metadata.ok).toBe(true)
    await idle(fake, PARENT)
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a landed, clean lane is removed at the lead's idle, with no message", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    await idle(fake, PARENT)
    expect(worktree[0]).toEqual({ method: "remove", input: { projectID: "prj", directory: WT, force: false } })
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("with gates off the hook is not registered", async () => {
    const { fake, cleanup } = await start({}, { options: { gates: false } })
    expect(fake.hooks("session")).not.toContain("experimental.idle")
    await cleanup()
  })
})

const landing = (over: Record<string, unknown> = {}) => ({
  receiptId: "r1",
  worktree: WT,
  headRefOid: TIP,
  sessionID: PARENT,
  landedAt: 1,
  ...over,
})
const denied = { denied: { at: 5, sessionID: PARENT } }

describe("the sweep", () => {
  type SweepResult = { content: string; metadata: { plan: Array<{ verdict: string; reason: string; needsPerson?: true }> } }
  const sweep = (fake: Fake, mode: string) => {
    const execute = fake.tools.get("subagent_worktree_sweep")?.execute as
      | ((i: unknown, c: unknown) => Promise<SweepResult>)
      | undefined
    if (!execute) throw new Error("sweep tool not registered")
    return execute({ mode }, tool)
  }
  const removes = (worktree: Array<{ method: string }>) => worktree.filter((entry) => entry.method === "remove").length

  test("report mode names what would be removed and removes nothing", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    const result = await sweep(fake, "report")
    expect(worktree).toEqual([])
    expect(result.content).toContain("subagent_worktree_sweep (report)")
    expect(result.metadata.plan.map((entry) => entry.verdict)).toEqual(["remove"])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("prune removes a landed, clean lane without force, and its branch goes on the landed proof", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0 })
    const result = await sweep(fake, "prune")
    expect(result.metadata.plan.map((entry) => entry.verdict)).toEqual(["remove"])
    expect(worktree).toEqual([
      { method: "remove", input: { projectID: "prj", directory: WT, force: false } },
      { method: "refresh", input: { projectID: "prj" } },
    ])
    expect(log).toContainEqual(["git", "-C", REPO, "update-ref", "-d", "refs/heads/lane-a", TIP])
    expect(log.some((argv) => argv.includes("--force") || argv.includes("-f"))).toBe(false)
    expect(stored(fake).state).toBe("landed")
    await cleanup()
  })

  test("prune removes an empty lane of an archived child", async () => {
    const { fake, worktree, cleanup } = await start({ head: BASE, ahead: 0 })
    await sweep(fake, "prune")
    expect(removes(worktree)).toBe(1)
    expect(stored(fake).state).toBe("removed")
    await cleanup()
  })

  test("prune removes a landed lane that was resumed a minute earlier", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0 })
    writeClaim(common, { directory: WT, branch: "lane-a", sessionID: CHILD, parentID: PARENT, createdAt: NOW - 3 * 24 * 3_600_000, resumedAt: NOW - 60_000 })
    await sweep(fake, "prune")
    expect(removes(worktree)).toBe(1)
    await cleanup()
  })

  test("a child resumed while the sweep previews its lane keeps the lane", async () => {
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 0 })
    const get = fake.context.session.get.bind(fake.context.session)
    let reads = 0
    Object.assign(fake.context.session, {
      get: async (input: { sessionID: string }) => {
        const session = await get(input)
        // The sweep's first look at the child: a resume is stamped after it, and the clock moves on before finalize.
        if (input.sessionID === CHILD && ++reads === 1) {
          writeClaim(common, { directory: WT, branch: "lane-a", sessionID: CHILD, parentID: PARENT, createdAt: NOW - 1000, resumedAt: NOW + 5 })
          state.now = NOW + 10
        }
        return session
      },
    })
    const result = await sweep(fake, "prune")
    expect(result.metadata.plan[0]).toMatchObject({ verdict: "keep" })
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  /** The host cannot resolve a session whose directory is gone: the lookup fails the way the real one does. */
  const lookupFailsWithoutDirectory = (fake: Fake, state: { exists: boolean }) => {
    const get = fake.context.session.get.bind(fake.context.session)
    Object.assign(fake.context.session, {
      get: (input: { sessionID: string }) =>
        input.sessionID === CHILD && !state.exists ? Promise.reject(Object.assign(new Error("Location not found"), { status: 404 })) : get(input),
    })
  }

  test("prune finishes a removing lane whose directory is gone, whatever its child's state", async () => {
    const crashed = lane({ state: "removing", removal: { retireAs: "removed", head: BASE } })
    const { fake, worktree, cleanup } = await start({ exists: false, time: IDLE }, { stored: [crashed] })
    await sweep(fake, "prune")
    expect(stored(fake).state).toBe("removed")
    expect(fake.calls.some((entry) => entry.method === "session.move")).toBe(true)
    expect(removes(worktree)).toBe(0)
    await cleanup()
  })

  test.each(["report", "prune"])("%s keeps an active lane whose directory vanished outside the plugin and flags it for a person", async (mode) => {
    const { fake, state, worktree, cleanup } = await start({ exists: false })
    lookupFailsWithoutDirectory(fake, state)
    const result = await sweep(fake, mode)
    expect(result.metadata.plan[0]).toMatchObject({ verdict: "keep", needsPerson: true })
    expect(result.metadata.plan[0]?.reason).toContain("directory is gone")
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a lane that turns dirty between the preview and finalize is kept and flagged for a person", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    let reads = 0
    state.onGit = (cmd) => {
      // The preview reads a clean tree; every later read (finalize's own checks) sees a change.
      if (cmd === "status --porcelain" && ++reads > 1) state.porcelain = " M late.txt\n"
    }
    const result = await sweep(fake, "prune")
    expect(reads).toBeGreaterThan(1)
    expect(result.metadata.plan[0]).toMatchObject({ verdict: "keep", needsPerson: true })
    expect(worktree).toEqual([])
    await cleanup()
  })

  test.each([
    ["uncommitted changes", { ancestor: 0, porcelain: " M a.txt\n" }],
    ["unmerged commits", { ancestor: 1 }],
  ])("a lane with %s is kept, flagged for a person, and never removed", async (_name, world) => {
    const { fake, worktree, cleanup } = await start(world)
    const result = await sweep(fake, "prune")
    expect(result.metadata.plan[0]).toMatchObject({ verdict: "keep", needsPerson: true })
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a head delivery recorded as landed is removed", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 1 })
    writeLanding(common, landing())
    await sweep(fake, "prune")
    expect(removes(worktree)).toBe(1)
    await cleanup()
  })

  test("a recorded denial keeps the lane and flags it for a person", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0 })
    writeLanding(common, landing(denied))
    const result = await sweep(fake, "prune")
    expect(result.metadata.plan[0]).toMatchObject({ verdict: "keep", needsPerson: true })
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a hold the idle gate set keeps the lane", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    await fake.fire.session("experimental.idle", {
      sessionID: PARENT,
      background: [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 30" }],
    } as never)
    const result = await sweep(fake, "prune")
    expect(result.metadata.plan[0]?.verdict).toBe("keep")
    expect(worktree).toEqual([])
    await cleanup()
  })

  describe("the lane's child session decides", () => {
    const run = async (world: Parameters<typeof start>[0], prepare?: (fake: Fake) => void) => {
      const started = await start(world)
      prepare?.(started.fake)
      const result = await sweep(started.fake, "prune")
      return { ...started, plan: result.metadata.plan }
    }
    const failLookup = (error: unknown) => (fake: Fake) => {
      const get = fake.context.session.get.bind(fake.context.session)
      Object.assign(fake.context.session, {
        get: (input: { sessionID: string }) => (input.sessionID === CHILD ? Promise.reject(error) : get(input)),
      })
    }

    test("a running child keeps its worktree even when the session listing misses it", async () => {
      const { fake, worktree, plan, cleanup } = await run({ ancestor: 0, time: { [CHILD]: { busy: 5, idle: 2 } } }, (fake) => {
        const child = fake.sessions.get(CHILD)
        if (child) child.location = { directory: REPO }
      })
      expect(plan.map((entry) => entry.verdict)).toEqual(["keep"])
      expect(worktree).toEqual([])
      expect(stored(fake).state).toBe("active")
      await cleanup()
    })

    test("an idle child that still exists keeps a clean, empty lane", async () => {
      const { fake, worktree, plan, cleanup } = await run({ ancestor: 0, time: IDLE })
      expect(plan[0]).toMatchObject({ verdict: "keep", reason: "its subagent session is idle" })
      expect(worktree).toEqual([])
      expect(stored(fake).state).toBe("active")
      await cleanup()
    })

    test("a child whose lookup fails keeps its worktree", async () => {
      const { fake, worktree, cleanup } = await run({ ancestor: 0 }, failLookup(new Error("503 unavailable")))
      expect(worktree).toEqual([])
      expect(stored(fake).state).toBe("active")
      await cleanup()
    })

    test.each([
      ["a missing location", Object.assign(new Error("Location not found"), { status: 404 })],
      ["a missing service", Object.assign(new Error("Service not found: SessionService"), { name: "ServiceNotFound" })],
      ["a server error that names the session", Object.assign(new Error(`internal error reading ${CHILD}`), { status: 500 })],
    ])("%s is not a deleted child: the worktree is kept", async (_name, error) => {
      const { fake, worktree, cleanup } = await run({ ancestor: 0 }, failLookup(error))
      expect(worktree).toEqual([])
      expect(stored(fake).state).toBe("active")
      await cleanup()
    })

    test("a deleted child's landed lane is removed", async () => {
      const { fake, worktree, plan, cleanup } = await run({ ancestor: 0 }, (fake) => void fake.sessions.delete(CHILD))
      expect(plan.map((entry) => entry.verdict)).toEqual(["remove"])
      expect(worktree.map((entry) => entry.method)).toEqual(["remove", "refresh"])
      expect(stored(fake).state).toBe("landed")
      await cleanup()
    })
  })
})

describe("the branch is deleted only for the commit the proof covered", () => {
  const idleParent = async (fake: Fake) => {
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
  }
  const refDeletes = (log: string[][]) => log.filter((argv) => argv.includes("update-ref"))

  test("a detached HEAD at the landed commit removes the worktree but keeps the branch", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0, onBranch: false })
    await idleParent(fake)
    expect(worktree[0]?.method).toBe("remove")
    expect(refDeletes(log)).toEqual([])
    await cleanup()
  })

  test("a branch that no longer points at the proven commit is kept: the worktree goes, the ref stays", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0, branchOid: TIP2 })
    await idleParent(fake)
    expect(worktree[0]?.method).toBe("remove")
    expect(refDeletes(log)).toEqual([])
    await cleanup()
  })

  test("a ref that moves between the check and the delete is not force-deleted", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0, updateRefFails: true })
    await idleParent(fake)
    expect(worktree[0]?.method).toBe("remove")
    expect(refDeletes(log)).toEqual([["git", "-C", REPO, "update-ref", "-d", "refs/heads/lane-a", TIP]])
    expect(log.some((argv) => argv.includes("-D") || argv.includes("--force"))).toBe(false)
    await cleanup()
  })
})

describe("every removal is revalidated when it is applied", () => {
  test("a commit that lands after the facts were read blocks the removal", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    state.onGit = (cmd) => {
      if (cmd.startsWith("stash list")) state.head = TIP2
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a tree that became dirty after the facts were read blocks the removal", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    let reads = 0
    state.onGit = (cmd) => {
      if (cmd === "status --porcelain" && ++reads === 2) state.porcelain = " M late.txt\n"
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })
})

describe("the idle gate reads every kind of background job", () => {
  const idle = (fake: Fake, background: unknown[]) => fake.fire.session("experimental.idle", { sessionID: PARENT, background } as never)

  test("a clean landed lane whose child runs a shell is deferred", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    await idle(fake, [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 30" }])
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a shell a descendant of the child runs defers it too", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    fake.sessions.set("ses_grand", { id: "ses_grand", parentID: CHILD, projectID: "prj", location: { directory: WT } })
    await idle(fake, [{ kind: "shell", sessionID: "ses_grand", shellID: "sh", command: "sleep 30" }])
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a shell whose command works in the lane directory defers it", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    await idle(fake, [{ kind: "shell", sessionID: PARENT, shellID: "sh", command: `cd ${WT} && make` }])
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("an unknown child status defers it", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    const session = fake.context.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }
    const original = session.get.bind(session)
    session.get = (input) => (input.sessionID === CHILD ? Promise.reject(new Error("lookup failed")) : original(input))
    await idle(fake, [])
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("with no job and a finished child it is removed", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    fake.sessions.set("ses_unrelated", { id: "ses_unrelated", projectID: "prj", location: { directory: REPO } })
    await idle(fake, [{ kind: "shell", sessionID: "ses_unrelated", shellID: "sh", command: "ls" }])
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("a merge into a local target is a merged proof later", () => {
  const running = { [CHILD]: { busy: 5, idle: 2 } }
  const MAIN = "refs/heads/main"
  type Started = Awaited<ReturnType<typeof start>>
  /**
   * Merge while the child runs (the checkout stays) with `main` containing `atMerge`, run `afterMerge`, then let the
   * child end so the event pass finalizes without a target.
   */
  const mergeThenEnd = async (atMerge: string[], afterMerge: (started: Started) => void = () => {}) => {
    const started = await start({ time: running, contains: { [MAIN]: atMerge } }, { stored: [lane({ target: "main" })] })
    const states = laneWrites(started.fake)
    const kept = await started.lifecycle().removeAfterMerge(stored(started.fake), "main", NOW)
    expect(kept).toMatchObject({ removed: false, kept: "running" })
    afterMerge(started)
    const child = started.fake.sessions.get(CHILD)
    if (child) child.time = { busy: 5, idle: 6, archived: 7 }
    await deliver(started.fake, started.events, { type: "session.execution.succeeded", data: { sessionID: CHILD } })
    return { ...started, states }
  }
  const branchDeleted = (log: string[][]) => log.some((argv) => argv.includes("update-ref"))
  const recorded = { target: "main", head: TIP }

  test.each([
    ["written with the target it must stay in", { retireAs: "merged" as const, head: TIP, within: MAIN }],
    ["written before the target was stored, rebuilt from the merge record", { retireAs: "merged" as const, head: TIP }],
  ])("a removal a crash left half done, %s, is not finished once the target was reset", async (_name, removal) => {
    // The crash came after `removing` was recorded; the target was reset before the next start recovers the lane.
    const { fake, worktree, log, quiet, cleanup } = await start(
      { contains: { [MAIN]: [] } },
      { stored: [lane({ target: "main", mergedInto: recorded, state: "removing", removal })] },
    )
    await quiet()
    const after = stored(fake)
    expect({ removes: worktree.length, branchDeleted: branchDeleted(log), state: after.state, removal: after.removal }).toEqual({
      removes: 0,
      branchDeleted: false,
      state: "active",
      removal: undefined,
    })
    await cleanup()
  })

  describe("a clean, finished lane merged into a local branch is removed by its lead", () => {
    const leadIdle = {
      "the parent's idle pass": (started: Started) => deliver(started.fake, started.events, { type: "session.idle", data: { sessionID: PARENT } }),
      "the lead's idle gate": (started: Started) => started.fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never),
    }

    test.each(Object.keys(leadIdle) as Array<keyof typeof leadIdle>)("when the child's end event was missed, through %s", async (trigger) => {
      const started = await start({ contains: { [MAIN]: [TIP] } }, { stored: [lane({ target: "main", mergedInto: recorded })] })
      await started.quiet()
      await leadIdle[trigger](started)
      await started.quiet()
      expect({ removes: started.worktree.filter((entry) => entry.method === "remove").length, state: stored(started.fake).state }).toEqual({ removes: 1, state: "merged" })
      await started.cleanup()
    })

    test("when its removal was refused for a dirty tree and the tree is clean later, through the lead's idle gate", async () => {
      const started = await mergeThenEnd([TIP], ({ state }) => {
        state.porcelain = " M a.txt\n"
      })
      await started.quiet()
      expect(stored(started.fake).state).toBe("active")
      started.state.porcelain = ""
      await leadIdle["the lead's idle gate"](started)
      await started.quiet()
      expect({ removes: started.worktree.filter((entry) => entry.method === "remove").length, state: stored(started.fake).state }).toEqual({ removes: 1, state: "merged" })
      await started.cleanup()
    })
  })

  test("a lane whose merged head the target still contains is removed as merged", async () => {
    const { fake, worktree, states, cleanup } = await mergeThenEnd([TIP])
    expect(await decision(states)).toEqual(["removing", "merged"])
    expect(worktree.map((entry) => entry.method)).toEqual(["remove", "refresh"])
    expect(stored(fake).state).toBe("merged")
    await cleanup()
  })

  test("a lane whose target was reset so it no longer contains the head is kept", async () => {
    const { fake, worktree, quiet, cleanup } = await mergeThenEnd([TIP], ({ state }) => {
      state.contains = { [MAIN]: [] }
    })
    await quiet()
    expect({ removes: worktree.length, state: stored(fake).state }).toEqual({ removes: 0, state: "active" })
    await cleanup()
  })

  test("a merge whose target did not contain HEAD records no proof, even once the target does", async () => {
    const { fake, worktree, quiet, cleanup } = await mergeThenEnd([], ({ state }) => {
      state.contains = { [MAIN]: [TIP] }
    })
    await quiet()
    expect({ removes: worktree.length, state: stored(fake).state }).toEqual({ removes: 0, state: "active" })
    await cleanup()
  })

  test("a recorded proof for another head than the current HEAD proves nothing, even when the target contains both", async () => {
    const { fake, worktree, quiet, cleanup } = await mergeThenEnd([TIP, TIP2], ({ state }) => {
      state.head = TIP2
      state.branchOid = TIP2
    })
    await quiet()
    expect({ removes: worktree.length, state: stored(fake).state }).toEqual({ removes: 0, state: "active" })
    await cleanup()
  })

  test("a target reset while the other sessions are evicted keeps the worktree and the branch", async () => {
    let reset = false
    const { fake, worktree, log, states, cleanup } = await mergeThenEnd([TIP], ({ fake, state }) => {
      const session = fake.context.session as unknown as { list: (input: { parentID?: string }) => Promise<unknown> }
      const original = session.list.bind(session)
      session.list = async (input) => {
        const answer = await original(input)
        // The eviction's project listing (no parentID): the target moves after the checks proved it.
        if (input?.parentID === undefined && !reset) {
          reset = true
          state.contains = { [MAIN]: [] }
        }
        return answer
      }
    })
    expect(await decision(states)).toEqual(["removing", "active"])
    expect({ reset, removes: worktree.length, branchDeleted: branchDeleted(log), state: stored(fake).state }).toEqual({
      reset: true,
      removes: 0,
      branchDeleted: false,
      state: "active",
    })
    await cleanup()
  })

  test("an event pass that read the lanes before a merge recorded its proof keeps the proof", async () => {
    const { fake, lifecycle, quiet, cleanup } = await start({ time: running, contains: { [MAIN]: [TIP] } }, { stored: [lane({ target: "main" })] })
    await quiet()
    const storage = fake.context.storage as unknown as { scan: (input: unknown) => Promise<unknown> }
    const original = storage.scan.bind(storage)
    let scans = 0
    let merged = false
    storage.scan = async (input) => {
      const page = await original(input)
      // The pass reads the lanes twice: once to finish removals, then for its own lane. The merge lands right after that read.
      if (++scans === 2) {
        await lifecycle().removeAfterMerge(stored(fake), "main", NOW)
        merged = true
      }
      return page
    }
    fake.emit({ type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "model gone" } } })
    await until(() => merged)
    await quiet()
    const after = stored(fake)
    expect({ merged, mergedInto: after.mergedInto, outcome: after.outcome?.kind }).toEqual({
      merged: true,
      mergedInto: { target: "main", head: TIP },
      outcome: "failed",
    })
    await cleanup()
  })
})

describe("a lane handed over while an event pass holds the old writer's copy", () => {
  test("the pass writes nothing onto the record that now names the new writer", async () => {
    const { fake, quiet, cleanup } = await start({ time: { [CHILD]: { busy: 5, idle: 2 } } })
    await quiet()
    const storage = fake.context.storage as unknown as { scan: (input: unknown) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> }
    const original = storage.scan.bind(storage)
    let scans = 0
    let handed = false
    storage.scan = async (input) => {
      const page = await original(input)
      // The pass reads the lanes twice; right after its own-lane read, the record is handed to another writer (same key).
      if (++scans === 2) {
        await storage.set(laneKey(CHILD), { ...stored(fake), child: "ses_next", handedOver: { from: CHILD, at: NOW } })
        handed = true
      }
      return page
    }
    fake.emit({ type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "model gone" } } })
    await until(() => handed)
    await quiet()
    const after = stored(fake)
    expect({ handed, child: after.child, outcome: after.outcome, state: after.state }).toEqual({ handed: true, child: "ses_next", outcome: undefined, state: "active" })
    await cleanup()
  })
})

describe("a resume fences a removal", () => {
  test("without a resume the same pass removes it", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("without the experimental.idle hook", () => {
  const withoutHook = async () => {
    const fake = createFakeContext({
      directory: REPO,
      sessions: [
        { id: PARENT, projectID: "prj", location: { directory: REPO }, time: { busy: 1, idle: 2 } },
        { id: CHILD, parentID: PARENT, projectID: "prj", location: { directory: WT }, time: { busy: 1, idle: 2 } },
      ],
    })
    fake.storage.set(laneKey(CHILD), lane())
    const session = fake.context.session as unknown as { hook: (name: string, callback: unknown) => Promise<unknown> }
    const original = session.hook.bind(session)
    session.hook = (name, callback) => (name === "experimental.idle" ? Promise.reject(new Error("unknown hook")) : original(name, callback))
    const state: World = {
      ahead: 2, porcelain: " M a.txt\n", ancestor: 1, openBranches: [], time: {}, exists: true, now: NOW,
      head: TIP, branchOid: TIP, onBranch: true, updateRefFails: false,
    }
    Object.assign(fake.context, {
      location: { ...(fake.context.location as object), directory: REPO, project: { id: "prj" } },
      worktree: { list: async () => [], remove: async () => {}, refresh: async () => {} },
    })
    const plugin = createPlugin({ commonDir: async () => mkdtempSync(join(tmpdir(), "common-")), run: runner(state, []), lookupMs: 20, directoryExists: async () => true, now: () => state.now, debounceMs: 1 })
    const cleanup = (await plugin.setup(fake.context)) as () => Promise<void>
    return { fake, cleanup }
  }

  test("setup succeeds and the child is still nudged from the succeeded event", async () => {
    const { fake, cleanup } = await withoutHook()
    expect(fake.hooks("session")).not.toContain("experimental.idle")
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    expect(synthetic(fake)).toEqual([
      { sessionID: CHILD, text: `<system-reminder>Commit your work in ${WT}, or reply why it stays uncommitted.</system-reminder>` },
    ])
    await cleanup()
  })

  test("with the hook registered the succeeded event leaves the nudge to the gate", async () => {
    const { fake, cleanup } = await start({ porcelain: " M a.txt\n" })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })
})

describe("a notice follows the event's identity, not its time", () => {
  const failed = (id: string) => ({ id, type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "model gone" } } })

  test("the same failure replayed later sends no second notice", async () => {
    const { fake, state, cleanup } = await start()
    fake.emit(failed("ev1"))
    await settle()
    state.now += 3_600_000
    fake.emit(failed("ev1"))
    await settle()
    expect(synthetic(fake)).toHaveLength(1)
    await cleanup()
  })

  test("a replay without an event id is still the same failure", async () => {
    const { fake, state, cleanup } = await start()
    const bare = { type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "model gone" } } }
    fake.emit(bare)
    await settle()
    state.now += 3_600_000
    fake.emit(bare)
    await settle()
    expect(synthetic(fake)).toHaveLength(1)
    await cleanup()
  })

  test("a new failure has a new identity and is announced", async () => {
    const { fake, state, cleanup } = await start()
    fake.emit(failed("ev1"))
    await settle()
    state.now += 3_600_000
    fake.emit(failed("ev2"))
    await settle()
    expect(synthetic(fake)).toHaveLength(2)
    await cleanup()
  })
})

describe("one remover per worktree: the lane remover reads delivery's records from disk", () => {
  const idleEvent = async (fake: Fake) => {
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
  }

  test("a lane is claimed on disk as soon as the lifecycle sees it, and a lost claim is restored", async () => {
    const { fake, common, cleanup } = await start({ porcelain: " M a.txt\n" })
    await idleEvent(fake)
    expect(readClaim(common, WT)).toMatchObject({ kind: "present", value: { directory: WT, sessionID: CHILD, parentID: PARENT } })
    removeClaim(common, WT)
    await idleEvent(fake)
    expect(readClaim(common, WT).kind).toBe("present")
    await cleanup()
  })

  test("a recorded denial blocks removal through the event pass", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0 })
    writeLanding(common, landing(denied))
    await idleEvent(fake)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a recorded denial blocks removal through the idle gate", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0 })
    writeLanding(common, landing(denied))
    await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("once the denial is cleared on disk the same lane is removed", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0 })
    writeLanding(common, landing(denied))
    await idleEvent(fake)
    expect(worktree).toEqual([])
    writeLanding(common, landing())
    await idleEvent(fake)
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })

  test("a landing record that cannot be read blocks removal: no records is not the same as unreadable ones", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 0 })
    mkdirSync(join(common, "opencode", "landings"), { recursive: true })
    writeFileSync(landingFile(common, "9-bad"), "garbage")
    await idleEvent(fake)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("the head delivery recorded as landed is a landed proof while it is still the tip", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 1 })
    writeLanding(common, landing())
    await idleEvent(fake)
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })

  test("a recorded head that is no longer the tip proves nothing", async () => {
    const { fake, common, worktree, cleanup } = await start({ ancestor: 1 })
    writeLanding(common, landing({ headRefOid: TIP2 }))
    await idleEvent(fake)
    expect(worktree).toEqual([])
    await cleanup()
  })
})

describe("liveness is read when the removal is applied", () => {
  test("a new parent turn that starts before the debounce fires blocks the removal", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 }, { debounceMs: 40 })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle(5)
    const parent = fake.sessions.get(PARENT)
    if (parent) parent.time = { busy: 9, idle: 2 }
    await settle(120)
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a child that starts running while the facts are collected blocks the removal", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0 })
    state.onGit = (cmd) => {
      if (cmd === "status --porcelain") {
        const child = fake.sessions.get(CHILD)
        if (child) child.time = { busy: 9, idle: 2 }
      }
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a denial recorded while the facts are collected blocks the removal", async () => {
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 0 })
    state.onGit = (cmd) => {
      if (cmd.startsWith("stash list")) {
        writeLanding(common, {
          receiptId: "r1",
          worktree: WT,
          headRefOid: TIP,
          sessionID: PARENT,
          landedAt: 1,
          denied: { at: 5, sessionID: PARENT },
        })
      }
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a hold the idle gate set for a running shell is respected by the event pass until the gate sees it clear", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    const gate = (background: unknown[]) => fake.fire.session("experimental.idle", { sessionID: PARENT, background } as never)
    await gate([{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 30" }])
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await gate([])
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })

})

describe("two plugin instances, one repository: coordination lives on disk", () => {
  const resumeCall = {
    tool: "subagent",
    sessionID: PARENT,
    agent: "build",
    messageID: "m",
    id: "call",
    input: { agent: "general", prompt: "one more thing", sessionID: CHILD },
  }

  test("instance B resuming the lane while instance A collects its facts cancels A's removal", async () => {
    const a = await start({ ancestor: 0 })
    const b = await start({}, { common: a.common, world: a.state })
    a.state.onGit = async (cmd) => {
      if (cmd === "status --porcelain" && !a.state.resumedByB) {
        a.state.resumedByB = true
        await b.fake.fire.tool("execute.before", resumeCall as never)
      }
    }
    a.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(a.state.resumedByB).toBe(true)
    expect(a.worktree).toEqual([])
    expect(stored(a.fake).state).toBe("active")
    await a.cleanup()
    await b.cleanup()
  })

  test("a live lock held by another instance keeps the removal from running", async () => {
    const lockOptions = { waitMs: 40, ttlMs: 60_000, alive: () => true, host: "this-host", now: () => NOW }
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 }, { lock: lockOptions })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    mkdirSync(join(common, "opencode", "locks"), { recursive: true })
    writeFileSync(
      lockFile(common, WT),
      JSON.stringify({ pid: process.pid, host: "this-host", owner: "other", token: "theirs", taken: NOW, expires: NOW + 60_000 }),
    )
    state.ancestor = 0 // now landed
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    expect(JSON.parse(readFileSync(lockFile(common, WT), "utf8")).token).toBe("theirs")
    await cleanup()
  })

  test("a stale lock (old, holder dead) is broken and the removal runs", async () => {
    const lockOptions = { waitMs: 5000, ttlMs: 60_000, alive: () => false, host: "this-host", now: () => NOW }
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 }, { lock: lockOptions })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    mkdirSync(join(common, "opencode", "locks"), { recursive: true })
    writeFileSync(
      lockFile(common, WT),
      JSON.stringify({ pid: 999_999, host: "this-host", owner: "dead", token: "old", taken: NOW - 3_600_000, expires: NOW - 3_000_000 }),
    )
    state.ancestor = 0 // now landed
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await until(() => worktree.length > 0)
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("background work is held on disk by every gate", () => {
  const gate = (fake: Fake, sessionID: string, background: unknown[]) =>
    fake.fire.session("experimental.idle", { sessionID, background } as never)

  test("the child's own gate reports a running shell; the parent going idle afterwards does not remove the lane", async () => {
    const { fake, worktree, common, cleanup } = await start({ ancestor: 0 })
    await gate(fake, CHILD, [{ kind: "shell", sessionID: CHILD, shellID: "sh1", command: "sleep 60" }])
    expect(readHolds(common, WT).holds.map((hold) => hold.sessionID)).toEqual([CHILD])
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("once the child's gate sees nothing running, the hold clears and the lane is removed", async () => {
    const { fake, worktree, common, cleanup } = await start({ ancestor: 0 })
    await gate(fake, CHILD, [{ kind: "shell", sessionID: CHILD, shellID: "sh1", command: "sleep 60" }])
    await gate(fake, CHILD, [])
    expect(readHolds(common, WT).holds).toEqual([])
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })

  test("a hold that cannot be read blocks the removal", async () => {
    const { fake, worktree, common, cleanup } = await start({ ancestor: 0 })
    setHold(common, WT, "ses_x", [{ kind: "shell", id: "x" }], NOW)
    const root = join(common, "opencode", "holds")
    writeFileSync(join(root, readdirSync(root)[0] as string, "bad.json"), "garbage")
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a hold older than the expiry (a crashed host) no longer blocks", async () => {
    const { fake, worktree, common, cleanup } = await start({ ancestor: 0 })
    setHold(common, WT, "ses_x", [{ kind: "shell", id: "x" }], NOW - 25 * 3_600_000)
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("coordination errors never escape a hook and never remove", () => {
  const needsPermissions = process.getuid?.() === 0 ? test.skip : test
  const lockStore = (common: string) => chmodSync(join(common, "opencode"), 0o555) // check-test-executables: directory permission, not a script
  const unlockStore = (common: string) => chmodSync(join(common, "opencode"), 0o755) // check-test-executables: directory permission, not a script

  needsPermissions("an unwritable store: the idle hook resolves, nothing is removed", async () => {
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    state.ancestor = 0 // landed now
    lockStore(common)
    try {
      await fake.fire.session("experimental.idle", {
        sessionID: PARENT,
        background: [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 60" }],
      } as never)
      expect(worktree).toEqual([])
    } finally {
      unlockStore(common)
    }
    await cleanup()
  })

    test("delivery holding the shared lock keeps the lane remover out, then it proceeds when released", async () => {
    const lockOptions = { waitMs: 40, ttlMs: 60_000, alive: () => true, host: "this-host", now: () => NOW }
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 }, { lock: lockOptions })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    state.ancestor = 0
    mkdirSync(join(common, "opencode", "locks"), { recursive: true })
    const path = lockFile(common, WT)
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: "this-host", owner: "delivery", token: "delivery", taken: NOW, expires: NOW + 60_000 }))
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    rmSync(path)
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("an unwritable holds store stays unsafe across passes", () => {
  const needsPermissions = process.getuid?.() === 0 ? test.skip : test
  const gate = (fake: Fake, background: unknown[]) =>
    fake.fire.session("experimental.idle", { sessionID: PARENT, background } as never)

  needsPermissions("readable holds directory with only expired records, a failed write, then a later event: no removal", async () => {
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    state.ancestor = 0
    // Only an expired record: the directory exists and reads as empty.
    setHold(common, WT, "ses_old", [{ kind: "shell", id: "old" }], NOW - 25 * 3_600_000)
    const holdsRoot = join(common, "opencode", "holds")
    const holds = join(holdsRoot, readdirSync(holdsRoot)[0] as string)
    chmodSync(holds, 0o555) // check-test-executables: directory permission, not a script
    try {
      // The gate cannot record the child's running shell: that must be remembered ...
      await gate(fake, [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 60" }])
      expect(worktree).toEqual([])
      // ... for the passes that follow, not just this invocation.
      fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
      await settle()
      expect(worktree).toEqual([])
    } finally {
      chmodSync(holds, 0o755) // check-test-executables: directory permission, not a script
    }
    await cleanup()
  })

  needsPermissions("the unsafe state ends with a later hold write that succeeds", async () => {
    const { fake, state, common, worktree, cleanup } = await start({ ancestor: 1 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle()
    state.ancestor = 0
    setHold(common, WT, "ses_old", [{ kind: "shell", id: "old" }], NOW - 25 * 3_600_000)
    const holdsRoot = join(common, "opencode", "holds")
    const holds = join(holdsRoot, readdirSync(holdsRoot)[0] as string)
    chmodSync(holds, 0o555) // check-test-executables: directory permission, not a script
    await gate(fake, [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 60" }])
    chmodSync(holds, 0o755) // check-test-executables: directory permission, not a script
    // Writable again, but the earlier failure is only forgotten by a write that succeeds.
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree).toEqual([])
    await gate(fake, [])
    expect(worktree[0]?.method).toBe("remove")
    await cleanup()
  })
})

describe("each lane notice is sent once, and only for a lane that is still there", () => {
  const DIRTY = " M a.txt\n"
  const idleHook = (fake: Fake, sessionID: string) => fake.fire.session("experimental.idle", { sessionID, background: [] } as never)
  const landedDirty = { ancestor: 0, porcelain: DIRTY }

  test("the same landed-dirty condition through events, the idle hook and a second instance sends one notice", async () => {
    const one = await start(landedDirty)
    const two = await start({}, { world: one.state, common: one.common })
    for (const instance of [one, two]) {
      instance.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
      await settle()
      await idleHook(instance.fake, PARENT)
      one.state.now += 20_000
      await idleHook(instance.fake, PARENT)
      instance.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
      await settle()
    }
    const sent = [...synthetic(one.fake), ...synthetic(two.fake)]
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("has landed, but /wt/lane-a has uncommitted changes")
    expect(sent[0]?.sessionID).toBe(PARENT)
    await one.cleanup()
    await two.cleanup()
  })

  test("a different dirty state is a new notice", async () => {
    const { fake, state, cleanup } = await start(landedDirty)
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    state.porcelain = " M b.txt\n"
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(synthetic(fake)).toHaveLength(2)
    await cleanup()
  })

  test("a worktree removed after the facts were read gets no notice, and its lane is repaired", async () => {
    let reads = 0
    const { fake, state, cleanup } = await start({
      ...landedDirty,
      onGit: (cmd) => {
        if (cmd === "status --porcelain" && ++reads === 2) state.exists = false
      },
    })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(synthetic(fake)).toEqual([])
    expect(stored(fake).state).toBe("removed")
    await cleanup()
  })

  test("a tree that became clean after the facts were read gets no notice", async () => {
    let reads = 0
    const { fake, state, cleanup } = await start({
      ...landedDirty,
      onGit: (cmd) => {
        if (cmd === "status --porcelain" && ++reads === 3) state.porcelain = ""
      },
    })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a lane retired after the facts were read gets no notice", async () => {
    let reads = 0
    const { fake, common, cleanup } = await start({
      ...landedDirty,
      onGit: (cmd) => {
        if (cmd === "status --porcelain" && ++reads === 2) {
          removeClaim(common, WT)
          fake.storage.set(laneKey(CHILD), lane({ state: "landed" }))
        }
      },
    })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a lane whose child is running gets no notice from an event or the idle hook", async () => {
    const { fake, cleanup } = await start({ ...landedDirty, time: { [CHILD]: { busy: 5, idle: 2 } } })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    await idleHook(fake, PARENT)
    await idleHook(fake, CHILD)
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a failed child is still announced while it reads as running", async () => {
    const { fake, cleanup } = await start({ time: { [CHILD]: { busy: 5, idle: 2 } } })
    fake.emit({ type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "model gone" } } })
    await settle()
    expect(synthetic(fake)).toHaveLength(1)
    await cleanup()
  })
})

describe("a lane with no commits of its own is empty, never landed", () => {
  // Its recorded base is old, so it is "27 ahead", but every commit is already in main.
  const noWork = { ahead: 27, ancestor: 0, inMainAtCreation: true }

  test("a dirty one whose child is running gets no notice and is not classified as landed", async () => {
    const { fake, worktree, cleanup } = await start({ ...noWork, porcelain: " M a.txt\n", time: { [CHILD]: { busy: 5, idle: 2 } } })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(synthetic(fake).filter((entry) => entry.text.includes("has landed"))).toEqual([])
    expect(worktree).toEqual([])
    await cleanup()
  })

  test("a dirty one whose child finished gets no landed notice either", async () => {
    const { fake, cleanup } = await start({ ...noWork, porcelain: " M a.txt\n" })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(synthetic(fake).filter((entry) => entry.text.includes("has landed"))).toEqual([])
    await cleanup()
  })

  test("the removal path does not remove it as landed", async () => {
    const { fake, worktree, cleanup } = await start(noWork)
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(worktree.filter((entry) => entry.method === "remove")).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a lane recorded before mainAtCreation existed is not landed by ancestry alone", async () => {
    const { mainAtCreation: _unused, ...old } = lane()
    const { fake, worktree, cleanup } = await start({ ancestor: 0 }, { stored: [old] })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree.filter((entry) => entry.method === "remove")).toEqual([])
    await cleanup()
  })

  test("a lane that really landed is still removed", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree.some((entry) => entry.method === "remove")).toBe(true)
    await cleanup()
  })

  test("an empty, clean lane is still removed after the grace period", async () => {
    const { fake, state, worktree, cleanup } = await start({ ahead: 0, head: BASE, branchOid: BASE }, { stored: [lane({ quietSince: NOW - 3_600_000 * 24 })] })
    state.now = NOW
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle()
    expect(worktree.some((entry) => entry.method === "remove")).toBe(true)
    await cleanup()
  })
})

describe("a notice whose send failed is retried until its reservation is released", () => {
  const DIRTY = " M a.txt\n"
  const landedDirty = { ancestor: 0, porcelain: DIRTY }
  const noticesDir = (common: string) => join(common, "opencode", "lane-notices")
  type Instance = Awaited<ReturnType<typeof start>>
  // An idle hook for a session with no lanes still runs on the lifecycle's one chain: awaiting it waits for a pass in flight.
  const drain = (fake: Fake) => fake.fire.session("experimental.idle", { sessionID: "ses_unrelated", background: [] } as never)

  /** Make the next synthetic message fail, after `during` ran (where a test breaks the rollback). */
  const rejectNextSend = (fake: Fake, during: () => Promise<void> | void = () => {}) => {
    const session = fake.context.session as unknown as { synthetic: (input: unknown) => Promise<unknown> }
    const original = session.synthetic
    let attempts = 0
    session.synthetic = async (input) => {
      if (++attempts > 1) return original(input)
      await during()
      throw new Error("host refused the message")
    }
    return () => attempts
  }

  const paths = {
    event: async ({ fake, state }: Instance) => {
      // The pass's first `rev-list` read means it is running on the chain, whether or not it then sends.
      const running = new Promise<void>((done) => {
        state.onGit = (cmd) => {
          if (!cmd.startsWith("rev-list --count")) return
          state.onGit = undefined
          done()
        }
      })
      fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
      await running
      await drain(fake)
    },
    idle: async ({ fake }: Instance) => {
      await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    },
  }

  /** What breaks the rollback while the send is failing; `restore` undoes it once that pass is over. */
  const breakages: Record<string, (instance: Instance) => { during: () => Promise<void> | void; restore: () => Promise<void> | void }> = {
    "nothing (the send alone fails)": () => ({ during: () => {}, restore: () => {} }),
    "another holder of the lane lock": ({ common }) => {
      let free!: () => void
      let held: Promise<unknown> = Promise.resolve()
      return {
        during: async () => {
          let taken!: () => void
          const acquired = new Promise<void>((done) => (taken = done))
          held = withDiskLock(common, WT, { sessionID: "ses_other", waitMs: 5_000 }, async () => {
            taken()
            await new Promise<void>((done) => (free = done))
          })
          await acquired
        },
        restore: async () => {
          free()
          await held
        },
      }
    },
    "a notice file that cannot be written": ({ common }) => ({
      during: () => chmodSync(noticesDir(common), 0o500), // check-test-executables: directory permission, not a script
      restore: () => chmodSync(noticesDir(common), 0o700), // check-test-executables: directory permission, not a script
    }),
  }

  for (const [path, trigger] of Object.entries(paths)) {
    for (const [breakage, make] of Object.entries(breakages)) {
      test(`${path} path, rollback blocked by ${breakage}: the next pass sends it once`, async () => {
        const instance = await start(landedDirty, { lock: { waitMs: 50 } })
        const broken = make(instance)
        const attempted = rejectNextSend(instance.fake, broken.during)
        await trigger(instance)
        expect(attempted()).toBe(1)
        expect(synthetic(instance.fake)).toEqual([])
        await broken.restore()
        instance.state.now += 20_000
        await trigger(instance)
        const sent = synthetic(instance.fake)
        expect(sent).toHaveLength(1)
        expect(sent[0]?.text).toContain("has landed, but /wt/lane-a has uncommitted changes")
        await trigger(instance)
        expect(attempted()).toBe(2)
        expect(synthetic(instance.fake)).toHaveLength(1)
        await instance.cleanup()
      })
    }
  }

  test("a reservation still held at shutdown is released then, so another instance can send it", async () => {
    const one = await start(landedDirty, { lock: { waitMs: 50 } })
    const attempted = rejectNextSend(one.fake, () => chmodSync(noticesDir(one.common), 0o500)) // check-test-executables: directory permission, not a script
    await paths.idle(one)
    expect(attempted()).toBe(1)
    chmodSync(noticesDir(one.common), 0o700) // check-test-executables: directory permission, not a script
    await one.cleanup()
    const two = await start({}, { world: one.state, common: one.common })
    await paths.idle(two)
    expect(synthetic(two.fake)).toHaveLength(1)
    await two.cleanup()
  })
})

describe("two instances racing for one notice", () => {
  test("overlapping passes deliver it exactly once", async () => {
    // Each instance's second `rev-list` is the fresh read inside its reservation. The first to get there
    // waits until the other has also got there (no lock: both would send) or is waiting on the lane lock.
    let release!: () => void
    const overlapping = new Promise<void>((done) => (release = done))
    const reads = new Map<string[][], number>()
    let inside = 0
    const world: World = {
      ahead: 2, porcelain: " M a.txt\n", ancestor: 0, openBranches: [], time: {}, exists: true, now: NOW,
      head: TIP, branchOid: TIP, onBranch: true, updateRefFails: false,
      onGit: async (cmd, log) => {
        if (!cmd.startsWith("rev-list --count")) return
        const count = (reads.get(log) ?? 0) + 1
        reads.set(log, count)
        if (count !== 2) return
        if (++inside === 2) release()
        await overlapping
      },
    }
    // A wait on a held lock is the other half of the barrier; yield to the event loop rather than sleep.
    const lock = { sleep: () => new Promise<void>((done) => { release(); setImmediate(done) }) }
    const one = await start({}, { world, lock })
    const two = await start({}, { world, common: one.common, lock })
    one.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    two.fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await overlapping
    await until(() => synthetic(one.fake).length + synthetic(two.fake).length > 0)
    await one.cleanup()
    await two.cleanup()
    const sent = [...synthetic(one.fake), ...synthetic(two.fake)]
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("has landed, but /wt/lane-a has uncommitted changes")
  })
})

describe("the idle gate's message carries only the notices this instance reserved", () => {
  const CHILD2 = "ses_child2"
  const WT2 = "/wt/lane-b"

  test("of two landed-dirty lanes, one already announced elsewhere, the message names only the other", async () => {
    const both = [lane(), lane({ child: CHILD2, directory: WT2, branch: "lane-b" })]
    const one = await start({ ancestor: 0, porcelain: " M a.txt\n" }, { stored: both })
    one.fake.sessions.set(CHILD2, { id: CHILD2, parentID: PARENT, projectID: "prj", location: { directory: WT2 }, time: { busy: 1, idle: 2 } })
    // A second instance that only knows lane a announces it first.
    const two = await start({}, { world: one.state, common: one.common })
    await two.fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(synthetic(two.fake).map((entry) => entry.text)).toEqual([
      "<system-reminder>Lane lane-a (subagent ses_child) has landed, but /wt/lane-a has uncommitted changes, so its worktree was kept. Commit, stash or discard them and it can be removed.</system-reminder>",
    ])
    await one.fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(synthetic(one.fake)).toEqual([
      {
        sessionID: PARENT,
        text: "<system-reminder>Lane lane-b (subagent ses_child2) has landed, but /wt/lane-b has uncommitted changes, so its worktree was kept. Commit, stash or discard them and it can be removed.</system-reminder>",
      },
    ])
    await one.cleanup()
    await two.cleanup()
  })
})

describe("within: a path is the root or below it", () => {
  test.each([
    ["/wt/a", "/wt/a", true],
    ["/wt/a/b", "/wt/a", true],
    ["/wt/ab", "/wt/a", false],
    ["/wt", "/wt/a", false],
    ["/wt/a", "/wt/a///", true],
    ["/wt/a/b", "/wt/a/", true],
    ["/x", "/", true],
    ["/", "/", true],
    ["", "", true],
    ["x", "", false],
    ["//wt/a", "//wt", true],
  ] as const)("%p within %p is %p", (path, root, expected) => {
    expect(within(path, root)).toBe(expected)
  })

  test("a root with a long run of slashes before its last character is read in linear time", () => {
    // The unanchored /\/+$/ took about 1 s on 50k slashes and grows with the square: 200k took 30 s, past the test timeout.
    const root = `${"/".repeat(200_000)}x`
    expect(within(`${root}/y`, root)).toBe(true)
    expect(within(root.slice(1), root)).toBe(false)
  })
})

describe("the child session is read last, under the lock, on the event and idle-gate paths too", () => {
  /** The child looks finished at its first read and is running again at every later one. */
  const resumedAfterFirstRead = (fake: Fake) => {
    const get = fake.context.session.get.bind(fake.context.session)
    const reads = { count: 0 }
    Object.assign(fake.context.session, {
      get: async (input: { sessionID: string }) => {
        const session = await get(input)
        if (input.sessionID !== CHILD) return session
        reads.count++
        return reads.count === 1 ? session : { ...session, time: { busy: 9, idle: 2 } }
      },
    })
    return reads
  }

  test("event path: a child running again at removal keeps the worktree and the branch", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0 })
    const reads = resumedAfterFirstRead(fake)
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await settle(150)
    expect(reads.count).toBeGreaterThan(1)
    expect(worktree).toEqual([])
    expect(log.some((argv) => argv.includes("update-ref"))).toBe(false)
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("idle-gate path: a child running again at removal keeps the worktree and the branch", async () => {
    const { fake, worktree, log, cleanup } = await start({ ancestor: 0 })
    const reads = resumedAfterFirstRead(fake)
    await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(reads.count).toBeGreaterThan(1)
    expect(worktree).toEqual([])
    expect(log.some((argv) => argv.includes("update-ref"))).toBe(false)
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a child lookup that fails at removal keeps the worktree on both paths", async () => {
    for (const trigger of ["event", "gate"] as const) {
      const { fake, worktree, cleanup } = await start({ ancestor: 0 })
      const get = fake.context.session.get.bind(fake.context.session)
      let reads = 0
      Object.assign(fake.context.session, {
        get: (input: { sessionID: string }) => (input.sessionID === CHILD && ++reads > 1 ? Promise.reject(new Error("503 unavailable")) : get(input)),
      })
      if (trigger === "event") {
        fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
        await settle(150)
      } else {
        await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
      }
      expect(worktree).toEqual([])
      expect(stored(fake).state).toBe("active")
      await cleanup()
    }
  })
})

describe("finalize: the one removal path", () => {
  const moves = (fake: Fake) =>
    fake.calls.filter((entry) => entry.method === "session.move").map((entry) => entry.input as { sessionID: string; directory: string })
  const removed = (worktree: Array<{ method: string }>) => worktree.some((entry) => entry.method === "remove")
  // HEAD at the lane's base: an empty lane, provable without any landing record.
  const empty = { head: BASE, ahead: 0 }

  test("a succeeded execution removes the worktree without force and moves the child home", async () => {
    const { fake, worktree, cleanup } = await start(empty)
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => removed(worktree))
    expect(worktree[0]).toEqual({ method: "remove", input: { projectID: "prj", directory: WT, force: false } })
    await until(() => stored(fake).state === "removed")
    expect(moves(fake)).toEqual([{ sessionID: CHILD, directory: REPO }])
    await cleanup()
  })

  test.each([
    ["failed", { type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "boom" } } }],
    ["interrupted by the user", { type: "session.execution.interrupted", data: { sessionID: CHILD, reason: "user" } }],
  ])("a %s execution removes an empty lane too", async (_name, event) => {
    const { fake, worktree, cleanup } = await start(empty)
    fake.emit(event)
    await until(() => removed(worktree))
    expect(removed(worktree)).toBe(true)
    await cleanup()
  })

  test.each(["session.archived", "session.deleted"])("a %s child session removes the lane", async (type) => {
    const { fake, worktree, cleanup } = await start(empty)
    fake.emit({ type, data: { sessionID: CHILD } })
    await until(() => removed(worktree))
    await until(() => stored(fake).state === "removed")
    expect(moves(fake)).toEqual([{ sessionID: CHILD, directory: REPO }])
    await cleanup()
  })

  test("a landing retires the lane as landed and moves its sessions home when delivery removed the worktree", async () => {
    const { fake, worktree, cleanup } = await start()
    fake.sessions.set("ses_grand", { id: "ses_grand", parentID: CHILD, projectID: "prj", location: { directory: WT }, time: { busy: 1, idle: 2 } })
    await fake.fire.tool("execute.after", {
      tool: "delivery_cleanup",
      sessionID: PARENT,
      id: "c",
      input: {},
      status: "completed",
      result: { content: "ok", metadata: { ok: true, worktree: WT } },
    } as never)
    expect(stored(fake).state).toBe("landed")
    expect(removed(worktree)).toBe(false)
    expect(moves(fake).map((move) => [move.sessionID, move.directory])).toEqual([
      [CHILD, REPO],
      ["ses_grand", REPO],
    ])
    await cleanup()
  })

  test("the worktree is removed first, then the sessions are moved, and the lane reads removing in between", async () => {
    const { fake, state, worktree, cleanup } = await start(empty)
    let movesAtRemoval = -1
    let stateAtRemoval = ""
    state.onRemove = () => {
      movesAtRemoval = moves(fake).length
      stateAtRemoval = stored(fake).state
    }
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => removed(worktree) && moves(fake).length > 0)
    expect(movesAtRemoval).toBe(0)
    expect(stateAtRemoval).toBe("removing")
    await cleanup()
  })

  test("a shutdown interruption leaves everything: the host resumes the turn", async () => {
    const { fake, worktree, cleanup } = await start(empty)
    fake.emit({ type: "session.execution.interrupted", data: { sessionID: CHILD, reason: "shutdown" } })
    await settle(100)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    expect(moves(fake)).toEqual([])
    expect(synthetic(fake)).toEqual([])
    await cleanup()
  })

  test("a running background job keeps the worktree", async () => {
    const { fake, worktree, cleanup } = await start(empty)
    await fake.fire.session("experimental.idle", {
      sessionID: CHILD,
      background: [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 60" }],
    } as never)
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle(100)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a dirty tree keeps the worktree and tells the parent once", async () => {
    const { fake, worktree, cleanup } = await start({ ...empty, porcelain: " M a.txt\n" })
    const event = { type: "session.execution.failed", data: { sessionID: CHILD, error: { message: "boom" } } }
    fake.emit(event)
    await settle(100)
    fake.emit(event)
    await settle(100)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    expect(synthetic(fake).map((entry) => entry.sessionID)).toEqual([PARENT])
    await cleanup()
  })

  test("unmerged commits keep the worktree and the branch", async () => {
    const { fake, worktree, log, cleanup } = await start({ ahead: 2, head: TIP, ancestor: 1 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle(100)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    expect(log.some((argv) => argv.includes("update-ref"))).toBe(false)
    await cleanup()
  })
})

describe("finalize: stale events, apply-time liveness, pending moves and resumed removals", () => {
  const moves = (fake: Fake) =>
    fake.calls.filter((entry) => entry.method === "session.move").map((entry) => entry.input as { sessionID: string; directory: string })
  const removes = (worktree: Array<{ method: string }>) => worktree.filter((entry) => entry.method === "remove").length
  const empty = { head: BASE, ahead: 0 }
  const grandchild = (fake: Fake) =>
    fake.sessions.set("ses_grand", { id: "ses_grand", parentID: CHILD, projectID: "prj", location: { directory: WT }, time: { busy: 1, idle: 2 } })

  test("an end event that a later execution.started overtook leaves the worktree", async () => {
    const { fake, worktree, cleanup } = await start(empty, { debounceMs: 150 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    fake.emit({ type: "session.execution.started", data: { sessionID: CHILD } })
    await settle(400)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("an end event after the latest start still removes", async () => {
    const { fake, worktree, cleanup } = await start(empty, { debounceMs: 150 })
    fake.emit({ type: "session.execution.started", data: { sessionID: CHILD } })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => removes(worktree) > 0)
    expect(removes(worktree)).toBe(1)
    await cleanup()
  })

  test("work that appears while the checks run aborts before the host removal", async () => {
    let common = ""
    const setup = await start({
      ...empty,
      // The check of the tree is the last read before the removal: a background job lands during it.
      onGit: (cmd) => {
        if (cmd.startsWith("stash list") && common !== "") setHold(common, WT, "other", [{ kind: "shell", id: "sh" }], NOW)
      },
    })
    common = setup.common
    setup.fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle(100)
    expect(setup.worktree).toEqual([])
    expect(stored(setup.fake).state).toBe("active")
    await setup.cleanup()
  })

  test.each([
    ["a failed move", (fake: Fake, _removed: () => boolean) => {
      const session = fake.context.session as unknown as { move: (input: { sessionID: string; directory: string }) => Promise<unknown> }
      const original = session.move.bind(session)
      session.move = (input) => (input.sessionID === "ses_grand" ? Promise.reject(new Error("host refused")) : original(input))
      return () => {
        session.move = original
      }
    }],
    // A listing that fails before the removal keeps the worktree; this one fails only once the worktree is gone.
    ["an incomplete listing after the removal", (fake: Fake, removed: () => boolean) => {
      const session = fake.context.session as unknown as { list: (input: unknown) => Promise<unknown> }
      const original = session.list.bind(session)
      session.list = (input) => (removed() ? Promise.reject(new Error("listing down")) : original(input))
      return () => {
        session.list = original
      }
    }],
  ])("%s keeps the lane in removing, and a later trigger finishes only the moves", async (_name, breakIt) => {
    const { fake, worktree, cleanup } = await start(empty)
    grandchild(fake)
    const repair = breakIt(fake, () => removes(worktree) > 0)
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => stored(fake).state === "removing")
    await settle(50)
    expect(stored(fake).state).toBe("removing")
    expect(removes(worktree)).toBe(1)
    repair()
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await until(() => stored(fake).state === "removed")
    expect(stored(fake).state).toBe("removed")
    expect(removes(worktree)).toBe(1)
    expect(moves(fake).filter((move) => move.sessionID === "ses_grand").at(-1)).toEqual({ sessionID: "ses_grand", directory: REPO })
    await cleanup()
  })

  describe("a lane left in removing while the plugin runs is finished by every entry point", () => {
    const crashed = (over: Partial<Lane> = {}) => lane({ state: "removing", removal: { retireAs: "removed", head: BASE }, ...over })
    /** Startup finishes a lane that is in `removing` when the plugin loads, so the lane gets there after the start. */
    const startThenCrash = async (world: Partial<World>) => {
      const started = await start(world, { stored: [] })
      await started.quiet()
      started.fake.storage.set(laneKey(CHILD), crashed())
      return started
    }
    const entries: Array<[string, Lane["state"], (fake: Fake) => unknown]> = [
      ["an event", "removed", (fake) => fake.emit({ type: "session.idle", data: { sessionID: PARENT } })],
      ["the idle gate", "removed", (fake) => fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)],
      [
        "a landing",
        "landed",
        (fake) =>
          fake.fire.tool("execute.after", {
            tool: "delivery_cleanup",
            sessionID: PARENT,
            id: "c",
            input: {},
            status: "completed",
            result: { content: "ok", metadata: { ok: true, worktree: WT } },
          } as never),
      ],
      [
        "the sweep",
        "removed",
        async (fake) => {
          const execute = fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<unknown>
          await execute({ mode: "prune" }, tool)
        },
      ],
      [
        "the lane listing",
        "removed",
        async (fake) => {
          const execute = fake.tools.get("subagent_worktree_merge")?.execute as (i: unknown, c: unknown) => Promise<unknown>
          await execute({ method: "list" }, tool)
        },
      ],
    ]

    test.each(entries)("%s moves the sessions of a lane whose worktree is gone, then retires it", async (_name, final, trigger) => {
      const { fake, worktree, cleanup } = await startThenCrash({ exists: false })
      grandchild(fake)
      await trigger(fake)
      await until(() => stored(fake).state !== "removing")
      expect(stored(fake).state).toBe(final as Lane["state"])
      expect(removes(worktree)).toBe(0)
      expect(moves(fake).map((move) => [move.sessionID, move.directory])).toEqual([
        [CHILD, REPO],
        ["ses_grand", REPO],
      ])
      await cleanup()
    })

    test("a worktree that is still there is removed, then the lane retires", async () => {
      const { fake, worktree, cleanup } = await startThenCrash(empty)
      fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
      await until(() => stored(fake).state === "removed")
      expect(stored(fake).state).toBe("removed")
      expect(removes(worktree)).toBe(1)
      await cleanup()
    })
  })

  test("a resumable child that is idle, with commits that really merged, is removed", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0, head: TIP, time: IDLE })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => removes(worktree) > 0)
    expect(removes(worktree)).toBe(1)
    await until(() => stored(fake).state === "landed")
    expect(stored(fake).state).toBe("landed")
    await cleanup()
  })

  test.each([
    ["dirty", { head: BASE, ahead: 0, porcelain: " M a.txt\n" }],
    ["unmerged", { head: TIP, ahead: 2, ancestor: 1 }],
  ])("an archived child with %s work keeps the worktree and tells the parent once", async (_name, world) => {
    const { fake, worktree, cleanup } = await start(world)
    fake.emit({ type: "session.archived", data: { sessionID: CHILD } })
    await settle(100)
    fake.emit({ type: "session.deleted", data: { sessionID: CHILD } })
    await settle(100)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    expect(synthetic(fake).map((entry) => entry.sessionID)).toEqual([PARENT])
    await cleanup()
  })
})

describe("finalize: round two", () => {
  const removes = (worktree: Array<{ method: string }>) => worktree.filter((entry) => entry.method === "remove").length
  const empty = { head: BASE, ahead: 0 }

  test("a start that arrives after the end was accepted but before the lock keeps the worktree", async () => {
    // The plugin's lock waits through this sleep, so its first call is the barrier: the accepted end is waiting for the lane lock.
    let waiting!: () => void
    const blocked = new Promise<void>((done) => (waiting = done))
    const sleep = (ms: number) => {
      waiting()
      return new Promise<void>((done) => setTimeout(done, ms))
    }
    const { fake, worktree, common, cleanup } = await start(empty, { debounceMs: 20, lock: { sleep } })
    // The lane's claim is already on disk, so the pass takes the lane lock only to remove.
    writeClaim(common, { directory: WT, branch: "lane-a", sessionID: CHILD, parentID: PARENT, createdAt: NOW })
    // Another holder has the lane lock, so the accepted end waits for it.
    let free!: () => void
    let taken!: () => void
    const acquired = new Promise<void>((done) => (taken = done))
    const held = withDiskLock(common, WT, { sessionID: "ses_other", waitMs: 5_000 }, async () => {
      taken()
      await new Promise<void>((done) => (free = done))
    })
    await acquired
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await blocked
    fake.emit({ type: "session.execution.started", data: { sessionID: CHILD } })
    free()
    await held
    await settle(300)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("the idle hook records a running shell for a lane left in removing, and the worktree stays", async () => {
    const { fake, worktree, cleanup, quiet } = await start(empty, { stored: [] })
    // After the start: startup finishes a lane that is in `removing` when the plugin loads.
    await quiet()
    fake.storage.set(laneKey(CHILD), lane({ state: "removing", removal: { retireAs: "removed", head: BASE } }))
    await fake.fire.session("experimental.idle", {
      sessionID: PARENT,
      background: [{ kind: "shell", sessionID: CHILD, shellID: "sh", command: "sleep 60" }],
    } as never)
    await settle(100)
    expect(removes(worktree)).toBe(0)
    expect(stored(fake).state).toBe("removing")
    await cleanup()
  })

  test("an archived lane that landed but is dirty tells the parent exactly once", async () => {
    const { fake, cleanup } = await start({ ancestor: 0, porcelain: " M a.txt\n" })
    fake.emit({ type: "session.archived", data: { sessionID: CHILD } })
    await settle(150)
    expect(synthetic(fake).filter((entry) => entry.sessionID === PARENT)).toHaveLength(1)
    await cleanup()
  })
})

describe("one notice per lane and reason", () => {
  /** Counts lane scans, the first thing every pass does. */
  const countScans = (fake: Fake) => {
    const storage = fake.context.storage as unknown as { scan: (input: unknown) => Promise<unknown> }
    const original = storage.scan.bind(storage)
    const seen = { count: 0 }
    storage.scan = (input) => {
      seen.count++
      return original(input)
    }
    return seen
  }
  /** Emit `event`, wait for its pass to start, then for the serial chain to drain: an idle hook of a session without lanes queues behind it. */
  const passOf = async (fake: Fake, scans: { count: number }, event: unknown) => {
    const before = scans.count
    fake.emit(event)
    await until(() => scans.count > before)
    await fake.fire.session("experimental.idle", { sessionID: "ses_without_lanes" } as never)
  }

  test("archiving then deleting a landed-dirty lane tells the parent once", async () => {
    const { fake, cleanup } = await start({ ancestor: 0, porcelain: " M a.txt\n" })
    const scans = countScans(fake)
    await passOf(fake, scans, { type: "session.archived", data: { sessionID: CHILD } })
    expect(synthetic(fake).filter((entry) => entry.sessionID === PARENT)).toHaveLength(1)
    await passOf(fake, scans, { type: "session.deleted", data: { sessionID: CHILD } })
    expect(synthetic(fake).filter((entry) => entry.sessionID === PARENT)).toHaveLength(1)
    await cleanup()
  })
})

describe("finalize: a resume and late changes fence the removal", () => {
  const removes = (worktree: Array<{ method: string }>) => worktree.filter((entry) => entry.method === "remove").length
  const empty = { head: BASE, ahead: 0 }
  const resume = (fake: Fake) =>
    fake.fire.tool("execute.before", {
      tool: "subagent",
      sessionID: PARENT,
      agent: "build",
      messageID: "m",
      id: "call-resume",
      input: { agent: "general", prompt: "one more thing", sessionID: CHILD },
    } as never)

  // Blocks the next lane scan, the first thing a pass does, until released: the test then acts between the end event and its pass.
  const holdNextScan = (fake: Fake) => {
    const storage = fake.context.storage as unknown as { scan: (input: unknown) => Promise<unknown> }
    const original = storage.scan.bind(storage)
    let release: () => void = () => {}
    const gate = new Promise<void>((done) => {
      release = done
    })
    let held = false
    storage.scan = async (input) => {
      if (!held) {
        held = true
        await gate
      }
      return original(input)
    }
    return { release: () => release(), isHeld: () => held }
  }
  // Idle hook of a session with no lanes: it runs on the lifecycle's one chain, so awaiting it waits for a pass in flight.
  const drain = (fake: Fake) => fake.fire.session("experimental.idle", { sessionID: "ses_unrelated", background: [] } as never)
  // Calls `child` whenever the child's session is read: once it did, the pass is in flight and `drain` waits for its end.
  const passStarted = (fake: Fake, child: () => void) => {
    const session = fake.context.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }
    const original = session.get.bind(session)
    session.get = (input) => {
      if (input.sessionID === CHILD) child()
      return original(input)
    }
  }

  test("a resume recorded after the end event, before its execution starts, keeps the worktree", async () => {
    const { fake, state, worktree, cleanup } = await start({ ...empty, time: IDLE }, { debounceMs: 20 })
    const hold = holdNextScan(fake)
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => hold.isHeld())
    state.now += 1_000
    await resume(fake)
    hold.release()
    await drain(fake)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a success that waited in the debounce queue while the child was resumed and failed removes nothing", async () => {
    const { fake, worktree, state, cleanup } = await start({ ancestor: 0, time: IDLE }, { debounceMs: 800 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle(200)
    state.now += 1000
    await resume(fake)
    state.now += 1000
    await fake.fire.tool(
      "execute.after",
      {
        tool: "subagent",
        sessionID: PARENT,
        agent: "build",
        messageID: "m",
        id: "call",
        input: { agent: "general", prompt: "again", sessionID: CHILD },
        status: "error",
        error: new ToolError({ message: "service replaced", metadata: { sessionID: CHILD } }),
      } as never,
    )
    await settle(1200)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a resume recorded after the end event keeps a landed lane that the pass would otherwise remove", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0, time: IDLE }, { debounceMs: 20 })
    const hold = holdNextScan(fake)
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => hold.isHeld())
    state.now += 1_000
    await resume(fake)
    hold.release()
    await drain(fake)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a resume that lands while the parent's idle pass collects facts keeps a landed lane", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0, time: IDLE })
    let resumed = false
    state.onGit = async (cmd) => {
      if (cmd === "status --porcelain" && !resumed) {
        resumed = true
        await resume(fake)
      }
    }
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await until(() => resumed)
    await drain(fake)
    expect(resumed).toBe(true)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a resume that lands while the idle gate collects facts keeps a landed lane", async () => {
    const { fake, state, worktree, cleanup } = await start({ ancestor: 0, time: IDLE })
    let resumed = false
    state.onGit = async (cmd) => {
      if (cmd === "status --porcelain" && !resumed) {
        resumed = true
        await resume(fake)
      }
    }
    await fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    expect(resumed).toBe(true)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a resume admitted while the idle gate waits its turn keeps a landed lane, though the clock moved on before the gate ran", async () => {
    const { fake, state, worktree, events, cleanup } = await start({ ancestor: 0 })
    // An unrelated session's pass holds the lifecycle's one chain at its first scan.
    const hold = holdNextScan(fake)
    await deliver(fake, events, { type: "session.execution.succeeded", data: { sessionID: "ses_other" } })
    await until(() => hold.isHeld())
    const gate = fake.fire.session("experimental.idle", { sessionID: PARENT, background: [] } as never)
    await resume(fake)
    // A fence taken only once the gate runs would be later than the resume's stamp.
    state.now += 1_000
    hold.release()
    await gate
    expect(hold.isHeld()).toBe(true)
    expect(worktree).toEqual([])
    expect(fake.calls.filter((entry) => entry.method === "session.move")).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test.each([
    ["running", { [CHILD]: { busy: 9, idle: 2 } }, undefined],
    ["unknown", IDLE, new Error("503 unavailable")],
  ])("an end event keeps the worktree when the child's own status is %s", async (_name, time, failure) => {
    const { fake, worktree, cleanup } = await start({ ...empty, time }, { debounceMs: 20 })
    let reads = 0
    passStarted(fake, () => void reads++)
    if (failure) {
      const session = fake.context.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }
      const counted = session.get
      session.get = (input) => (input.sessionID === CHILD ? (counted(input), Promise.reject(failure)) : counted(input))
    }
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => reads > 0)
    await drain(fake)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a resumed child whose new execution started and then succeeded is removed", async () => {
    const { fake, state, worktree, cleanup } = await start({ ...empty, time: IDLE }, { debounceMs: 20 })
    await resume(fake)
    state.now += 1_000
    fake.emit({ type: "session.execution.started", data: { sessionID: CHILD } })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => removes(worktree) > 0)
    expect(removes(worktree)).toBe(1)
    await cleanup()
  })

  test.each([
    ["a new commit", (world: World) => {
      world.head = TIP2
    }],
    ["an uncommitted change", (world: World) => {
      world.porcelain = " M late.txt\n"
    }],
  ])("%s made after the checks, before the host removal, keeps the worktree", async (_name, change) => {
    const { fake, state, worktree, cleanup } = await start(empty)
    // The branch ref is read after every precondition passed, right before `removing` is recorded.
    state.onGit = (cmd) => {
      if (cmd.startsWith("rev-parse --verify --quiet refs/heads/")) change(state)
    }
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle(150)
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("an execution that starts during the final git probe keeps the lane and its worktree", async () => {
    const { fake, state, worktree, cleanup, events } = await start(empty)
    const states = laneWrites(fake)
    // `stash list` is read once by the checks and once more by the tree proof right before the host removal.
    let stashReads = 0
    state.onGit = async (cmd) => {
      if (!cmd.startsWith("stash list") || ++stashReads !== 2) return
      await deliver(fake, events, { type: "session.execution.started", data: { sessionID: CHILD } })
    }
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    expect(await decision(states)).toEqual(["removing", "active"])
    expect(stashReads).toBeGreaterThanOrEqual(2)
    expect(worktree.filter((entry) => entry.method === "remove")).toEqual([])
    await cleanup()
  })
})

describe("finalize: the lane's descendants in the worktree protect it", () => {
  const removes = (worktree: Array<{ method: string }>) => worktree.filter((entry) => entry.method === "remove").length
  const empty = { head: BASE, ahead: 0 }
  // Gates off: no idle hook records background work, so only the descendants' own status can keep the lane.
  const noGates = { options: { gates: false } }
  const grandchild = (fake: Fake, time: Record<string, number>) =>
    fake.sessions.set("ses_grand", { id: "ses_grand", parentID: CHILD, projectID: "prj", location: { directory: WT }, time })
  type SessionApi = {
    get: (input: { sessionID: string }) => Promise<unknown>
    list: (input: { parentID?: string }) => Promise<unknown>
  }
  const api = (fake: Fake) => fake.context.session as unknown as SessionApi

  test.each([
    ["running", (fake: Fake) => grandchild(fake, { busy: 5, idle: 2 })],
    [
      "unknown",
      (fake: Fake) => {
        grandchild(fake, { busy: 1, idle: 2 })
        const original = api(fake).get.bind(fake.context.session)
        api(fake).get = (input) => (input.sessionID === "ses_grand" ? Promise.reject(new Error("service down")) : original(input))
      },
    ],
  ])("a %s grandchild in the worktree keeps the lane when its root ended", async (_name, arrange) => {
    const { fake, worktree, cleanup } = await start(empty, noGates)
    const states = laneWrites(fake)
    arrange(fake)
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    expect(await decision(states)).toEqual(["removing", "active"])
    expect(removes(worktree)).toBe(0)
    await cleanup()
  })

  test("a lane whose sessions cannot all be listed keeps its worktree", async () => {
    const { fake, worktree, cleanup } = await start(empty, noGates)
    const states = laneWrites(fake)
    api(fake).list = () => Promise.reject(new Error("listing down"))
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    expect(await decision(states)).toEqual(["removing", "active"])
    expect(removes(worktree)).toBe(0)
    await cleanup()
  })

  test("a commit made while the descendants are listed keeps the lane and its worktree", async () => {
    const { fake, state, worktree, cleanup } = await start(empty, noGates)
    const states = laneWrites(fake)
    const original = api(fake).list.bind(fake.context.session)
    let committed = false
    api(fake).list = async (input) => {
      // The pre-removal listing: a clean commit lands in the worktree, so HEAD is no longer the proven (empty) commit.
      if (!committed && input.parentID === CHILD && removes(worktree) === 0) {
        committed = true
        state.head = TIP2
        state.branchOid = TIP2
      }
      return original(input)
    }
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    expect(await decision(states)).toEqual(["removing", "active"])
    expect(committed).toBe(true)
    expect(removes(worktree)).toBe(0)
    await cleanup()
  })

  test("an execution that starts while the descendants are listed keeps the lane", async () => {
    const { fake, worktree, cleanup, events } = await start(empty, noGates)
    const states = laneWrites(fake)
    const original = api(fake).list.bind(fake.context.session)
    let fired = false
    api(fake).list = async (input) => {
      if (!fired && input.parentID === CHILD && removes(worktree) === 0) {
        fired = true
        await deliver(fake, events, { type: "session.execution.started", data: { sessionID: CHILD } })
      }
      return original(input)
    }
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    expect(await decision(states)).toEqual(["removing", "active"])
    expect(fired).toBe(true)
    expect(removes(worktree)).toBe(0)
    await cleanup()
  })
})

describe("sessions of other tools are moved out of a worktree before it is removed", () => {
  const removes = (worktree: Array<{ method: string }>) => worktree.filter((entry) => entry.method === "remove").length
  const empty = { head: BASE, ahead: 0 }
  const moves = (fake: Fake) =>
    fake.calls.filter((entry) => entry.method === "session.move").map((entry) => entry.input as { sessionID: string; directory: string })
  const addSession = (fake: Fake, id: string, directory: string, time: Record<string, number> = { busy: 1, idle: 2 }) =>
    fake.sessions.set(id, { id, projectID: "prj", location: { directory }, time })

  test("an idle session of another tool inside the lane is moved to the checkout first, then the worktree goes", async () => {
    const { fake, state, worktree, cleanup } = await start(empty)
    addSession(fake, "ses_other", WT)
    let movedAtRemoval: string[] = []
    state.onRemove = () => {
      movedAtRemoval = moves(fake).map((move) => move.sessionID)
    }
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => removes(worktree) > 0)
    expect(movedAtRemoval).toContain("ses_other")
    expect(moves(fake).find((move) => move.sessionID === "ses_other")).toEqual({ sessionID: "ses_other", directory: REPO })
    await cleanup()
  })

  test("an archived idle session inside the lane is moved out too", async () => {
    const { fake, worktree, cleanup } = await start(empty)
    addSession(fake, "ses_shelved", WT, { busy: 9, idle: 2, archived: 3 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => removes(worktree) > 0)
    expect(moves(fake).find((move) => move.sessionID === "ses_shelved")).toEqual({ sessionID: "ses_shelved", directory: REPO })
    await cleanup()
  })

  test("a running session inside the worktree keeps it", async () => {
    const { fake, worktree, cleanup } = await start(empty)
    addSession(fake, "ses_busy", `${WT}/pkg`, { busy: 9, idle: 2 })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle(150)
    expect(removes(worktree)).toBe(0)
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })

  test("a failed move keeps the worktree, and the lane's own child stays in it", async () => {
    const { fake, worktree, cleanup } = await start(empty)
    addSession(fake, "ses_other", WT)
    const session = fake.context.session as unknown as { move: (input: { sessionID: string; directory: string }) => Promise<unknown> }
    const original = session.move.bind(session)
    session.move = (input) => (input.sessionID === "ses_other" ? Promise.reject(new Error("host refused")) : original(input))
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await settle(150)
    expect(removes(worktree)).toBe(0)
    expect(fake.sessions.get(CHILD)?.location).toEqual({ directory: WT })
    await cleanup()
  })

  test("a start that arrives while the other sessions are evicted keeps the worktree", async () => {
    const { fake, worktree, cleanup } = await start(empty)
    // The barrier: the eviction's project listing (no parentID) delivers the start, then yields one timer
    // turn so the event loop's microtasks (the event iterator, handleEvent) have run before it answers.
    const session = fake.context.session as unknown as { list: (input: { parentID?: string }) => Promise<unknown> }
    const original = session.list.bind(session)
    let started = false
    session.list = async (input) => {
      if (input?.parentID === undefined && !started) {
        started = true
        fake.emit({ type: "session.execution.started", data: { sessionID: CHILD } })
        await new Promise((done) => setTimeout(done, 0))
      }
      return original(input)
    }
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => started)
    await settle(150)
    expect({ started, removes: removes(worktree), state: stored(fake).state }).toEqual({ started: true, removes: 0, state: "active" })
    await cleanup()
  })

  describe("an unrelated session that starts after the eviction listed it is not moved", () => {
    type Listing = { list: (input: { parentID?: string }) => Promise<unknown> }
    // The eviction's project listing answers with the snapshot, then `change` runs: everything after is what the snapshot missed.
    const afterSnapshot = (fake: Fake, change: () => void) => {
      const session = fake.context.session as unknown as Listing
      const original = session.list.bind(session)
      let done = false
      session.list = async (input) => {
        const answer = await original(input)
        if (input?.parentID === undefined && !done) {
          done = true
          change()
        }
        return answer
      }
    }

    test.each([
      ["its status turns busy", (fake: Fake) => () => addSession(fake, "ses_other", WT, { busy: 9, idle: 2 })],
      [
        "an execution.started event arrives for it",
        (fake: Fake) => () => fake.emit({ type: "session.execution.started", data: { sessionID: "ses_other" } }),
      ],
    ])("%s", async (_name, arrange) => {
      const { fake, worktree, cleanup } = await start(empty)
      addSession(fake, "ses_other", WT)
      afterSnapshot(fake, arrange(fake))
      fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
      await settle(250)
      expect({ moved: moves(fake).some((move) => move.sessionID === "ses_other"), removes: removes(worktree), state: stored(fake).state }).toEqual({
        moved: false,
        removes: 0,
        state: "active",
      })
      await cleanup()
    })
  })

  test.each([
    ["a commit", (state: World) => {
      state.head = TIP2
      state.branchOid = TIP2
    }],
    ["an uncommitted change", (state: World) => {
      state.porcelain = " M a.txt\n"
    }],
  ])("%s made while the other sessions are evicted keeps the worktree", async (_name, change) => {
    const { fake, state, worktree, cleanup } = await start(empty)
    const session = fake.context.session as unknown as { list: (input: { parentID?: string }) => Promise<unknown> }
    const original = session.list.bind(session)
    let listed = false
    session.list = async (input) => {
      const answer = await original(input)
      // The eviction's project listing: the tree changes while the eviction runs, after the checks that proved it.
      if (input?.parentID === undefined && !listed) {
        listed = true
        change(state)
      }
      return answer
    }
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => listed)
    await settle(250)
    expect({ removes: removes(worktree), state: stored(fake).state }).toEqual({ removes: 0, state: "active" })
    await cleanup()
  })

  test("a sweep removal (now through finalize) moves such sessions out as well", async () => {
    const { fake, worktree, cleanup } = await start({ ancestor: 0 })
    addSession(fake, "ses_other", WT)
    const execute = fake.tools.get("subagent_worktree_sweep")?.execute as (i: unknown, c: unknown) => Promise<unknown>
    await execute({ mode: "prune" }, tool)
    expect(removes(worktree)).toBe(1)
    expect(moves(fake).some((move) => move.sessionID === "ses_other")).toBe(true)
    await cleanup()
  })
})

describe("a lane's removal leaves a nested lane where it is", () => {
  test("a descendant that works in its own lane's worktree is not moved with its ancestor's lane", async () => {
    const NESTED = "/wt/lane-b"
    const { fake, worktree, cleanup } = await start(
      { head: BASE, ahead: 0 },
      { stored: [lane(), lane({ child: "ses_grand", parent: CHILD, directory: NESTED, branch: "lane-b", parentDir: WT })] },
    )
    fake.sessions.set("ses_grand", { id: "ses_grand", parentID: CHILD, projectID: "prj", location: { directory: NESTED }, time: { busy: 1, idle: 2 } })
    fake.emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } })
    await until(() => stored(fake).state === "removed")
    expect(worktree.filter((entry) => entry.method === "remove").map((entry) => entry.input.directory)).toEqual([WT])
    expect(fake.calls.filter((entry) => entry.method === "session.move").map((entry) => (entry.input as { sessionID: string }).sessionID)).toEqual([CHILD])
    expect(stored(fake, "ses_grand").state).toBe("active")
    await cleanup()
  })
})

describe("a removal's session moves read where each session sits", () => {
  const moved = (fake: Fake) => fake.calls.filter((entry) => entry.method === "session.move").map((entry) => (entry.input as { sessionID: string }).sessionID)
  /** A removal that took the worktree away but still has `pending` moves, seeded after the start (which would finish it). */
  const startPending = async (pending: string[]) => {
    const started = await start({ exists: false }, { stored: [] })
    await started.quiet()
    started.fake.storage.set(laneKey(CHILD), lane({ state: "removing", removal: { retireAs: "removed", head: BASE, pending } }))
    return started
  }

  test("a descendant whose location cannot be read is not moved and stays pending", async () => {
    const { fake, cleanup } = await startPending([])
    fake.sessions.set("ses_grand", { id: "ses_grand", parentID: CHILD, projectID: "prj", location: { directory: WT }, time: { busy: 1, idle: 2 } })
    const session = fake.context.session as unknown as { get: (input: { sessionID: string }) => Promise<unknown> }
    const original = session.get.bind(session)
    session.get = (input) => (input.sessionID === "ses_grand" ? Promise.reject(new Error("service down")) : original(input))
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await until(() => stored(fake).removal?.pending?.includes("ses_grand") === true)
    expect(stored(fake).state).toBe("removing")
    expect(stored(fake).removal?.pending).toEqual(["ses_grand"])
    expect(moved(fake)).toEqual([CHILD])
    await cleanup()
  })

  test("a pending session the host says does not exist no longer holds the lane", async () => {
    const { fake, cleanup } = await startPending(["ses_gone"])
    fake.emit({ type: "session.idle", data: { sessionID: PARENT } })
    await until(() => stored(fake).state !== "removing")
    expect(stored(fake).state).toBe("removed")
    expect(moved(fake)).toEqual([CHILD])
    await cleanup()
  })
})

describe("startup reconciles lanes left in removing", () => {
  const moves = (fake: Fake) =>
    fake.calls.filter((entry) => entry.method === "session.move").map((entry) => [(entry.input as { sessionID: string }).sessionID, (entry.input as { directory: string }).directory])
  const removes = (worktree: Array<{ method: string; input: Record<string, unknown> }>) => worktree.filter((entry) => entry.method === "remove")
  const crashed = lane({ state: "removing", removal: { retireAs: "removed", head: BASE } })

  test.each([
    ["still there is removed without force", true, [{ method: "remove", input: { projectID: "prj", directory: WT, force: false } }]],
    ["already gone is not removed again", false, []],
  ])("with no trigger but the plugin starting, a worktree %s, the child moves home and the lane retires", async (_name, exists, removals) => {
    const { fake, worktree, cleanup } = await start({ head: BASE, ahead: 0, exists }, { stored: [crashed] })
    await until(() => stored(fake).state !== "removing")
    expect(stored(fake).state).toBe("removed")
    expect(removes(worktree)).toEqual(removals)
    expect(moves(fake)).toEqual([[CHILD, REPO]])
    await cleanup()
  })

  test.each([
    ["is still there", true],
    ["is already gone", false],
  ])("an execution of the child that starts after the plugin loaded keeps it home and its worktree, even before the reconcile takes the lock, when the tree %s", async (_name, exists) => {
    const common = mkdtempSync(join(tmpdir(), "common-"))
    COMMONS.push(common)
    // Another holder has the lane lock, so the startup reconcile waits for it while the child starts.
    let free!: () => void
    let taken!: () => void
    const acquired = new Promise<void>((done) => (taken = done))
    const held = withDiskLock(common, WT, { sessionID: "ses_other", waitMs: 5_000 }, async () => {
      taken()
      await new Promise<void>((done) => (free = done))
    })
    await acquired
    const { fake, worktree, events, cleanup, quiet } = await start({ head: BASE, ahead: 0, exists }, { stored: [crashed], common, lock: { waitMs: 5_000 } })
    await deliver(fake, events, { type: "session.execution.started", data: { sessionID: CHILD } })
    free()
    await held
    await quiet()
    expect(removes(worktree)).toEqual([])
    expect(moves(fake)).toEqual([])
    expect(stored(fake).state).toBe("removing")
    await cleanup()
  })
})

describe("an execution that fails because its location is gone", () => {
  const moves = (fake: Fake) =>
    fake.calls.filter((entry) => entry.method === "session.move").map((entry) => [(entry.input as { sessionID: string }).sessionID, (entry.input as { directory: string }).directory])
  const grandchild = (fake: Fake) =>
    fake.sessions.set("ses_grand", { id: "ses_grand", parentID: CHILD, projectID: "prj", location: { directory: WT }, time: { busy: 1, idle: 2 } })
  const locationGone = { type: "session.execution.failed", data: { sessionID: "ses_grand", error: { type: "LocationNotFoundError", message: `Location not found: ${WT}` } } }

  test("a child that starts while the failure waits for the lock stays where it is, though the tree is gone", async () => {
    const common = mkdtempSync(join(tmpdir(), "common-"))
    COMMONS.push(common)
    const { fake, events, cleanup, quiet } = await start({ missing: [WT] }, { common, lock: { waitMs: 5_000 } })
    grandchild(fake)
    let free!: () => void
    let taken!: () => void
    const acquired = new Promise<void>((done) => (taken = done))
    const held = withDiskLock(common, WT, { sessionID: "ses_other", waitMs: 5_000 }, async () => {
      taken()
      await new Promise<void>((done) => (free = done))
    })
    await acquired
    await deliver(fake, events, locationGone)
    await deliver(fake, events, { type: "session.execution.started", data: { sessionID: CHILD } })
    free()
    await held
    await quiet()
    expect(moves(fake)).toEqual([["ses_grand", REPO]])
    expect(stored(fake).state).toBe("removing")
    expect(stored(fake).removal?.pending).toEqual([CHILD])
    await cleanup()
  })

  test.each([
    ["the lane's child", { time: { [CHILD]: { busy: 5, idle: 2 } } }, CHILD],
    ["a sibling in the worktree", {}, "ses_sib"],
  ])("a failure in one descendant while %s runs moves only the failed one; the running one stays pending", async (_name, world, running) => {
    const { fake, events, cleanup, quiet } = await start({ missing: [WT], ...world })
    grandchild(fake)
    if (running === "ses_sib") fake.sessions.set("ses_sib", { id: "ses_sib", parentID: CHILD, projectID: "prj", location: { directory: WT }, time: { busy: 5, idle: 2 } })
    await deliver(fake, events, locationGone)
    await quiet()
    expect(moves(fake).map(([id]) => id)).toContain("ses_grand")
    expect(moves(fake).map(([id]) => id)).not.toContain(running)
    expect(stored(fake).state).toBe("removing")
    expect(stored(fake).removal?.pending).toEqual([running])
    await cleanup()
  })
  test("a descendant of an active lane's child whose worktree is gone moves home with the lane's sessions, and the lane retires", async () => {
    const { fake, worktree, cleanup } = await start({ missing: [WT] })
    grandchild(fake)
    fake.emit(locationGone)
    await until(() => stored(fake).state !== "active")
    expect(stored(fake).state).toBe("removed")
    expect(worktree.filter((entry) => entry.method === "remove")).toEqual([])
    expect(moves(fake)).toEqual([
      [CHILD, REPO],
      ["ses_grand", REPO],
    ])
    await cleanup()
  })

  test("a descendant left in the gone worktree of a retired lane moves home on its own", async () => {
    const { fake, events, cleanup, quiet } = await start({ missing: [WT] }, { stored: [lane({ state: "landed" })] })
    grandchild(fake)
    await deliver(fake, events, locationGone)
    await quiet()
    expect(moves(fake)).toEqual([["ses_grand", REPO]])
    expect(stored(fake).state).toBe("landed")
    await cleanup()
  })

  /** Another holder takes the lane lock; `free` lets the plugin have it. */
  const holdLock = async (common: string) => {
    let free!: () => void
    let taken!: () => void
    const acquired = new Promise<void>((done) => (taken = done))
    const held = withDiskLock(common, WT, { sessionID: "ses_other", waitMs: 5_000 }, async () => {
      taken()
      await new Promise<void>((done) => (free = done))
    })
    await acquired
    return async () => {
      free()
      await held
    }
  }
  const sharedCommon = () => {
    const common = mkdtempSync(join(tmpdir(), "common-"))
    COMMONS.push(common)
    return common
  }

  test.each([
    ["it is running", true, async () => {}],
    ["it starts while the failure waits for the lock", false, (fake: Fake, events: { handled: number }) =>
      deliver(fake, events, { type: "session.execution.started", data: { sessionID: "ses_grand" } })],
    ["the host will resume it after a shutdown", false, (fake: Fake, events: { handled: number }) =>
      deliver(fake, events, { type: "session.execution.interrupted", data: { sessionID: "ses_grand", reason: "shutdown" } })],
  ])("a descendant in the gone worktree of a retired lane stays where it is when %s", async (_name, running, meanwhile) => {
    const common = sharedCommon()
    const { fake, events, cleanup, quiet } = await start({ missing: [WT] }, { stored: [lane({ state: "landed" })], common, lock: { waitMs: 5_000 } })
    grandchild(fake)
    const session = fake.sessions.get("ses_grand")
    if (session && running) session.time = { busy: 5, idle: 2 }
    const release = await holdLock(common)
    await deliver(fake, events, locationGone)
    await meanwhile(fake, events)
    await release()
    await quiet()
    expect(moves(fake)).toEqual([])
    expect(stored(fake).state).toBe("landed")
    await cleanup()
  })

  test.each([
    ["an active lane", "active"],
    ["a retired lane", "landed"],
  ] as const)("running work held on the gone worktree of %s keeps every idle session where it is", async (_name, state) => {
    const { fake, common, events, cleanup, quiet } = await start({ missing: [WT] }, { stored: [lane({ state })] })
    grandchild(fake)
    // A live hold: the idle gate recorded a shell still running for the worktree.
    setHold(common, WT, "ses_x", [{ kind: "shell", id: "sh1" }], NOW)
    await deliver(fake, events, locationGone)
    await quiet()
    expect(moves(fake)).toEqual([])
    await cleanup()
  })

  test("a child whose resume was admitted but has not started yet stays where it is when a descendant fails", async () => {
    const { fake, events, cleanup, quiet } = await start({ missing: [WT] }, { stored: [lane({ resumedAt: NOW })] })
    grandchild(fake)
    await deliver(fake, events, locationGone)
    await quiet()
    expect(moves(fake).map(([id]) => id)).toContain("ses_grand")
    expect(moves(fake).map(([id]) => id)).not.toContain(CHILD)
    expect(stored(fake).state).toBe("removing")
    expect(stored(fake).removal?.pending).toEqual([CHILD])
    await cleanup()
  })

  // The resume is stamped at NOW. Only an archive after it, or an execution that started after it and then went idle, settles it;
  // a time in the stamp's own millisecond cannot be ordered against it.
  test.each([
    ["its last idle is in the stamp's millisecond", { busy: 1, idle: NOW }],
    ["its execution started in the stamp's millisecond", { busy: NOW, idle: NOW + 1 }],
    ["it was archived in the stamp's millisecond", { busy: 1, idle: 2, archived: NOW }],
  ])("an admitted resume of a child that %s is unfinished, so the child stays where it is", async (_name, time) => {
    const { fake, events, cleanup, quiet } = await start({ missing: [WT], time: { [CHILD]: time } }, { stored: [lane({ resumedAt: NOW })] })
    grandchild(fake)
    await deliver(fake, events, locationGone)
    await quiet()
    expect(moves(fake).map(([id]) => id)).toEqual(["ses_grand"])
    expect(stored(fake).removal?.pending).toEqual([CHILD])
    await cleanup()
  })

  test.each([
    ["archived after the resume", { busy: 1, idle: 2, archived: NOW + 1 }],
    ["started after the resume and then went idle", { busy: NOW + 1, idle: NOW + 2 }],
  ])("an admitted resume of a child %s is finished, so the child is moved home", async (_name, time) => {
    const { fake, events, cleanup, quiet } = await start({ missing: [WT], time: { [CHILD]: time } }, { stored: [lane({ resumedAt: NOW })] })
    grandchild(fake)
    await deliver(fake, events, locationGone)
    await quiet()
    expect(moves(fake).map(([id]) => id).sort()).toEqual([CHILD, "ses_grand"].sort())
    expect(stored(fake).state).toBe("removed")
    await cleanup()
  })

  test("the lane's child failing on its own gone location, then starting again, is not moved by the pass that follows", async () => {
    const common = sharedCommon()
    const { fake, events, cleanup, quiet } = await start({ missing: [WT] }, { common, lock: { waitMs: 5_000 } })
    const release = await holdLock(common)
    await deliver(fake, events, { ...locationGone, data: { ...locationGone.data, sessionID: CHILD } })
    await deliver(fake, events, { type: "session.execution.started", data: { sessionID: CHILD } })
    await release()
    // The failure's debounced pass runs after the hook; both had to wait for the lock.
    await quiet()
    expect(moves(fake)).toEqual([])
    expect(stored(fake).state).toBe("removing")
    expect(stored(fake).removal?.pending).toEqual([CHILD])
    await cleanup()
  })

  test.each([
    ["an active lane", lane()],
    ["a lane whose removal still has moves pending", lane({ state: "removing", removal: { retireAs: "removed", head: BASE, pending: [] } })],
  ])("the worktree of %s that is back by the time the lock is taken is neither removed nor emptied", async (_name, seeded) => {
    const common = mkdtempSync(join(tmpdir(), "common-"))
    COMMONS.push(common)
    const { fake, state, worktree, events, cleanup, quiet } = await start({ head: BASE, ahead: 0, missing: [WT] }, { stored: [], common, lock: { waitMs: 5_000 } })
    // Seeded after the start, which finishes a lane in `removing` on its own.
    await quiet()
    fake.storage.set(laneKey(CHILD), seeded)
    grandchild(fake)
    // Another holder has the lane lock while the failure is handled; the worktree comes back meanwhile.
    let free!: () => void
    let taken!: () => void
    const acquired = new Promise<void>((done) => (taken = done))
    const held = withDiskLock(common, WT, { sessionID: "ses_other", waitMs: 5_000 }, async () => {
      taken()
      await new Promise<void>((done) => (free = done))
    })
    await acquired
    // The hook's first look, before it waits for the lock, finds the worktree gone; right after it, the worktree is back.
    let looked = false
    state.onExists = (path, exists) => {
      if (path !== WT || exists) return
      looked = true
      state.missing = []
      state.onExists = undefined
    }
    await deliver(fake, events, locationGone)
    await until(() => looked)
    free()
    await held
    await quiet()
    expect(looked).toBe(true)
    expect(worktree).toEqual([])
    expect(moves(fake)).toEqual([])
    expect(stored(fake).state).toBe(seeded.state)
    await cleanup()
  })

  test("a worktree that comes back right after the plugin's first look under the lock is never removed", async () => {
    const common = mkdtempSync(join(tmpdir(), "common-"))
    COMMONS.push(common)
    const { fake, state, worktree, events, cleanup, quiet } = await start({ head: BASE, ahead: 0, missing: [WT] }, { common, lock: { waitMs: 5_000 } })
    grandchild(fake)
    let free!: () => void
    let taken!: () => void
    const acquired = new Promise<void>((done) => (taken = done))
    const held = withDiskLock(common, WT, { sessionID: "ses_other", waitMs: 5_000 }, async () => {
      taken()
      await new Promise<void>((done) => (free = done))
    })
    await acquired
    // The hook's first look is before the lock and its second is the first under it: that one still finds the worktree
    // gone, and right after it the worktree is back.
    let looks = 0
    state.onExists = (path, exists) => {
      if (path !== WT || exists) return
      looks++
      if (looks < 2) return
      state.missing = []
      state.onExists = undefined
    }
    await deliver(fake, events, locationGone)
    await until(() => looks >= 1)
    free()
    await held
    await quiet()
    expect(looks).toBe(2)
    expect(worktree.filter((entry) => entry.method === "remove")).toEqual([])
    await cleanup()
  })

  test.each([
    ["the worktree still exists", {}, locationGone],
    ["the failure is not about the location", { missing: [WT] }, { ...locationGone, data: { sessionID: "ses_grand", error: { type: "ProviderError", message: "rate limited" } } }],
  ])("nothing moves when %s", async (_name, world, event) => {
    const { fake, worktree, events, cleanup, quiet } = await start(world)
    grandchild(fake)
    await deliver(fake, events, event)
    await quiet()
    expect(moves(fake)).toEqual([])
    expect(worktree).toEqual([])
    expect(stored(fake).state).toBe("active")
    await cleanup()
  })
})
