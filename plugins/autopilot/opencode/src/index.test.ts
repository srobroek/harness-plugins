import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
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
let beads: { list: unknown[]; ready: unknown[]; blocked: unknown[] }

const run: Run = async (_cwd, command, args) => {
  calls.push({ command, args })
  const json = (value: unknown) => ({ ok: true, stdout: JSON.stringify(value), stderr: "" })
  if (command === "git" && args[0] === "rev-parse") return { ok: true, stdout: `${root}\n`, stderr: "" }
  if (command === "git") return { ok: true, stdout: "7\n", stderr: "" }
  if (args[0] === "list") return json(beads.list)
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
  cleanup = await setupAutopilot(fake.context, { run, now: () => NOW, lock })
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
  const ask = (command: string, sessionID = "ses_child") => fake.fire.permission("evaluate", { sessionID, action: "shell", resources: [command], effect: "ask" as string, message: undefined as string | undefined })

  test("allows a feature-branch push", async () => {
    await armed()
    expect((await ask("git push -u origin feat/x")).effect).toBe("allow")
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
    cleanup = await setupAutopilot(fake.context, { run, now: () => NOW, lock, ticks: new Ticks(clock) })
  }

  const prompts = () => fake.calls.filter((call) => call.method === "session.prompt").map((call) => (call.input as { text: string }).text)

  beforeEach(() => {
    timers.length = 0
  })

  test("prompts the lead with the ping while it is idle and stops at the end of the run", async () => {
    await startWithClock()
    await armed()
    await status({ action: "fallback" })
    timers[0]?.callback()
    for (let index = 0; index < 20 && prompts().length < 2; index++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(prompts().at(-1)).toStartWith("Autopilot tick.")
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
  fake.emit({ type: "session.compaction.ended", data: { sessionID: "ses_lead", reason: "auto" } })
  for (let index = 0; index < 20 && !fake.calls.some((call) => call.method === "session.synthetic"); index++) await new Promise((resolve) => setTimeout(resolve, 5))
  const sent = fake.calls.find((call) => call.method === "session.synthetic")?.input as { text: string; delivery: string }
  expect(sent.delivery).toBe("queue")
  expect(sent.text).toContain("still armed after compaction")
})

test("cleanup disposes every registration", async () => {
  await cleanup?.()
  cleanup = undefined
  expect(fake.active()).toBe(0)
  expect(existsSync(root)).toBe(true)
})
