import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext, type FakeContext } from "@srobroek/opencode-lib/testing"
import { DENY_QUESTION, HANDOFF_LABEL, MAX_REPROMPTS, REPROMPT, setupAutopilot, type WriteLock } from "./index.ts"
import type { Run } from "./rundir.ts"
import { type Clock, Ticks } from "./timer.ts"

const NOW = new Date(2026, 10, 20, 14, 0).getTime()

type Call = { command: string; args: string[] }

let root: string
let fake: FakeContext
let cleanup: (() => Promise<void>) | undefined
let calls: Call[]
let locked: string[]
let warnings: string[]
const warn = (message: string) => void warnings.push(message)
let beads: { list: unknown[]; ready: unknown[]; blocked: unknown[] }
/** While set, `bd list` waits for it: a test holds a run's critical section open with it. */
let listGate: Promise<void> | undefined
/** Called on each `git rev-parse`, the last host call `/autopilot` makes before it takes the run lock. */
let onRevParse: (() => void) | undefined

const run: Run = async (_cwd, command, args) => {
  calls.push({ command, args })
  const json = (value: unknown) => ({ ok: true, stdout: JSON.stringify(value), stderr: "" })
  if (command === "git" && args[0] === "rev-parse") {
    onRevParse?.()
    return { ok: true, stdout: `${root}\n`, stderr: "" }
  }
  if (command === "git") return { ok: true, stdout: "7\n", stderr: "" }
  if (args[0] === "list") {
    await listGate
    return json(beads.list)
  }
  if (args[0] === "ready") return json(beads.ready)
  if (args[0] === "blocked") return json(beads.blocked)
  if (args[0] === "create") return json({ id: "t-99" })
  return json({})
}

const lock: WriteLock = async (_cwd, owner, write) => {
  locked.push(owner)
  return { kind: "done", value: await write() }
}

const lead = (time: Record<string, number> = { busy: NOW - 60_000, idle: NOW - 30_000 }) => ({ id: "ses_lead", location: { directory: "/repo" }, time })

async function start(storage?: Record<string, unknown>) {
  fake = createFakeContext({
    directory: "/repo",
    storage,
    sessions: [lead(), { id: "ses_child", parentID: "ses_lead", agent: "coder", time: {} }, { id: "ses_grand", parentID: "ses_child", time: {} }, { id: "ses_other", time: {} }],
  })
  cleanup = await setupAutopilot(fake.context, { run, now: () => NOW, lock, warn })
}

async function command(text: string, sessionID = "ses_lead"): Promise<string> {
  const before = fake.calls.length
  await fake.commands.get("autopilot")?.execute({ sessionID, prompt: { text }, delivery: "queue" } as never)
  const sent = fake.calls.slice(before).find((call) => call.method === "session.prompt")
  return (sent?.input as { text: string } | undefined)?.text ?? ""
}

async function status(input: Record<string, unknown>, sessionID = "ses_lead"): Promise<Record<string, unknown>> {
  const tool = fake.tools.get("autopilot_status") as unknown as { execute: (input: unknown, context: unknown) => Promise<{ output: Record<string, unknown> }> }
  return (await tool.execute(input, { sessionID })).output
}

async function log(input: Record<string, unknown>, sessionID = "ses_lead"): Promise<string> {
  const tool = fake.tools.get("autopilot_log") as unknown as { execute: (input: unknown, context: unknown) => Promise<{ content: string }> }
  return (await tool.execute(input, { sessionID })).content
}

