import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { MODE_TOOLS, PI_SCRATCH, registerModes, STATE_ENTRY, STATUS_TOOL } from "./modes.ts"

const root = mkdtempSync(join(tmpdir(), "modes-pi-ext-"))
const home = join(root, "home")
const cwd = join(root, "repo")
const scratch = join(home, PI_SCRATCH.worktrees, "repo", "debug-x")
mkdirSync(join(cwd, "src"), { recursive: true })
mkdirSync(scratch, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** The body of the shipped pi agent file, as the extension reads it from `pi/agents/<id>.md`. */
const role = (mode: string) =>
  readFileSync(join(import.meta.dir, "..", "common", "agents", `${mode}.pi.md`), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")

type Handler = (event: unknown, ctx: unknown) => unknown
type Command = { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }
type Entry = { type: "custom"; customType: string; data: unknown }

const USER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "ast_grep_replace"]
const stateEntry = (data: unknown): Entry => ({ type: "custom", customType: STATE_ENTRY, data })

type FakeOptions = {
  omp?: boolean
  prompt?: string
  parent?: string
  confirm?: boolean
  entries?: Entry[]
  /** The session tree as the entries on each leaf's branch; `/mode` appends to the current leaf's branch. */
  branches?: Record<string, Entry[]>
  leaf?: string
}

/** A fake pi that records what the extension registers and sets, plus a session context. */
function fakePi(options: FakeOptions = {}) {
  const handlers = new Map<string, Handler[]>()
  const tools: ToolDefinition[] = []
  const commands = new Map<string, Command>()
  const notices: string[] = []
  const branches: Record<string, Entry[]> = options.branches ?? { main: [...(options.entries ?? [])] }
  let leaf = options.leaf ?? (Object.keys(branches)[0] as string)
  const headChecks: string[] = []
  let active = [...USER_TOOLS]
  const pi = {
    ...(options.omp ? { runtime: {} } : {}),
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names
    },
    appendEntry: (customType: string, data: unknown) => {
      branches[leaf] = [...(branches[leaf] ?? []), { type: "custom", customType, data }]
    },
    getSessionName: () => undefined,
  } as unknown as ExtensionAPI
  const ctx = {
    cwd,
    hasUI: true,
    ui: { notify: (text: string) => notices.push(text), confirm: async () => options.confirm ?? false },
    sessionManager: {
      getHeader: () => ({ type: "session", id: "s", parentSession: options.parent }),
      getBranch: (fromId?: string) => branches[fromId ?? leaf] ?? [],
      getEntries: () => [...new Set(Object.values(branches).flat())],
    },
    getSystemPrompt: () => options.prompt ?? "base prompt",
  }
  registerModes(pi, {
    role,
    home,
    headCheck: async (workdir) => {
      headChecks.push(workdir)
      return workdir === scratch ? undefined : "on a branch the user owns"
    },
  })
  const emit = async (name: string, event: unknown = {}) => {
    let last: unknown
    for (const handler of handlers.get(name) ?? []) last = (await handler(event, ctx)) ?? last
    return last
  }
  const call = (toolName: string, input: unknown) => emit("tool_call", { toolName, input, toolCallId: "t" })
  const mode = (args: string) => (commands.get("mode") as Command).handler(args, ctx)
  /** `/tree` to `to`, as pi reports it. */
  const tree = (to: string) => {
    const oldLeafId = leaf
    leaf = to
    return emit("session_tree", { type: "session_tree", oldLeafId, newLeafId: to })
  }
  const setActive = (names: readonly string[]) => {
    active = [...names]
  }
  return { tools, commands, notices, entries: () => branches[leaf] ?? [], headChecks, active: () => active, setActive, emit, call, mode, tree, ctx }
}

