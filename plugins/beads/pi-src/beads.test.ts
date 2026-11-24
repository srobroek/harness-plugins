import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { setBdShowRunForTests } from "../opencode/src/bd-close-gate.ts"
import type { BdRun } from "../opencode/src/gate-admission.ts"
import { commandResult, type PreflightDeps } from "../shared/preflight.ts"
import { type BeadsPiDeps, keptAlive, refusalText, setupBeadsPi, toolPath } from "./beads.ts"

const root = mkdtempSync(join(tmpdir(), "beads-pi-"))
const repo = join(root, "repo")
mkdirSync(repo, { recursive: true })
afterAll(() => {
  setBdShowRunForTests(null)
  rmSync(root, { recursive: true, force: true })
})
// The close gate's gate-type lookup: every bead here is a task, never a gate bead.
beforeAll(() =>
  setBdShowRunForTests((argv) => {
    const ids = argv.slice(argv.indexOf("show") + 1).filter((arg) => !arg.startsWith("--"))
    return { exitCode: 0, stdout: JSON.stringify(ids.map((id) => ({ id, issue_type: "task" }))) }
  }),
)

/** Tool call ids are unique within a session, as the model's are. */
let callNumber = 0

type Handler = (event: unknown, ctx: unknown) => unknown

/** A fake `pi` that records handlers and tools, and a session context for it. */
function fakePi() {
  const handlers = new Map<string, Handler[]>()
  const tools: ToolDefinition[] = []
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
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
  return { pi, tools, emit }
}

type Session = { id: string; file?: string; parentSession?: string; cwd?: string }

function ctxFor(session: Session) {
  return {
    cwd: session.cwd ?? repo,
    sessionManager: {
      getSessionId: () => session.id,
      getSessionFile: () => session.file,
      getHeader: () => ({ type: "session", id: session.id, cwd: repo, parentSession: session.parentSession }),
    },
  }
}

const ROOT: Session = { id: "root", file: "/s/root.jsonl" }
const CHILD: Session = { id: "child", file: "/s/root/run/child.jsonl", parentSession: "/s/root.jsonl" }
const headers = { "/s/root.jsonl": { id: "root" } } as Record<string, { id: string }>

type Bead = { status: string; assignee?: string }

/** A fake bd: `show` and `list --assignee` over `table`; every call recorded. */
function fakeBd(table: Record<string, Bead>, calls: string[][] = []): BdRun {
  return async (_cwd, args) => {
    calls.push(args)
    const verb = args.find((arg) => !arg.startsWith("-"))
    if (verb === "show") {
      const ids = args.slice(args.indexOf("show") + 1).filter((arg) => !arg.startsWith("--"))
      const rows = ids.flatMap((id) => (table[id] === undefined ? [] : [{ id, ...table[id] }]))
      return rows.length === 0 ? { failure: "bd exited with code 1: no issues found" } : { output: JSON.stringify({ schema_version: 1, data: rows }) }
    }
    if (verb === "list") {
      const actor = args[args.indexOf("--assignee") + 1]
      const rows = Object.entries(table).filter(([, bead]) => bead.status === "in_progress" && bead.assignee === actor)
      return { output: JSON.stringify({ schema_version: 1, data: rows.map(([id, bead]) => ({ id, ...bead })) }) }
    }
    return { failure: `unexpected bd ${args.join(" ")}` }
  }
}

function setup(table: Record<string, Bead> = {}, deps: BeadsPiDeps = {}) {
  const calls: string[][] = []
  const fake = fakePi()
  setupBeadsPi(fake.pi, {
    env: {},
    run: fakeBd(table, calls),
    pinFor: () => undefined,
    readHeader: (file) => headers[file],
    optionsPath: join(root, "missing.json"),
    ...deps,
  })
  const bash = async (command: string, session: Session = ROOT) => {
    const event = { type: "tool_call", toolName: "bash", toolCallId: `call-${callNumber++}`, input: { command } }
    const result = (await fake.emit("tool_call", event, ctxFor(session))) as { block?: boolean; reason?: string } | undefined
    return { result, command: event.input.command, id: event.toolCallId }
  }
  const write = async (path: string, session: Session) => {
    const event = { type: "tool_call", toolName: "write", toolCallId: `call-${callNumber++}`, input: { path, content: "x" } }
    return (await fake.emit("tool_call", event, ctxFor(session))) as { block?: boolean; reason?: string } | undefined
  }
  return { ...fake, calls, bash, write }
}

const EVIDENCE = '--reason "bun test x.test.ts: 3 pass"'