async function denied(tool: string, sessionID: string): Promise<string | undefined> {
  try {
    await fake.fire.tool("execute.before", { tool, sessionID, input: {} })
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

async function armed(setup: Record<string, unknown> = {}) {
  await command("--for 2h")
  return status({ action: "arm", setup: { scope: "p-1", full: false, allow: [], lanes: 3, until: "", ...setup } })
}

/** Resolves with the input of the next `session.<method>` call the plugin makes. */
function whenCalled(method: "prompt" | "synthetic" | "get"): Promise<unknown> {
  const session = fake.context.session as unknown as Record<string, (input: unknown) => Promise<unknown>>
  const original = session[method] as (input: unknown) => Promise<unknown>
  return new Promise((resolve) => {
    session[method] = async (input) => {
      session[method] = original
      const output = await original(input)
      resolve(input)
      return output
    }
  })
}

/** Settles every pending promise step, without waiting on a timer. */
async function settle(steps = 200): Promise<void> {
  for (let step = 0; step < steps; step++) await Promise.resolve()
}

const latestState = () => JSON.parse(readFileSync(join(latest(), "state.json"), "utf8")) as { phase: string; generation?: number }

const latest = () => join(root, "opencode-scratch", "autopilot", "latest")

const journal = () =>
  readFileSync(join(latest(), "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; summary: string })

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "autopilot-test-"))
  calls = []
  locked = []
  warnings = []
  beads = { list: [{ id: "p-1", status: "open" }], ready: [{ id: "p-1" }], blocked: [] }
  await start()
})

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  fake.closeEvents()
  rmSync(root, { recursive: true, force: true })
})

describe("/autopilot", () => {
  test("starts a run in setup and asks for every value the command line left out", async () => {
    const prompt = await command("--for 2h")
    expect(prompt).toContain("Still to ask: scope, full, allow, lanes, until.")
    const state = JSON.parse(readFileSync(join(latest(), "state.json"), "utf8")) as { phase: string; sessionID: string }
    expect(state).toMatchObject({ phase: "setup", sessionID: "ses_lead" })
  })

  test("the setup round may ask; an armed run may not, in the lead or any descendant", async () => {
    await command("")
    expect(await denied("parley_ask", "ses_lead")).toBeUndefined()
    await status({ action: "arm", setup: { scope: "p-1", lanes: 3 } })
    expect(await denied("question", "ses_lead")).toBe(DENY_QUESTION)
    expect(await denied("parley_wait", "ses_grand")).toBe(DENY_QUESTION)
    expect(await denied("question", "ses_other")).toBeUndefined()
    expect(await denied("read", "ses_lead")).toBeUndefined()
  })

  test("arming returns the 4-minute tick automation for this run", async () => {
    const result = await armed()
    expect(result.automation).toMatchObject({ trigger: { type: "every", every: "4 minutes" }, action: { type: "code" }, expires: new Date(NOW + 2 * 3_600_000 + 60_000).toISOString() })
    expect(journal().map((entry) => entry.type)).toEqual(["action"])
  })
})

describe("tick", () => {
  test("skips while the lead session executes", async () => {
    await armed()
    fake.sessions.set("ses_lead", lead({ busy: NOW - 1_000, idle: NOW - 60_000 }))
    expect(await status({ action: "tick" })).toEqual({ skip: "lead session busy" })
  })

  test("sends the ping when the lead is idle, counting the busy writer lane", async () => {
    await armed()
    fake.sessions.set("ses_child", { id: "ses_child", parentID: "ses_lead", agent: "coder", time: { busy: NOW - 1_000 } })
    const result = await status({ action: "tick" })
    expect(result.prompt).toBe("Autopilot tick. Post this ping verbatim, then continue:\n♥ 14:00 · 1/3 lanes · ready 1 · blocked 0 · parked 0 · 2h00m left\nNo actions due; keep working.")
  })

  test("counts a busy writer lane past the first page of children", async () => {
    await armed()
    for (let index = 0; index < 120; index++) fake.sessions.set(`ses_k${index}`, { id: `ses_k${index}`, parentID: "ses_lead", agent: "explore", time: { updated: 1_000 + index } })
    fake.sessions.set("ses_child", { id: "ses_child", parentID: "ses_lead", agent: "coder", time: { busy: NOW - 1_000, updated: 1 } })
    const result = await status({ action: "tick" })
    expect(result.prompt).toContain("· 1/3 lanes ·")
  })

  test("ends the automation with a stop prompt when the scope is finished", async () => {
    await armed()
    beads = { list: [{ id: "p-1", status: "closed" }], ready: [], blocked: [] }
    expect(await status({ action: "tick" })).toMatchObject({ done: true, stop: "scope finished" })
  })
})