describe("/mode in the main session", () => {
  test("switches the active tools and blocks a disallowed tool", async () => {
    const pi = fakePi()
    expect(await pi.call("ast_grep_replace", {})).toBeUndefined()
    await pi.mode("refactor")
    expect(pi.active()).toEqual([...MODE_TOOLS.refactor])
    expect(await pi.call("ast_grep_replace", {})).toEqual({ block: true, reason: "`ast_grep_replace` is not available in Refactor mode" })
    expect(await pi.call("edit", { path: "src/a.test.ts" })).toEqual({ block: true, reason: "Refactor mode may not edit src/a.test.ts" })
    expect(await pi.call("edit", { path: "src/a.ts" })).toBeUndefined()
    expect(pi.entries().at(-1)).toMatchObject({ customType: STATE_ENTRY, data: { mode: "refactor", saved: USER_TOOLS } })
  })

  test("delivers the mode's reminder and role once, and the leave reminder after /mode off", async () => {
    const pi = fakePi()
    await pi.mode("debug")
    const first = (await pi.emit("before_agent_start")) as { message: { content: string; display: boolean } }
    expect(first.message.content).toContain("You are in Debug mode")
    expect(first.message.content).toContain("## Where you work")
    expect(first.message.display).toBe(false)
    expect(await pi.emit("before_agent_start")).toBeUndefined()
    await pi.mode("off")
    expect(pi.active()).toEqual(USER_TOOLS)
    expect(pi.entries().at(-1)).toMatchObject({ data: { saved: USER_TOOLS } })
    expect(((await pi.emit("before_agent_start")) as { message: { content: string } }).message.content).toContain("NO LONGER in Debug mode")
    expect(await pi.call("ast_grep_replace", {})).toBeUndefined()
  })

  test("re-delivers the reminder after compaction", async () => {
    const pi = fakePi()
    await pi.mode("concept")
    await pi.emit("before_agent_start")
    await pi.emit("session_compact")
    expect(((await pi.emit("before_agent_start")) as { message: { content: string } }).message.content).toContain("Concept mode")
  })

  test("asks the user before a call the mode's rules leave to them", async () => {
    const yes = fakePi({ confirm: true })
    await yes.mode("concept")
    expect(await yes.call("bash", { command: "ls docs" })).toBeUndefined()
    const no = fakePi({ confirm: false })
    await no.mode("concept")
    expect(await no.call("bash", { command: "ls docs" })).toMatchObject({ block: true })
  })

  test("refuses unknown modes and completes the known ones", async () => {
    const pi = fakePi()
    await pi.mode("build")
    expect(pi.notices.at(-1)).toContain('Unknown mode "build"')
    expect((pi.commands.get("mode") as Command).getArgumentCompletions?.("re")).toEqual([{ value: "refactor", label: "refactor" }])
  })

  test("a resumed session restores its mode and tools", async () => {
    const pi = fakePi({ entries: [{ type: "custom", customType: STATE_ENTRY, data: { mode: "refactor", saved: ["read"] } }] })
    await pi.emit("session_start")
    expect(pi.active()).toEqual([...MODE_TOOLS.refactor])
    expect(await pi.call("edit", { path: "tests/a.py" })).toMatchObject({ block: true })
    await pi.mode("off")
    expect(pi.active()).toEqual(["read"])
  })
})

describe("/tree in the main session", () => {
  test("back to before /mode refactor restores the user's tools and turns the guard off", async () => {
    const pi = fakePi({ branches: { before: [], main: [] }, leaf: "main" })
    await pi.mode("refactor")
    expect(await pi.call("edit", { path: "tests/a.test.ts" })).toMatchObject({ block: true })
    await pi.tree("before")
    expect(pi.active()).toEqual(USER_TOOLS)
    expect(await pi.call("edit", { path: "tests/a.test.ts" })).toBeUndefined()
    expect(await pi.call("ast_grep_replace", {})).toBeUndefined()
    expect(await pi.emit("before_agent_start")).toBeUndefined()
  })

  test("onto a branch with a mode applies that mode's tools and guard", async () => {
    const pi = fakePi({ branches: { before: [], refactor: [stateEntry({ mode: "refactor", saved: USER_TOOLS })] }, leaf: "before" })
    await pi.emit("session_start")
    expect(pi.active()).toEqual(USER_TOOLS)
    await pi.tree("refactor")
    expect(pi.active()).toEqual([...MODE_TOOLS.refactor])
    expect(await pi.call("edit", { path: "tests/a.test.ts" })).toMatchObject({ block: true })
    expect(((await pi.emit("before_agent_start")) as { message: { content: string } }).message.content).toContain("Refactor mode")
  })

  test("between branches with different modes applies the target's guard", async () => {
    const pi = fakePi({
      branches: {
        refactor: [stateEntry({ mode: "refactor", saved: USER_TOOLS })],
        concept: [stateEntry({ mode: "concept", saved: USER_TOOLS })],
      },
      leaf: "refactor",
    })
    await pi.emit("session_start")
    expect(await pi.call("write", { path: "src/a.ts" })).toBeUndefined()
    await pi.tree("concept")
    expect(await pi.call("write", { path: "src/a.ts" })).toEqual({ block: true, reason: "Concept mode may not edit src/a.ts" })
    await pi.tree("refactor")
    expect(await pi.call("write", { path: "src/a.ts" })).toBeUndefined()
  })

  test("onto a branch that left its mode restores what /mode off restored there", async () => {
    const pi = fakePi({
      branches: {
        off: [stateEntry({ mode: "debug", saved: USER_TOOLS }), stateEntry({ saved: ["read", "bash"] })],
        refactor: [stateEntry({ mode: "refactor", saved: USER_TOOLS })],
      },
      leaf: "refactor",
    })
    await pi.emit("session_start")
    await pi.tree("off")
    expect(pi.active()).toEqual(["read", "bash"])
    expect(await pi.call("edit", { path: "tests/a.test.ts" })).toBeUndefined()
  })

  test("a fresh extension instance reads the mode being left from the old branch", async () => {
    const pi = fakePi({ branches: { before: [], refactor: [stateEntry({ mode: "refactor", saved: USER_TOOLS })] }, leaf: "refactor" })
    pi.setActive(MODE_TOOLS.refactor)
    await pi.tree("before")
    expect(pi.active()).toEqual(USER_TOOLS)
  })
})

