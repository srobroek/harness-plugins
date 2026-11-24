import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { SessionHeaderView } from "@srobroek/opencode-lib/pi-session-header"
import type { HostStorage, Json, WriteLock } from "../shared/autopilot.ts"
import { LOG_INPUT_SCHEMA } from "../shared/journal.ts"
import type { LedgerHost } from "../shared/ledger.ts"
import { DENY_QUESTION, REPROMPT } from "../shared/policy.ts"
import type { Run } from "../shared/rundir.ts"
import { type Clock, Ticks } from "../shared/timer.ts"
import { EXPORT_REVIEW_INPUT, MERGE_INPUT, STATUS_INPUT } from "../shared/tools.ts"
import { ASK_FALLBACK, MESSAGE_TYPE, setupAutopilotPi } from "./autopilot.ts"
import { fileStorage } from "./storage.ts"

type Handler = (event: unknown, ctx: unknown) => unknown
type Command = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }

/** A fake `pi` that records handlers, tools, the command and every message the extension sends. */
function fakePi() {
  const handlers = new Map<string, Handler[]>()
  const tools = new Map<string, ToolDefinition>()
  const commands = new Map<string, Command>()
  const userMessages: { text: string; options?: unknown }[] = []
  const messages: { message: { customType: string; content: string; display?: boolean }; options?: { triggerTurn?: boolean; deliverAs?: string } }[] = []
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
      return () => {}
    },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: Command) => commands.set(name, options),
    sendUserMessage: (text: string, options?: unknown) => userMessages.push({ text, ...(options === undefined ? {} : { options }) }),
    sendMessage: (message: (typeof messages)[number]["message"], options?: (typeof messages)[number]["options"]) => messages.push({ message, ...(options === undefined ? {} : { options }) }),
  } as unknown as ExtensionAPI
  /** Run every handler for `name` in order, as pi does; the first block wins. */
  const emit = async (name: string, event: unknown, ctx: unknown): Promise<unknown> => {
    let last: unknown
    for (const handler of handlers.get(name) ?? []) {
      last = (await handler(event, ctx)) ?? last
      if ((last as { block?: boolean } | undefined)?.block === true) return last
    }
    return last
  }
  return { pi, tools, commands, userMessages, messages, emit }
}

type Session = { id: string; file?: string; parentSession?: string; idle?: boolean; branch?: unknown[]; hasUI?: boolean; confirm?: boolean }

const REPO = "/repo"

function ctxFor(session: Session) {
  return {
    cwd: REPO,
    hasUI: session.hasUI ?? false,
    ui: { notify: () => {}, confirm: async () => session.confirm ?? false },
    isIdle: () => session.idle ?? true,
    sessionManager: {
      getSessionId: () => session.id,
      getSessionFile: () => session.file,
      getHeader: () => ({ type: "session", id: session.id, cwd: REPO, timestamp: "", ...(session.parentSession ? { parentSession: session.parentSession } : {}) }),
      getBranch: () => session.branch ?? [],
    },
  }
}

const LEDGER = "/ledgers/session/.beads"
const ledger: LedgerHost = {
  sessionLedger: () => LEDGER,
  isLedger: (path) => path === LEDGER,
  canonical: (path) => path,
  readRoutes: () => ({ kind: "absent" }),
  readRedirect: () => ({ kind: "absent" }),
}
const lock: WriteLock = async (_cwd, _owner, write) => ({ kind: "done", value: await write() })

let gitDir: string
let agentStore: string
let handoffs: unknown[]
let calls: string[][]

const run: Run = async (_cwd, command, args) => {
  calls.push([command, ...args])
  const json = (value: unknown) => ({ ok: true, stdout: JSON.stringify(value), stderr: "" })
  if (command === "git" && args[0] === "rev-parse") return { ok: true, stdout: `${gitDir}\n`, stderr: "" }
  if (command === "git") return { ok: true, stdout: "7\n", stderr: "" }
  if (command === "gh") return { ok: true, stdout: "", stderr: "" }
  if (args[0] === "list" && args.includes("--label")) return json(handoffs)
  if (args[0] === "list")
    return json([
      { id: "p-1", status: "open", issue_type: "epic" },
      { id: "p-1.1", status: "open", parent: "p-1" },
    ])
  if (args[0] === "ready" || args[0] === "blocked" || args[0] === "children") return json([])
  if (args[0] === "create") {
    handoffs.push({ id: "t-99", title: args[1], labels: ["autopilot-handoff"] })
    return json({ id: "t-99" })
  }
  return json({})
}