describe("permission asks while armed", () => {
  const ask = (command: string, sessionID = "ses_child", action = "shell") =>
    fake.fire.permission("evaluate", { sessionID, action, resources: [command], effect: "ask" as string, message: undefined as string | undefined })

  type Grants = { allow?: ("merge" | "deploy")[]; full?: boolean }
  const none: Grants = {}
  const merge: Grants = { allow: ["merge"] }
  const deploy: Grants = { allow: ["deploy"] }
  const full: Grants = { full: true }
  const all: Grants = { allow: ["merge", "deploy"], full: true }

  // [command, grants, expected effect]
  const table: [string, Grants, "allow" | "deny"][] = [
    // git push: explicit feature branches only
    ["git push -u origin feat/x", none, "allow"],
    ["git push --force-with-lease origin feat/x", none, "allow"],
    ["git -C repo push origin HEAD:feat/x", none, "allow"],
    ["git push origin main-fix", none, "allow"],
    ["git push origin main", all, "deny"],
    ["git push origin HEAD:master", all, "deny"],
    ["git push origin feat/x:refs/heads/master", all, "deny"],
    ["git push origin 'HEAD:main'", all, "deny"],
    ['git push origin "main"', all, "deny"],
    ["git -C repo push origin main", all, "deny"],
    ["git push --force origin feat/x", all, "deny"],
    ["git push -f origin feat/x", all, "deny"],
    ["git -C . push --force origin feat/x", all, "deny"],
    ["git -c core.x=y push -f origin feat/x", all, "deny"],
    ["git push origin +HEAD:feat/x", all, "deny"],
    ["git push origin '+HEAD:feat/x'", all, "deny"],
    ["git push origin +feat/x", all, "deny"],
    ["git push --mirror origin", all, "deny"],
    ["git push --all origin", all, "deny"],
    ["git push origin", all, "deny"],
    ["git push", all, "deny"],
    ["git push --no-verify origin feat/x", all, "deny"],
    ["git push '--force' origin feat/x", all, "deny"],
    ["git --bogus push origin feat/x", all, "deny"],
    ["git push origin --delete feat/old", none, "deny"],
    ["git push origin --delete feat/old", full, "allow"],
    ["git push origin :feat/old", none, "deny"],
    // other git subcommands
    ["git status && git log --oneline -3", none, "allow"],
    ['git commit -m "fix: x"', none, "allow"],
    ["git reset --hard origin/main", none, "deny"],
    ["git reset --hard origin/main", full, "allow"],
    ["git clean -fdx", none, "deny"],
    ["git branch -D feat/old", none, "deny"],
    ["git stash drop", none, "deny"],
    ["git frobnicate", all, "deny"],
    // gh and glab
    ["gh pr create --draft --title t --body b", none, "allow"],
    ["gh --repo owner/repo pr view 3", none, "allow"],
    ["gh pr merge 12 --squash", none, "deny"],
    ["gh pr merge 12 --squash", merge, "allow"],
    ["gh --repo owner/repo pr merge 1", none, "deny"],
    ["gh -R owner/repo pr merge 1", none, "deny"],
    ["gh pr merge 12 --admin", merge, "deny"],
    ["gh api repos/o/r/merges -f base=main", all, "deny"],
    ["gh --hostname x pr view 1", all, "deny"],
    ["glab mr merge 3", none, "deny"],
    ["glab mr merge 3", merge, "allow"],
    // aws
    ["aws s3 ls", none, "allow"],
    ["aws --region us-east-1 cloudformation describe-stacks", none, "allow"],
    ["aws --region us-east-1 cloudformation delete-stack --stack-name x", none, "deny"],
    ["aws --region us-east-1 cloudformation delete-stack --stack-name x", deploy, "allow"],
    ["aws s3 rm s3://bucket/key", all, "deny"],
    ["aws --bogus s3 ls", all, "deny"],
    // deploy tools
    ["npx cdk deploy MyStack", none, "deny"],
    ["npx cdk deploy MyStack", deploy, "allow"],
    ["terraform apply", none, "deny"],
    ["terraform plan", none, "allow"],
    // rm
    ["rm notes.txt", none, "allow"],
    ["rm -rf build", none, "deny"],
    ["rm -rf build", full, "allow"],
    ["rm '-rf' dir", all, "deny"],
    ["rm --no-preserve-root -rf x", all, "deny"],
    ["rm -rf *", all, "deny"],
    // chains need every grant they touch
    ["gh pr merge 12 --squash && rm -rf build", merge, "deny"],
    ["gh pr merge 12 --squash && rm -rf build", { allow: ["merge"], full: true }, "allow"],
    // beads, packages, plain tools
    ["bd close p-1 && bd create task", none, "allow"],
    ["bd delete p-1", none, "deny"],
    ["npm install zod", none, "allow"],
    ["printf '%s\\n' 'git push origin main' > commands.txt", none, "allow"],
    // anything the gate cannot read is denied
    ["echo $(git push -f origin feat/x)", all, "deny"],
    ['git push origin "$BRANCH"', all, "deny"],
    ["sh -c 'git push -f origin feat/x'", all, "deny"],
    ["eval git push -f", all, "deny"],
    ["'git' push origin feat/x", all, "deny"],
    ["echo 'unterminated", all, "deny"],
    ["frobnicate --now", all, "deny"],
  ]

  test.each(table)("%p with %j → %s", async (command, grants, effect) => {
    await armed({ allow: grants.allow ?? [], full: grants.full ?? false })
    expect((await ask(command)).effect).toBe(effect)
  })

  test("denies a merge tool without the grant", async () => {
    await armed()
    expect((await ask("12", "ses_child", "delivery_land")).effect).toBe("deny")
  })

  test("denies a push to the default branch and logs a blocker", async () => {
    await armed()
    expect(await ask("git push origin main")).toMatchObject({ effect: "deny" })
    expect(journal().at(-1)).toMatchObject({ type: "blocker", summary: expect.stringContaining("shell denied") })
  })

  test("leaves sessions outside a run alone", async () => {
    await armed()
    expect((await ask("git push origin main", "ses_other")).effect).toBe("ask")
  })
})

