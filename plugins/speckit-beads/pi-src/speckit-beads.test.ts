import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { setSpawnForTests } from "../opencode/src/setup.ts"
import { ANALYZE_NOTE, IMPLEMENT_REDIRECT, IMPLEMENT_ROUTE } from "../opencode/src/skills.ts"
import { MESSAGE_TYPE, WORKFLOW_SECTION } from "./routes.ts"
import { type SpeckitPiDeps, setupSpeckitPi } from "./speckit-beads.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "speckit-beads-pi-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A repository with `.specify/`, and one without. */
const speckit = join(root, "speckit")
const plain = join(root, "plain")
for (const dir of [join(speckit, ".specify"), join(speckit, ".git"), plain]) mkdirSync(dir, { recursive: true })

type Handler = (event: unknown, ctx: unknown) => unknown

function load(options: Record<string, unknown> = {}, deps: Partial<SpeckitPiDeps> = {}) {
  const optionsPath = join(root, `options-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(optionsPath, JSON.stringify(options))
  const handlers = new Map<string, Handler[]>()
  const tools = new Map<string, ToolDefinition>()
  const probes: string[] = []
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI
  setupSpeckitPi(pi, {
    optionsPath,
    probe: async (dir) => {
      probes.push(dir)
      return true
    },
    ...deps,
  })
  const notices: string[] = []
  const ctxFor = (cwd: string) => ({ cwd, hasUI: true, ui: { notify: (message: string) => notices.push(message) } })
  const emit = async (name: string, event: unknown, cwd = speckit) => {
    let last: unknown
    for (const handler of handlers.get(name) ?? []) last = (await handler(event, ctxFor(cwd))) ?? last
    return last
  }
  const execute = (name: string, params: unknown, cwd = speckit) =>
    tools.get(name)?.execute("call_1", params as never, new AbortController().signal, undefined, ctxFor(cwd) as never) as Promise<{
      content: { text: string }[]
      details: Record<string, unknown>
    }>
  return { handlers, tools, probes, notices, emit, execute, optionsPath }
}

const agentStart = () => ({ type: "before_agent_start", messageType: "user", prompt: "x", systemPromptOptions: { sections: {} as Record<string, string> } })

describe("registration", () => {
  test("registers the three tools and every handler", () => {
    const { tools, handlers } = load()
    expect([...tools.keys()].sort()).toEqual(["speckit_commit", "speckit_setup", "speckit_start"])
    expect([...handlers.keys()].sort()).toEqual(["before_agent_start", "input", "session_start", "tool_call", "tool_result"])
    expect(tools.get("speckit_setup")?.promptSnippet).toStartWith("Resumable SpecKit bootstrap")
  })

  test("tasksGuard false drops the guard, and a broken options file warns", async () => {
    expect(load({ tasksGuard: false }).handlers.has("tool_call")).toBe(false)
    const broken = load()
    writeFileSync(broken.optionsPath, "{")
    const reloaded = load({}, { optionsPath: broken.optionsPath })
    await reloaded.emit("session_start", { type: "session_start" })
    expect(reloaded.notices[0]).toContain("is not valid JSON; the defaults apply")
  })
})

describe("tasks.md guard", () => {
  test("blocks writes, edits and shell writes of tasks.md, including an @ path", async () => {
    const { emit } = load()
    const block = (toolName: string, input: unknown) => emit("tool_call", { type: "tool_call", toolCallId: "c", toolName, input })
    for (const [toolName, input] of [
      ["write", { path: "@specs/001-a/tasks.md", content: "x" }],
      ["edit", { path: join(speckit, "specs/001-a/tasks.md"), edits: [] }],
      ["bash", { command: "echo '- [ ] T1' >> specs/001-a/tasks.md" }],
    ] as const) {
      const result = (await block(toolName, input)) as { block: boolean; reason: string }
      expect(result.block).toBe(true)
      expect(result.reason).toContain("speckit-ledger")
      expect(result.reason).toContain('"tasksGuard": false')
    }
    expect(await block("write", { path: "specs/001-a/spec.md", content: "x" })).toBeUndefined()
    expect(await block("read", { path: "specs/001-a/tasks.md" })).toBeUndefined()
  })

  test("lets the write through where beads is inactive", async () => {
    const { emit } = load({}, { probe: async () => false })
    expect(await emit("tool_call", { toolName: "write", input: { path: "specs/001-a/tasks.md", content: "x" } })).toBeUndefined()
  })
})

describe("command routes", () => {
  test("implement becomes the beads route and taskstoissues is refused", async () => {
    const { emit, notices } = load()
    expect(await emit("input", { type: "input", text: "/speckit.implement", source: "interactive" })).toEqual({
      action: "transform",
      text: IMPLEMENT_ROUTE,
    })
    expect(await emit("input", { type: "input", text: "/speckit.taskstoissues", source: "interactive" })).toEqual({ action: "handled" })
    expect(notices[0]).toContain("taskstoissues turns tasks.md into GitHub issues")
    expect(await emit("input", { type: "input", text: "/speckit.plan", source: "interactive" })).toBeUndefined()
  })

  test("analyze expands unchanged and its run gets the note once", async () => {
    const { emit } = load()
    expect(await emit("input", { type: "input", text: "/speckit.analyze", source: "interactive" })).toBeUndefined()
    expect(await emit("before_agent_start", agentStart())).toEqual({
      message: { customType: MESSAGE_TYPE, content: ANALYZE_NOTE, display: true },
    })
    expect(await emit("before_agent_start", agentStart())).toBeUndefined()
    // Another prompt typed before the analyze run started cancels the note.
    await emit("input", { type: "input", text: "/speckit.analyze", source: "interactive" })
    await emit("input", { type: "input", text: "hello", source: "interactive" })
    expect(await emit("before_agent_start", agentStart())).toBeUndefined()
  })

  test("routes are off where beads is inactive", async () => {
    const { emit } = load({}, { probe: async () => false })
    expect(await emit("input", { type: "input", text: "/speckit.implement", source: "interactive" })).toBeUndefined()
  })

  test("a read of the implement prompt returns the route; other reads are left alone", async () => {
    const { emit, probes } = load()
    const read = (path: string) =>
      emit("tool_result", { type: "tool_result", toolName: "read", input: { path }, content: [{ type: "text", text: "upstream" }], isError: false })
    expect(await read(".pi/prompts/speckit.implement.md")).toEqual({ content: [{ type: "text", text: IMPLEMENT_REDIRECT }] })
    expect(await read("specs/001-a/spec.md")).toBeUndefined()
    expect(probes).toEqual([speckit])
  })
})

describe("workflow section", () => {
  test("goes into each run in a SpecKit workspace, and nowhere else", async () => {
    const { emit } = load()
    const inSpeckit = agentStart()
    await emit("before_agent_start", inSpeckit)
    expect(inSpeckit.systemPromptOptions.sections[WORKFLOW_SECTION]).toStartWith("# SpecKit workflow (srobroek.speckit-beads)")
    const inPlain = agentStart()
    await emit("before_agent_start", inPlain, plain)
    expect(inPlain.systemPromptOptions.sections).toEqual({})
    const off = load({ workflow: false })
    const disabled = agentStart()
    await off.emit("before_agent_start", disabled)
    expect(disabled.systemPromptOptions.sections).toEqual({})
  })

  test("speckit_setup carries it when the run started without it", async () => {
    const { emit, execute } = load()
    const repo = join(root, "fresh")
    mkdirSync(repo)
    // Every setup subprocess succeeds: bd runs and finds a workspace, so no real bd init runs.
    setSpawnForTests(() => ({ exitCode: 0, stdout: "", stderr: "" }))
    try {
      await emit("before_agent_start", agentStart(), repo)
      mkdirSync(join(repo, ".specify"))
      const first = await execute("speckit_setup", { skipSpecify: true }, repo)
      expect(first.details.ok).toBe(true)
      expect(first.content[0]?.text).toContain("# SpecKit workflow")
      await emit("before_agent_start", agentStart(), repo)
      const second = await execute("speckit_setup", { skipSpecify: true }, repo)
      expect(second.content[0]?.text).not.toContain("# SpecKit workflow")
    } finally {
      setSpawnForTests(null)
    }
  })
})

test("speckit_setup refuses an input it does not know, such as a dropped option", async () => {
  const { execute } = load()
  const result = await execute("speckit_setup", { skipFormulas: true })
  expect(result.content[0]?.text.split("\n", 1)[0]).toBe("speckit_setup: unknown input skipFormulas")
  expect(result.details.ok).toBe(false)
})