/** The interval callbacks the fake clock was given, by timer handle. */
let beats: Map<number, () => void>
let timers = 0
const clock: Clock = {
  setInterval: (callback) => {
    beats.set(++timers, callback)
    return timers
  },
  clearInterval: (timer) => void beats.delete(timer as number),
}

const LEAD: Session = { id: "lead", file: "/s/lead.jsonl" }
const CHILD: Session = { id: "child", file: "/s/lead/run/child.jsonl", parentSession: "/s/lead.jsonl" }
const OTHER: Session = { id: "other", file: "/s/other.jsonl" }
const headers: Record<string, SessionHeaderView> = {
  "/s/lead.jsonl": { id: "lead" },
  "/s/lead/run/child.jsonl": { id: "child", parentSession: "/s/lead.jsonl" },
  "/s/other.jsonl": { id: "other" },
}

type Setup = ReturnType<typeof fakePi> & { pilot: ReturnType<typeof setupAutopilotPi>; warnings: string[] }
let started: Setup[]

/** One extension runtime on `session`, started as pi starts it. */
async function start(session: Session = LEAD, storage: HostStorage = fileStorage(agentStore)): Promise<Setup> {
  const fake = fakePi()
  const warnings: string[] = []
  const pilot = setupAutopilotPi(fake.pi, {
    run,
    lock,
    ledger,
    storage,
    readHeader: (file) => headers[file],
    ticks: new Ticks(clock),
    readPauseMs: 0,
    warn: (message) => void warnings.push(message),
  })
  await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctxFor(session))
  const setup = { ...fake, pilot, warnings }
  started.push(setup)
  return setup
}

async function tool(setup: Setup, name: string, params: unknown, session: Session = LEAD) {
  const definition = setup.tools.get(name) as ToolDefinition
  const out = await definition.execute("call-1", params as never, undefined, undefined, ctxFor(session) as never)
  return { text: (out.content[0] as { text: string }).text, details: out.details as Record<string, unknown> }
}

async function command(setup: Setup, args: string, session: Session = LEAD): Promise<string> {
  const before = setup.userMessages.length
  await setup.commands.get("autopilot")?.handler(args, ctxFor(session))
  return setup.userMessages.slice(before).at(-1)?.text ?? ""
}

/** Start a run on the lead and arm it with `setup`. */
async function armed(setup: Setup, answers: Record<string, unknown> = {}) {
  await command(setup, "--for 2h")
  return (await tool(setup, "autopilot_status", { action: "arm", setup: { scope: "p-1", full: false, allow: [], lanes: 3, until: "", ...answers } })).details
}

const askCall = (toolName = "parley_ask") => ({ type: "tool_call", toolCallId: "t-1", toolName, input: {} })