test("the same error signature logged twice parks its bead on the next tick", async () => {
  await armed()
  for (let index = 0; index < 2; index++) expect(await log({ type: "issue", summary: "build fails", bead: "p-1", error: "TS2304 foo" })).toBe("logged issue")
  const result = await status({ action: "tick" })
  expect(result.actions).toContainEqual({ kind: "park", item: "p-1", reason: "same error twice: TS2304 foo" })
})

test("a blocker on a bead flags it human under the store's write lock", async () => {
  await armed()
  expect(await log({ type: "blocker", summary: "needs a key", bead: "p-1", parked: true })).toBe("logged blocker; flagged p-1 human")
  expect(calls.at(-1)).toEqual({ command: "bd", args: ["update", "p-1", "--add-label", "human", "--json"] })
  expect(locked).toHaveLength(1)
})

describe("stop", () => {
  test("writes summary.md, leaves a handoff bead and disarms", async () => {
    await armed()
    await log({ type: "ambiguity", summary: "which region?" })
    beads = { list: [{ id: "p-1", status: "closed" }], ready: [], blocked: [] }
    const result = await status({ action: "stop", reason: "scope finished" })
    expect(result).toMatchObject({ done: true, stopped: "scope finished", handoff: "t-99" })
    const summary = readFileSync(join(latest(), "summary.md"), "utf8")
    expect(summary).toContain("closed beads: 1; open: 0")
    expect(summary).toContain("## Needs input\n\n- which region?")
    expect(calls.find((call) => call.args[0] === "create")?.args).toContain(HANDOFF_LABEL)
    expect(await denied("question", "ses_lead")).toBeUndefined()
    expect([...fake.storage.keys()]).toEqual([])
  })

  test("/autopilot review asks about the stopped run's summary", async () => {
    await armed()
    await status({ action: "stop", reason: "done" })
    const prompt = await command("review", "ses_other")
    expect(prompt).toContain("# Autopilot run")
    expect(prompt).toContain("parley_ask")
  })
})

