import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { MERGE_POLICY_REFUSAL, type Probes } from "../shared/merge-gate.ts"
import { commandResult, type Report, type Spawn } from "../shared/preflight.ts"
import { createExtension, type Overrides, preflightDirectory, SWITCH_TIMEOUT_SECONDS, switchTimeout } from "./worktrunk.ts"

type Handler = (event: unknown, ctx: ExtensionContext) => unknown

/** Load the extension into a fake pi; returns its `tool_call` handler and the tools it registered. */
function load(overrides: Overrides = {}) {
  const handlers = new Map<string, Handler>()
  const tools: ToolDefinition[] = []
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
  } as unknown as ExtensionAPI
  createExtension(overrides)(pi)
  expect([...handlers.keys()]).toEqual(["tool_call"])
  const ctx = { cwd: "/repo" } as ExtensionContext
  return { call: (event: ToolCallEvent) => handlers.get("tool_call")?.(event, ctx), tools, ctx }
}

/** Default branch `main`, current branch `worker`. */
const probes: Probes = {
  git: async (args) => (args[0] === "branch" ? "worker" : "origin/main"),
  wt: async () => null,
}

const bash = (command: string, timeout?: number): ToolCallEvent & { input: { command: string; timeout?: number } } => ({
  type: "tool_call",
  toolCallId: "c1",
  toolName: "bash",
  input: timeout === undefined ? { command } : { command, timeout },
})

describe("worktrunk pi switch timeout", () => {
  test("raises a shorter timeout on wt switch and leaves everything else alone", () => {
    const create = "wt switch -y --create --no-cd --base abc --format json feat"
    expect(switchTimeout({ command: create, timeout: 30 })).toBe(SWITCH_TIMEOUT_SECONDS)
    expect(switchTimeout({ command: create })).toBeUndefined()
    expect(switchTimeout({ command: create, timeout: 900 })).toBeUndefined()
    expect(switchTimeout({ command: "wt list", timeout: 30 })).toBeUndefined()
    expect(switchTimeout({ command: "wt switch --help", timeout: 30 })).toBeUndefined()
  })

  test("the tool_call handler mutates the bash input in place", async () => {
    const { call } = load({ probes })
    const event = bash("wt switch -y --create --no-cd --base abc --format json feat", 10)
    expect(await call(event)).toBeUndefined()
    expect(event.input.timeout).toBe(SWITCH_TIMEOUT_SECONDS)
  })
})

describe("worktrunk pi merge gate", () => {
  test("blocks a worker-to-epic merge without history flags and allows the preserving form", async () => {
    const { call } = load({ probes })
    expect(await call(bash("wt merge epic"))).toEqual({ block: true, reason: MERGE_POLICY_REFUSAL.replace("<target>", "epic") })
    expect(await call(bash("wt merge epic --no-squash --no-ff"))).toBeUndefined()
    expect(await call(bash("wt merge main"))).toBeUndefined()
  })

  test("leaves non-bash tools and pi-subagents' own wt switch form alone", async () => {
    const { call } = load({ probes })
    expect(await call({ type: "tool_call", toolCallId: "c2", toolName: "write", input: { path: "x", content: "wt merge epic" } })).toBeUndefined()
    expect(
      await call(bash("wt -C /repo switch --create child --base abc --no-cd --no-hooks --format json")),
    ).toBeUndefined()
  })
})

describe("worktrunk_preflight tool", () => {
  test("resolves the repository directory against the session directory", () => {
    expect(preflightDirectory("/repo", undefined)).toBe("/repo")
    expect(preflightDirectory("/repo", "@sub")).toBe("/repo/sub")
    expect(preflightDirectory("/repo", "/other")).toBe("/other")
  })

  test("runs the selected checks in the repository and returns the JSON report", async () => {
    const calls: string[] = []
    const spawn: Spawn = async (args, cwd) => {
      calls.push(`${cwd}: ${args.join(" ")}`)
      if (args.join(" ") === "git rev-parse --show-toplevel") return commandResult(0, "/repo/sub\n")
      return commandResult(1)
    }
    const { tools, ctx } = load({ context: { spawn, home: "/nonexistent-home" } })
    const tool = tools.find((candidate) => candidate.name === "worktrunk_preflight")
    expect(tool).toBeDefined()
    const toolCtx = ctx as Parameters<ToolDefinition["execute"]>[4]
    const result = await tool?.execute("t1", { path: "sub", only: ["provisioning-include"] }, undefined, undefined, toolCtx)
    const report = result?.details as Report
    expect(report).toEqual({
      ok: true,
      summary: "1 pass, 0 warn, 0 fail",
      checks: [
        {
          id: "provisioning-include",
          status: "pass",
          detail: "node_modules, target, and .venv are not ignored dependency directories",
          fix: null,
        },
      ],
    })
    expect(result?.content).toEqual([{ type: "text", text: JSON.stringify(report) }])
    expect(calls[0]).toBe("/repo/sub: git rev-parse --show-toplevel")
  })
})