describe("a mode agent's child session", () => {
  const prompt = '<active_agent name="debug"/>\n\nYou find the root cause.'

  test("is guarded as its agent without /mode", async () => {
    const pi = fakePi({ prompt, parent: "/s/root.jsonl" })
    expect(await pi.call("write", { path: "src/a.ts" })).toEqual({ block: true, reason: "Debug mode may not edit src/a.ts" })
    expect(await pi.call("write", { path: join(scratch, "a.ts") })).toBeUndefined()
  })

  test("reads HEAD before git that writes, in the directory it runs in", async () => {
    const pi = fakePi({ prompt, parent: "/s/root.jsonl" })
    expect(await pi.call("bash", { command: `cd ${scratch} && git commit -am x` })).toBeUndefined()
    expect(pi.headChecks).toEqual([scratch])
  })

  test("cannot ask the user, so a call that needs approval is refused", async () => {
    const pi = fakePi({ prompt: '<active_agent name="concept"/>', parent: "/s/root.jsonl", confirm: true })
    expect(await pi.call("bash", { command: "ls" })).toEqual({
      block: true,
      reason: "Concept mode needs the user's approval to run `ls`; a subagent cannot ask the user",
    })
  })

  test("refuses when the guard cannot read the session", async () => {
    const pi = fakePi({ prompt, parent: "/s/root.jsonl" })
    pi.ctx.getSystemPrompt = () => {
      throw new Error("no prompt")
    }
    expect(await pi.call("read", { path: "src/a.ts" })).toEqual({ block: true, reason: "the modes guard failed (no prompt), so the call is refused" })
  })

  test("other agents' children are left alone", async () => {
    const pi = fakePi({ prompt: '<active_agent name="coder"/>', parent: "/s/root.jsonl" })
    expect(await pi.call("write", { path: "src/a.ts" })).toBeUndefined()
  })
})

describe("the status tool", () => {
  test("is registered inactive and reports the child's mode", async () => {
    const pi = fakePi({ prompt: '<active_agent name="debug"/>', parent: "/s/root.jsonl" })
    const tool = pi.tools.find((candidate) => candidate.name === STATUS_TOOL) as ToolDefinition
    expect(tool.defaultActive).toBe(false)
    const result = (await tool.execute("t", {}, undefined, undefined, pi.ctx as never)) as { content: { text: string }[] }
    expect(result.content[0]?.text).toContain(join(home, PI_SCRATCH.worktrees, "repo", "debug-<slug>"))
  })

  test("is all OMP gets: no /mode and no guard", async () => {
    const pi = fakePi({ omp: true, prompt: '<active_agent name="debug"/>', parent: "/s/root.jsonl" })
    expect(pi.tools.map((tool) => tool.name)).toEqual([STATUS_TOOL])
    expect(pi.commands.size).toBe(0)
    expect(await pi.call("write", { path: "src/a.ts" })).toBeUndefined()
  })
})