describe("run state transitions", () => {
  test("a status read leaves a logged stop for the next tick", async () => {
    await armed()
    await log({ type: "stop", summary: "PR open" })
    await status({ action: "status" })
    expect(await status({ action: "tick" })).toMatchObject({ done: true, stop: "logged: PR open" })
  })

  test("a tick racing two stops leaves the run stopped with one handoff bead", async () => {
    await armed()
    await Promise.all([status({ action: "tick" }), status({ action: "stop", reason: "a" }), status({ action: "stop", reason: "b" })])
    const state = JSON.parse(readFileSync(join(latest(), "state.json"), "utf8")) as { phase: string }
    expect(state.phase).toBe("stopped")
    expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(1)
  })

  test("a resume that waits behind a stop does not bring the run back", async () => {
    await armed()
    let release: () => void = () => {}
    listGate = new Promise((resolve) => {
      release = resolve
    })
    const resumeReachedRoot = new Promise<void>((resolve) => {
      onRevParse = resolve
    })
    const stopping = status({ action: "stop", reason: "done" })
    const resuming = command("resume", "ses_other")
    await resumeReachedRoot
    onRevParse = undefined
    // From its rev-parse, resume takes only promise steps to reach the run lock; let them settle.
    for (let step = 0; step < 50; step++) await Promise.resolve()
    release()
    listGate = undefined
    await stopping
    expect(await resuming).toContain("already stopped")
    const state = JSON.parse(readFileSync(join(latest(), "state.json"), "utf8")) as { phase: string }
    expect(state.phase).toBe("stopped")
    expect(await denied("question", "ses_other")).toBeUndefined()
  })
})

test("/autopilot resume moves a run to the new session", async () => {
  await armed()
  const prompt = await command("resume", "ses_other")
  expect(prompt).toContain("resumed in this session")
  expect(prompt).toContain("automation_create")
  expect(await denied("question", "ses_other")).toBe(DENY_QUESTION)
  expect(await denied("question", "ses_lead")).toBeUndefined()
})

