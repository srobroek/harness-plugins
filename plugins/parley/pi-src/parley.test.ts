import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { Question } from "../shared/questions.ts"
import { askInput, endInput, resultOutput, waitInput } from "../shared/schema.ts"
import type { ParleyPanel } from "./panel.ts"
import parley, { MESSAGE_TYPE, ROUND_ENTRY } from "./parley.ts"

const plain = { fg: (_tone: string, text: string) => text, bold: (text: string) => text }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const questions: Question[] = [
  { id: "db", title: "Database", kind: "pick_one", options: [{ id: "sqlite", label: "SQLite" }, { id: "pg", label: "Postgres" }], recommended: "sqlite" },
  { id: "name", title: "Service name", kind: "ask_text" },
]

type Handler = (event: unknown, ctx: ExtensionContext) => unknown
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
type HostApi = "registerCommand" | "appendEntry" | "sendMessage"

/** The extension loaded against a stand-in pi: what it registers and what it writes to the session. `without` drops host APIs. */
function load(without: readonly HostApi[] = []) {
  const tools = new Map<string, ToolDefinition>()
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, Command>()
  const entries: { type: "custom"; customType: string; data: unknown }[] = []
  const messages: { message: { customType: string; content: string }; options: unknown }[] = []
  const api: Record<string, unknown> = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: Command) => commands.set(name, options),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: { customType: string; content: string }, options: unknown) => messages.push({ message, options }),
  }
  for (const name of without) delete api[name]
  parley(api as unknown as ExtensionAPI)
  return { tools, handlers, commands, entries, messages }
}

/** Waits until `ready` holds: the panel surface loads pi-tui on first use. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(ready()).toBe(true)
}

/**
 * A pi context. In "tui" mode `ui.custom` builds the panel and records it, as pi's interactive mode
 * would; `custom: "missing"` drops it and `"nothing"` returns without showing anything (pi's RPC mode).
 */
function context(mode: ExtensionContext["mode"], branch: readonly unknown[] = [], custom: "pi" | "missing" | "nothing" = "pi") {
  const panels: ParleyPanel[] = []
  const notices: string[] = []
  const status: (string | undefined)[] = []
  const ui: Record<string, unknown> = {
    theme: plain,
    notify: (text: string) => notices.push(text),
    setStatus: (_key: string, text: string | undefined) => status.push(text),
    custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => ParleyPanel) =>
      new Promise((resolve) => {
        const panel = factory({ requestRender: () => {}, terminal: { rows: 40 } }, plain, {}, (value) => {
          panel.dispose()
          panels.splice(panels.indexOf(panel), 1)
          resolve(value)
        })
        panels.push(panel)
      }),
  }
  if (custom === "missing") delete ui.custom
  if (custom === "nothing") ui.custom = () => undefined
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/repo",
    ui,
    sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
  } as unknown as ExtensionContext
  return { ctx, panels, notices, status }
}

const run = (tool: ToolDefinition | undefined, params: unknown, ctx: ExtensionContext, signal?: AbortSignal) =>
  (tool as ToolDefinition).execute("call-1", params as never, signal, undefined, ctx as never)

const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("\n")

/** Starts a session in `ctx` and opens a round whose panel is up. The call is wrapped: awaiting it would wait for the answer. */
async function opened(loaded: ReturnType<typeof load>, shown: ReturnType<typeof context>, params: Record<string, unknown> = {}) {
  await loaded.handlers.get("session_start")?.({ reason: "startup" }, shown.ctx)
  const pending = run(loaded.tools.get("parley_ask"), { questions, ...params }, shown.ctx)
  await until(() => shown.panels.length > 0)
  return { pending }
}