const latest = () => join(gitDir, "opencode-scratch", "autopilot", "latest")
const journal = () =>
  readFileSync(join(latest(), "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { type: string; summary: string; evidence?: string })
const state = () => JSON.parse(readFileSync(join(latest(), "state.json"), "utf8")) as { phase: string; tick: { kind: string; token?: string }; options: { allow: string[] } }

beforeEach(() => {
  gitDir = mkdtempSync(join(tmpdir(), "autopilot-pi-git-"))
  agentStore = mkdtempSync(join(tmpdir(), "autopilot-pi-store-"))
  handoffs = []
  calls = []
  beats = new Map()
  started = []
})

afterEach(async () => {
  for (const setup of started) await setup.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxFor(LEAD))
  rmSync(gitDir, { recursive: true, force: true })
  rmSync(agentStore, { recursive: true, force: true })
})

describe("registration", () => {
  test("the OpenCode tool names and schemas, without autopilot_review, and the /autopilot command", async () => {
    const setup = await start()
    expect([...setup.tools.keys()].sort()).toEqual(["autopilot_export_review", "autopilot_log", "autopilot_merge", "autopilot_status"])
    expect(setup.tools.get("autopilot_status")?.parameters).toBe(STATUS_INPUT)
    expect(setup.tools.get("autopilot_log")?.parameters).toBe(LOG_INPUT_SCHEMA)
    expect(setup.tools.get("autopilot_merge")?.parameters).toBe(MERGE_INPUT)
    expect(setup.tools.get("autopilot_export_review")?.parameters).toBe(EXPORT_REVIEW_INPUT)
    expect(setup.tools.get("autopilot_status")?.description).not.toContain("automation_create")
    expect(setup.commands.has("autopilot")).toBe(true)
  })
})

describe("setup and ticks", () => {
  test("/autopilot sends the setup round as a user message, with pi's way to ask without parley", async () => {
    const setup = await start()
    const prompt = await command(setup, "--for 2h")
    expect(prompt).toContain("is in setup")
    expect(prompt).toContain(ASK_FALLBACK)
    expect(state().phase).toBe("setup")
  })

  test("arming starts the plugin's own 4-minute tick instead of returning an automation", async () => {
    const setup = await start()
    const result = await armed(setup)
    expect(result).toMatchObject({ ok: true, phase: "running", tick: "timer", every: 240_000 })
    expect(result.automation).toBeUndefined()
    expect(state().tick.kind).toBe("fallback")
    expect(beats.size).toBe(1)
  })

  test("a tick prompts the idle lead with the ping and skips while it is busy", async () => {
    const setup = await start()
    await armed(setup)
    const beat = [...beats.values()][0] as () => void
    const before = setup.userMessages.length
    beat()
    await Bun.sleep(50)
    expect(setup.userMessages.slice(before).map((message) => message.text)).toEqual([expect.stringContaining("Autopilot tick. Post this ping verbatim")])

    const busy = { ...LEAD, idle: false }
    await setup.emit("tool_call", { type: "tool_call", toolCallId: "t-2", toolName: "read", input: {} }, ctxFor(busy))
    const during = setup.userMessages.length
    beat()
    await Bun.sleep(50)
    expect(setup.userMessages.length).toBe(during)
  })

  test("a restart re-arms the run from storage and ticks it again in the process that hosts its lead", async () => {
    const first = await start()
    await armed(first)
    await first.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxFor(LEAD))
    expect(beats.size).toBe(0)
    await start(OTHER)
    expect(beats.size).toBe(0)
    await start(LEAD)
    expect(beats.size).toBe(1)
  })

  test("--allow self-review is refused, at the command and at arming: pi has no plugin-run review", async () => {
    const setup = await start()
    expect(await command(setup, "--allow self-review")).toContain("--allow self-review needs autopilot_review")
    expect(existsSync(latest())).toBe(false)
    expect(await armed(setup, { allow: ["merge", "self-review"] })).toEqual({ error: expect.stringContaining("--allow self-review needs autopilot_review") })
    expect(state().phase).toBe("setup")
  })

  test("/autopilot stop asks for the stop without an automation to delete, and the stop writes the debrief", async () => {
    const setup = await start()
    await armed(setup)
    const prompt = await command(setup, "stop")
    expect(prompt).toContain('action "stop"')
    expect(prompt).not.toContain("automation")
    const stopped = (await tool(setup, "autopilot_status", { action: "stop", reason: "test" })).details
    expect(stopped).toMatchObject({ done: true, handoff: "t-99", next: "Print the summary and end." })
    expect(existsSync(join(latest(), "summary.md"))).toBe(true)
    expect(await fileStorage(agentStore).get("armed/lead")).toBeUndefined()
    expect(beats.size).toBe(0)
  })
})