describe("fallback tick", () => {
  type Timer = { callback: () => void; cleared: boolean }
  const timers: Timer[] = []
  const clock: Clock = {
    setInterval: (callback) => {
      const timer = { callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearInterval: (timer) => {
      ;(timer as Timer).cleared = true
    },
  }

  async function startWithClock(storage?: Record<string, unknown>) {
    await cleanup?.()
    fake.closeEvents()
    fake = createFakeContext({ directory: "/repo", storage, sessions: [lead()] })
    cleanup = await setupAutopilot(fake.context, { run, now: () => NOW, lock, warn, ticks: new Ticks(clock) })
  }

  const prompts = () => fake.calls.filter((call) => call.method === "session.prompt").map((call) => (call.input as { text: string }).text)

  beforeEach(() => {
    timers.length = 0
  })

  test("sends nothing on a beat while the lead is busy", async () => {
    await startWithClock()
    await armed()
    await status({ action: "fallback" })
    fake.sessions.set("ses_lead", lead({ busy: NOW - 1_000, idle: NOW - 60_000 }))
    const before = prompts().length
    const skipped = whenCalled("get")
    timers[0]?.callback()
    await skipped
    await status({ action: "status" })
    expect(prompts()).toHaveLength(before)
  })

  test("prompts the lead with the ping while it is idle and stops at the end of the run", async () => {
    await startWithClock()
    await armed()
    await status({ action: "fallback" })
    const prompted = whenCalled("prompt")
    timers[0]?.callback()
    expect(((await prompted) as { text: string }).text).toStartWith("Autopilot tick.")
    await status({ action: "stop", reason: "done" })
    expect(timers[0]?.cleared).toBe(true)
  })

  test("starts again after a server restart", async () => {
    await startWithClock()
    await armed()
    await status({ action: "fallback" })
    const storage = Object.fromEntries(fake.storage)
    await startWithClock(storage)
    expect(timers.filter((timer) => !timer.cleared)).toHaveLength(1)
  })
})

test("an armed run survives a server restart", async () => {
  await armed()
  const storage = Object.fromEntries(fake.storage)
  await cleanup?.()
  fake.closeEvents()
  await start(storage)
  expect(await denied("question", "ses_lead")).toBe(DENY_QUESTION)
})

describe("a turn that ends in a question", () => {
  const ask = { type: "assistant", content: [{ type: "text", text: "Done. Should I also update the docs?" }] }
  const syntheticTexts = () => fake.calls.filter((call) => call.method === "session.synthetic").map((call) => (call.input as { text: string }).text)

  test("re-prompts the lead to decide and continue", async () => {
    await armed()
    fake.messages.set("ses_lead", [ask])
    await fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [] })
    expect(syntheticTexts()).toEqual([REPROMPT])
  })

  test(`stops re-prompting after ${MAX_REPROMPTS} turns in a row and logs an issue`, async () => {
    await armed()
    fake.messages.set("ses_lead", [ask])
    for (let index = 0; index <= MAX_REPROMPTS; index++) await fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [] })
    expect(syntheticTexts()).toHaveLength(MAX_REPROMPTS)
    expect(journal().at(-1)?.type).toBe("issue")
  })
})

test("after compaction the lead gets the rules and a fresh status as a queued message", async () => {
  await armed()
  const sentPromise = whenCalled("synthetic")
  fake.emit({ type: "session.compaction.ended", data: { sessionID: "ses_lead", reason: "auto" } })
  const sent = (await sentPromise) as { text: string; delivery: string }
  expect(sent.delivery).toBe("queue")
  expect(sent.text).toContain("still armed after compaction")
})

test("cleanup disposes every registration", async () => {
  await cleanup?.()
  cleanup = undefined
  expect(fake.active()).toBe(0)
  expect(existsSync(root)).toBe(true)
})

describe("two plugin instances on one run", () => {
  test("a stale instance never writes over a run another instance stopped", async () => {
    await armed()
    let releaseB: () => void = () => {}
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let readingB: () => void = () => {}
    const startedB = new Promise<void>((resolve) => {
      readingB = resolve
    })
    const runB: Run = async (cwd, command, args) => {
      if (args[0] === "list") {
        readingB()
        await gateB
      }
      return run(cwd, command, args)
    }
    const fakeB = createFakeContext({ directory: "/repo", storage: Object.fromEntries(fake.storage), sessions: [lead()] })
    const cleanupB = await setupAutopilot(fakeB.context, { run: runB, now: () => NOW, lock, warn })
    const toolB = fakeB.tools.get("autopilot_status") as unknown as { execute: (input: unknown, context: unknown) => Promise<{ output: Record<string, unknown> }> }
    try {
      const tickB = toolB.execute({ action: "tick" }, { sessionID: "ses_lead" })
      await startedB
      const stopping = status({ action: "stop", reason: "done" })
      await settle()
      releaseB()
      await Promise.all([tickB, stopping])
      expect(latestState().phase).toBe("stopped")
      expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(1)
    } finally {
      await cleanupB()
      fakeB.closeEvents()
    }
  })
})