describe("parley pi extension", () => {
  test("registers the three tools with the shared schemas and the /parley command", () => {
    const { tools, commands } = load()
    expect([...tools.keys()]).toEqual(["parley_ask", "parley_wait", "parley_end"])
    expect(tools.get("parley_ask")?.parameters).toBe(askInput as never)
    expect(tools.get("parley_ask")?.outputSchema).toBe(resultOutput as never)
    expect(tools.get("parley_wait")?.parameters).toBe(waitInput as never)
    expect(tools.get("parley_end")?.parameters).toBe(endInput as never)
    expect(commands.has("parley")).toBe(true)
  })

  test("without the TUI parley_ask returns unavailable at once and opens nothing", async () => {
    const { tools, handlers, entries } = load()
    const { ctx, panels } = context("print")
    await handlers.get("session_start")?.({ reason: "startup" }, ctx)
    const result = await run(tools.get("parley_ask"), { questions }, ctx)
    expect(result.structuredContent).toMatchObject({ status: "unavailable", reason: "no_tui" })
    expect(text(result)).toContain("No parley UI is available")
    expect(panels).toEqual([])
    expect(entries).toEqual([])
  })

  test("a TUI without ctx.ui.custom, or whose custom shows nothing, gets unavailable at once", async () => {
    for (const custom of ["missing", "nothing"] as const) {
      const loaded = load()
      const { ctx } = context("tui", [], custom)
      await loaded.handlers.get("session_start")?.({ reason: "startup" }, ctx)
      const result = await run(loaded.tools.get("parley_ask"), { questions }, ctx)
      expect(result.structuredContent).toMatchObject({ status: "unavailable", reason: "no_tui" })
    }
  })

  test("loads and answers on a host without registerCommand, appendEntry or sendMessage", async () => {
    const loaded = load(["registerCommand", "appendEntry", "sendMessage"])
    expect([...loaded.tools.keys()]).toEqual(["parley_ask", "parley_wait", "parley_end"])
    const shown = context("tui")
    const { pending } = await opened(loaded, shown)
    shown.panels[0]?.handleInput("\x13")
    expect((await pending).structuredContent).toMatchObject({ status: "submitted" })
  })

  test("in the TUI the panel answers the call and every change is written to the session", async () => {
    const loaded = load()
    const shown = context("tui")
    const { pending } = await opened(loaded, shown, { title: "Setup" })
    const panel = shown.panels[0] as ParleyPanel
    expect(panel.render(80).join("\n")).toContain("Parley round 1 · Setup")
    for (const key of ["\t", "e", ..."reports", "\r", "\x13"]) panel.handleInput(key)
    const result = await pending
    expect(text(result)).toContain("Parley round 1: submitted — 2 answers, 0 pending")
    expect(result.structuredContent).toMatchObject({ status: "submitted", channel: "tui" })
    expect(shown.panels).toEqual([])
    expect(loaded.entries.every((entry) => entry.customType === ROUND_ENTRY)).toBe(true)
    expect(loaded.entries.at(-1)?.data).toMatchObject({ status: "submitted", title: "Setup" })
    expect(shown.status.at(-1)).toBeUndefined()
  })

  test("esc minimises: the status line points at /parley, which brings the round back", async () => {
    const loaded = load()
    const shown = context("tui")
    const { pending } = await opened(loaded, shown)
    shown.panels[0]?.handleInput("\x1b")
    await tick()
    expect(shown.panels).toEqual([])
    expect(shown.status.at(-1)).toBe("parley: round 1 waiting · /parley")
    await loaded.commands.get("parley")?.handler("", shown.ctx)
    expect(shown.panels).toHaveLength(1)
    shown.panels[0]?.handleInput("\x13")
    expect((await pending).structuredContent).toMatchObject({ status: "submitted" })
  })

  test("a round left open by an earlier pi process is answered later and sent to the agent as a message", async () => {
    const first = load()
    const before = context("tui")
    const { pending } = await opened(first, before)
    await first.handlers.get("session_shutdown")?.({ reason: "quit" }, before.ctx)
    expect((await pending).structuredContent).toMatchObject({ status: "unavailable" })

    const second = load()
    const after = context("tui", first.entries)
    await second.handlers.get("session_start")?.({ reason: "resume" }, after.ctx)
    expect(after.status.at(-1)).toBe("parley: round 1 waiting · /parley")
    await second.commands.get("parley")?.handler("", after.ctx)
    after.panels[0]?.handleInput("\x13")
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]?.message.customType).toBe(MESSAGE_TYPE)
    expect(second.messages[0]?.message.content).toContain("Q1 db [accepted] → SQLite")
    expect(second.messages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" })
  })

  test("parley_wait without the TUI does not wait on a restored open round", async () => {
    const first = load()
    const before = context("tui")
    const { pending } = await opened(first, before)
    await first.handlers.get("session_shutdown")?.({ reason: "quit" }, before.ctx)
    await pending

    const second = load()
    const { ctx } = context("print", first.entries)
    await second.handlers.get("session_start")?.({ reason: "resume" }, ctx)
    const result = await run(second.tools.get("parley_wait"), {}, ctx)
    expect(result.structuredContent).toMatchObject({ status: "unavailable", reason: "no_tui", round: 1, pending: ["db", "name"] })
  })

  test("parley_end closes the panel and shows the agent's message", async () => {
    const loaded = load()
    const shown = context("tui")
    await opened(loaded, shown, { wait: "none" })
    const ended = await run(loaded.tools.get("parley_end"), { message: "Thanks, all settled" }, shown.ctx)
    expect(text(ended)).toBe("Parley closed.")
    await tick()
    expect(shown.panels).toEqual([])
    expect(shown.notices).toContain("Thanks, all settled")
  })

  test("invalid questions fail the call with the reasons", async () => {
    const { tools, handlers } = load()
    const { ctx } = context("tui")
    await handlers.get("session_start")?.({ reason: "startup" }, ctx)
    await expect(run(tools.get("parley_ask"), { questions: [{ id: "x", title: "X", kind: "pick_one" }] }, ctx)).rejects.toThrow("options needs at least 2 entries")
  })
})