describe("bash gate", () => {
  test("every bash call starts with this session's actor", async () => {
    const { bash } = setup()
    const { result, command } = await bash("ls")
    expect(result).toBeUndefined()
    expect(command).toBe("unset BEADS_ACTOR; export BD_ACTOR='pi/root'; ls")
  })

  test("a child writes under its own actor below its root", async () => {
    const { bash } = setup()
    expect((await bash("ls", CHILD)).command).toBe("unset BEADS_ACTOR; export BD_ACTOR='pi/root/child'; ls")
  })

  test("the session's store is pinned ahead of the command", async () => {
    const { bash } = setup({}, { pinFor: () => "/r/.beads", env: { BEADS_DIR: "/old/.beads", HARNESS_BEADS_PIN: "/old/.beads" } })
    const { command } = await bash("git status")
    expect(command.split("\n").slice(0, 3)).toEqual([
      "export BEADS_DOLT_SHARED_SERVER=''",
      "export BEADS_DIR='/r/.beads'",
      "export HARNESS_BEADS_PIN='/r/.beads'",
    ])
    expect(command.endsWith("git status")).toBe(true)
  })

  test("an unclaimed close is blocked and a claimed one passes", async () => {
    const { bash } = setup({ "ab-1": { status: "open" }, "ab-2": { status: "in_progress", assignee: "pi/root" } })
    const blocked = await bash(`bd close ab-1 ${EVIDENCE}`)
    expect(blocked.result?.block).toBe(true)
    expect(blocked.result?.reason).toContain("ab-1 (open), which this session (pi/root) has not claimed")
    expect(blocked.result?.reason).toContain("(beads gate bd-claim-gate)")
    expect(blocked.command).toBe(`bd close ab-1 ${EVIDENCE}`)
    const passed = await bash(`bd close ab-2 ${EVIDENCE}`)
    expect(passed.result).toBeUndefined()
    expect(passed.command.endsWith(`bd close ab-2 ${EVIDENCE}`)).toBe(true)
  })

  test("a parent closes its child's claim; the child may not close its parent's", async () => {
    const { bash } = setup({ "ab-1": { status: "in_progress", assignee: "pi/root/child" }, "ab-2": { status: "in_progress", assignee: "pi/root" } })
    expect((await bash(`bd close ab-1 ${EVIDENCE}`)).result).toBeUndefined()
    expect((await bash(`bd close ab-2 ${EVIDENCE}`, CHILD)).result?.reason).toContain("held by pi/root")
  })

  test("a close without evidence is blocked", async () => {
    const { bash, calls } = setup({ "ab-2": { status: "in_progress", assignee: "pi/root" } })
    expect((await bash('bd close ab-2 --reason "done"')).result?.reason).toContain("(beads gate bd-close-evidence-gate)")
    expect(calls).toEqual([])
  })

  test("beads.json gitWrappers lets close evidence cite a listed wrapper", async () => {
    const table = { "ab-2": { status: "in_progress", assignee: "pi/root" } }
    const close = 'bd close ab-2 --reason "dgit push origin topic"'
    expect((await setup(table).bash(close)).result?.reason).toContain("(beads gate bd-close-evidence-gate)")
    const optionsPath = join(root, "beads.json")
    writeFileSync(optionsPath, JSON.stringify({ gitWrappers: ["git", "dgit"] }))
    expect((await setup(table, { optionsPath }).bash(close)).result).toBeUndefined()
  })

  test("a malformed beads.json warns at session start", async () => {
    const optionsPath = join(root, "bad-beads.json")
    writeFileSync(optionsPath, "{")
    const { emit } = setup({}, { optionsPath })
    const notes: string[] = []
    await emit("session_start", {}, { ...ctxFor(ROOT), hasUI: true, ui: { notify: (text: string) => notes.push(text) } })
    expect(notes).toEqual([`beads: ${optionsPath} is not valid JSON; close evidence counts only \`git\` as git.`])
  })

  test("the OpenCode shell gates run too", async () => {
    const { bash } = setup()
    expect((await bash("bd edit ab-1")).result?.reason).toContain("(beads gate bd-editor-gate)")
    expect((await bash("bd unclaim ab-1")).result?.reason).toContain("(beads gate bd-unclaim-gate)")
    expect((await bash("bd update ab-1 --status closed")).result?.reason).toContain("(beads gate bd-update-close-gate)")
  })

  test("a call another instance already gated is left alone", async () => {
    const fake = fakePi()
    const deps = { env: {}, run: fakeBd({}), pinFor: () => undefined, readHeader: () => undefined, optionsPath: join(root, "missing.json") }
    setupBeadsPi(fake.pi, deps)
    setupBeadsPi(fake.pi, deps)
    const event = { type: "tool_call", toolName: "bash", toolCallId: "dup-1", input: { command: "ls" } }
    await fake.emit("tool_call", event, ctxFor({ id: "dedupe" }))
    expect(event.input.command).toBe("unset BEADS_ACTOR; export BD_ACTOR='pi/dedupe'; ls")
  })

  test("the result carries the gates' advisories and bd's contention hint", async () => {
    const { bash, emit } = setup()
    const { id } = await bash("bd ready --json")
    const result = (await emit(
      "tool_result",
      { type: "tool_result", toolName: "bash", toolCallId: id, input: {}, content: [{ type: "text", text: "lock busy: held by another process" }] },
      ctxFor(ROOT),
    )) as { content: Array<{ text: string }> }
    expect(result.content).toHaveLength(2)
    expect(result.content[1]?.text).toContain("embedded-store contention")
  })
})