describe("a run file that cannot be read", () => {
  test.each([
    ["is not JSON", "{ not json"],
    ["has the wrong shape", JSON.stringify({ version: 1, runId: "x", phase: "bogus" })],
  ])("state.json that %s is reported and journaled, never read as an empty run", async (_name, text) => {
    await armed()
    writeFileSync(join(latest(), "state.json"), text)
    const result = await status({ action: "tick" })
    expect(result).toMatchObject({ error: expect.stringContaining("state.json") })
    expect(result).not.toHaveProperty("done")
    expect(journal().at(-1)).toMatchObject({ type: "blocker", summary: expect.stringContaining("state.json") })
  })

  test("a corrupt line inside the journal is reported, not skipped", async () => {
    await armed()
    const path = join(latest(), "journal.jsonl")
    writeFileSync(path, `{"broken\n${readFileSync(path, "utf8")}`)
    const result = await status({ action: "tick" })
    expect(result).toMatchObject({ error: expect.stringContaining("journal.jsonl") })
    const last = readFileSync(path, "utf8").trim().split("\n").at(-1) as string
    expect(JSON.parse(last)).toMatchObject({ type: "blocker", summary: expect.stringContaining("journal.jsonl") })
    expect(warnings.at(-1)).toBe("run file error")
  })

  test("an unreadable summary is an error for /autopilot review, not a missing one", async () => {
    await armed()
    await status({ action: "stop", reason: "done" })
    const path = join(latest(), "summary.md")
    chmodSync(path, 0o200)
    try {
      expect(await command("review", "ses_other")).toContain("could not read")
    } finally {
      chmodSync(path, 0o600)
    }
  })
})

test("startup reads every page of armed runs from storage", async () => {
  await armed()
  const storage: Record<string, unknown> = Object.fromEntries(fake.storage)
  for (let index = 0; index < 150; index++) storage[`armed/ses_a${String(index).padStart(3, "0")}`] = { runId: "gone", root }
  await cleanup?.()
  fake.closeEvents()
  fake = createFakeContext({ directory: "/repo", storage, sessions: [lead()] })
  // A host pages its scan at 100 keys whatever the caller asks for.
  const host = fake.context.storage as unknown as { scan: (input: { prefix: string; after?: string; limit?: number }) => Promise<unknown> }
  const scan = host.scan
  host.scan = (input) => scan({ ...input, limit: Math.min(input.limit ?? 100, 100) })
  cleanup = await setupAutopilot(fake.context, { run, now: () => NOW, lock, warn })
  expect(await denied("question", "ses_lead")).toBe(DENY_QUESTION)
})

describe("stop and the journal", () => {
  const handoffText = () => {
    const create = calls.find((call) => call.args[0] === "create")?.args ?? []
    return create[create.indexOf("-d") + 1] ?? ""
  }
  const summaryText = () => readFileSync(join(latest(), "summary.md"), "utf8")

  test("a blocker logged before the stop is in both the summary and the handoff bead", async () => {
    await armed()
    await log({ type: "blocker", summary: "needs a key", parked: true })
    await status({ action: "stop", reason: "done" })
    expect(summaryText()).toContain("needs a key")
    expect(handoffText()).toContain("needs a key")
  })

  test("a blocker logged while the stop runs waits for it and says the summary is closed", async () => {
    await armed()
    let release: () => void = () => {}
    listGate = new Promise((resolve) => {
      release = resolve
    })
    const stopping = status({ action: "stop", reason: "done" })
    await settle()
    const logging = log({ type: "blocker", summary: "late key", parked: true })
    await settle()
    release()
    listGate = undefined
    await stopping
    expect(await logging).toContain("after the run stopped")
    expect(summaryText().includes("late key")).toBe(handoffText().includes("late key"))
  })
})