describe("the ask gate", () => {
  test("asks pass before a run is armed and in setup; once armed the lead and its child are blocked, an unrelated session is not", async () => {
    const setup = await start()
    expect(await setup.emit("tool_call", askCall(), ctxFor(LEAD))).toBeUndefined()
    await command(setup, "--for 2h")
    expect(await setup.emit("tool_call", askCall(), ctxFor(LEAD))).toBeUndefined()
    await tool(setup, "autopilot_status", { action: "arm", setup: { scope: "p-1", lanes: 3 } })
    expect(await setup.emit("tool_call", askCall(), ctxFor(LEAD))).toEqual({ block: true, reason: DENY_QUESTION })
    expect(await setup.emit("tool_call", askCall("question"), ctxFor(CHILD))).toEqual({ block: true, reason: DENY_QUESTION })
    expect(await setup.emit("tool_call", askCall(), ctxFor(OTHER))).toBeUndefined()
    expect(await setup.emit("tool_call", { ...askCall(), toolName: "bash" }, ctxFor(LEAD))).toBeUndefined()
  })

  test("a child in another pi process finds the run its lead armed after the child started", async () => {
    const child = await start(CHILD)
    const lead = await start(LEAD)
    await armed(lead)
    expect(await child.emit("tool_call", askCall(), ctxFor(CHILD))).toEqual({ block: true, reason: DENY_QUESTION })
  })

  test("a child whose parent header cannot be read is blocked while any run is armed", async () => {
    const lead = await start(LEAD)
    await armed(lead)
    const orphan: Session = { id: "orphan", file: "/s/x/orphan.jsonl", parentSession: "/s/gone.jsonl" }
    const child = await start(orphan)
    expect(await child.emit("tool_call", askCall(), ctxFor(orphan))).toEqual({ block: true, reason: DENY_QUESTION })
  })

  test("storage that cannot be read blocks every ask, since an armed run cannot be ruled out", async () => {
    const broken: HostStorage = {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => {
        throw new Error("EACCES")
      },
    }
    const setup = await start(OTHER, broken)
    const blocked = (await setup.emit("tool_call", askCall(), ctxFor(OTHER))) as { block: boolean; reason: string }
    expect(blocked.block).toBe(true)
    expect(blocked.reason).toContain("EACCES")
    expect(await setup.emit("tool_call", { ...askCall(), toolName: "read" }, ctxFor(OTHER))).toBeUndefined()
  })

  test("a dialog that opens while armed is journaled as a blocker", async () => {
    const setup = await start()
    await armed(setup)
    await setup.emit("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "safety: approve this command?" }, ctxFor(LEAD))
    expect(journal().at(-1)).toMatchObject({ type: "blocker", summary: "a dialog waits for the user while the run is unattended", evidence: "confirm: safety: approve this command?" })
  })
})

describe("turn ends and compaction", () => {
  const asking = { ...LEAD, branch: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Which option should I pick?" }] } }] }

  test("a lead whose turn ends in a question is re-prompted twice, then left for the tick", async () => {
    const setup = await start()
    await armed(setup)
    for (let turn = 0; turn < 3; turn++) await setup.emit("agent_settled", { type: "agent_settled", aborted: false }, ctxFor(asking))
    expect(setup.messages.map((sent) => sent.message.content)).toEqual([REPROMPT, REPROMPT])
    expect(setup.messages[0]).toMatchObject({ message: { customType: MESSAGE_TYPE, display: true }, options: { triggerTurn: true, deliverAs: "steer" } })
    expect(journal().at(-1)).toMatchObject({ type: "issue", summary: expect.stringContaining("3 turns in a row") })
  })

  test("an aborted turn or one that ends without a question is not re-prompted", async () => {
    const setup = await start()
    await armed(setup)
    await setup.emit("agent_settled", { type: "agent_settled", aborted: true }, ctxFor(asking))
    await setup.emit("agent_settled", { type: "agent_settled", aborted: false }, ctxFor(LEAD))
    expect(setup.messages).toEqual([])
  })

  test("compaction queues the rules and a fresh status for after the turn", async () => {
    const setup = await start()
    await armed(setup)
    await setup.emit("session_compact", { type: "session_compact", reason: "threshold" }, ctxFor(LEAD))
    expect(setup.messages.at(-1)).toMatchObject({ message: { content: expect.stringContaining("still armed after compaction") }, options: { triggerTurn: true, deliverAs: "followUp" } })
  })
})

describe("autopilot_merge authorization", () => {
  const params = { pr: 12, sha: "a".repeat(40), method: "squash" }

  test("outside a run a session without a dialog is refused, and the user's answer decides otherwise", async () => {
    const setup = await start()
    await expect(tool(setup, "autopilot_merge", params)).rejects.toThrow("cannot show a dialog")
    await expect(tool(setup, "autopilot_merge", params, { ...LEAD, hasUI: true, confirm: false })).rejects.toThrow("declined")
    // Approved: the merge goes on to read the PR, which this fake gh cannot answer.
    expect((await tool(setup, "autopilot_merge", params, { ...LEAD, hasUI: true, confirm: true })).text).toContain("refused: the PR's base branch is unreadable")
  })

  test("in a run the merge grant decides, and a merge without it is denied and journaled", async () => {
    const plain = await start()
    await armed(plain)
    await expect(tool(plain, "autopilot_merge", params, { ...LEAD, hasUI: true, confirm: true })).rejects.toThrow("autopilot never approves a permission ask")
    expect(journal().some((entry) => entry.type === "blocker" && entry.summary === "permission ask denied: autopilot_merge")).toBe(true)
  })

  test("under --allow merge the run allows it without asking", async () => {
    const setup = await start()
    await armed(setup, { allow: ["merge"] })
    expect((await tool(setup, "autopilot_merge", params)).text).toContain("refused: the PR's base branch is unreadable")
  })
})

describe("autopilot_log", () => {
  test("appends a validated entry to the run's journal", async () => {
    const setup = await start()
    await armed(setup)
    expect((await tool(setup, "autopilot_log", { type: "progress", summary: "closed p-1.1" })).text).toBe("logged progress")
    expect(journal().at(-1)).toMatchObject({ type: "progress", summary: "closed p-1.1" })
  })
})

test("the storage the lead armed is plain JSON a child process reads", async () => {
  const setup = await start()
  await armed(setup)
  const stored = (await fileStorage(agentStore).get("armed/lead")) as { [key: string]: Json }
  expect(stored).toMatchObject({ runId: expect.any(String), root: join(gitDir, "opencode-scratch", "autopilot") })
})