describe("child write gate", () => {
  const store = (dir: string) => (dir.startsWith(repo) ? join(repo, ".beads") : undefined)

  test("a child without a claim may not write in a Beads checkout", async () => {
    const { write } = setup({}, { pinFor: store })
    const result = await write("src/a.ts", CHILD)
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain("this subagent (pi/root/child) holds no claim")
    expect(result?.reason).toContain("(beads gate write-claim-gate)")
  })

  test("a child holding a claim writes, and bd is asked once per window", async () => {
    const { write, calls } = setup({ "ab-1": { status: "in_progress", assignee: "pi/root/child" } }, { pinFor: store })
    expect(await write("src/a.ts", CHILD)).toBeUndefined()
    expect(await write("src/b.ts", CHILD)).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  test("the root session and files outside a Beads checkout are not gated", async () => {
    const { write, calls } = setup({}, { pinFor: store })
    expect(await write("src/a.ts", ROOT)).toBeUndefined()
    expect(await write("/elsewhere/a.ts", CHILD)).toBeUndefined()
    expect(calls).toEqual([])
  })

  test("a bd answer the gate cannot read refuses the write", async () => {
    const { write } = setup({}, { pinFor: store, run: async () => ({ failure: "bd command timed out" }) })
    expect((await write("a.ts", CHILD))?.reason).toContain("could not be read (bd command timed out)")
  })
})

describe("beads_preflight tool", () => {
  const preflight = (seen: Array<Record<string, string | undefined>>): BeadsPiDeps["preflight"] => (env) => {
    seen.push(env)
    const deps: PreflightDeps = {
      env,
      which: () => null,
      run: async () => commandResult(1, "", "unused"),
    }
    return deps
  }

  test("returns the script's JSON report, run with the session's actor", async () => {
    const seen: Array<Record<string, string | undefined>> = []
    const { tools } = setup({}, { preflight: preflight(seen) })
    const tool = tools.find((candidate) => candidate.name === "beads_preflight")
    const result = await tool?.execute("t-1", { only: ["bd-available", "actor-identity"], apply: true }, undefined, undefined, ctxFor(CHILD) as never)
    const report = JSON.parse(result?.content[0]?.type === "text" ? result.content[0].text : "")
    expect(report.ok).toBe(false)
    expect(report.checks.map((check: { id: string; status: string }) => [check.id, check.status])).toEqual([
      ["bd-available", "fail"],
      ["actor-identity", "pass"],
    ])
    expect(result?.content[1]).toEqual({ type: "text", text: "No beads check has a safe automatic fix; --apply performed no mutation." })
    expect(seen[0]?.BD_ACTOR).toBe("pi/root/child")
  })

  test("an unknown check id is a tool error", async () => {
    const { tools } = setup({}, { preflight: preflight([]) })
    const tool = tools.find((candidate) => candidate.name === "beads_preflight")
    await expect(tool?.execute("t-2", { only: ["nope"] }, undefined, undefined, ctxFor(ROOT) as never)).rejects.toThrow("unknown check id(s): nope")
  })
})

describe("helpers", () => {
  test("tool paths resolve as pi's file tools do", () => {
    expect(toolPath("@src/a.ts", "/w")).toBe("/w/src/a.ts")
    expect(toolPath("/abs/a.ts", "/w")).toBe("/abs/a.ts")
    expect(toolPath("~/x", "/w").endsWith("/x")).toBe(true)
  })

  test("a refusal reads as cause, fix and gate", () => {
    expect(refusalText({ gate: "g", cause: "c", resolution: "r" })).toBe("c; r. (beads gate g)")
  })

  test("a gate held open keeps its result or its error", async () => {
    expect(await keptAlive(async () => "value")).toBe("value")
    await expect(keptAlive(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
  })
})
