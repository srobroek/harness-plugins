import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { decideCommitGate, MESSAGES } from "../shared/commit-gate.ts"
import type { MergeRequest } from "../shared/flag-cleanup.ts"
import { SKIP_CI_ADVISORY } from "../shared/skip-ci.ts"
import { createExtension, type Overrides } from "./trunk-dev.ts"

type Handler = (event: unknown, ctx: ExtensionContext) => unknown

/** Load the extension into a fake pi; returns its `tool_call` and `tool_result` handlers. */
function load(overrides: Overrides = {}) {
  const handlers = new Map<string, Handler>()
  const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI
  createExtension(overrides)(pi)
  expect([...handlers.keys()].sort()).toEqual(["tool_call", "tool_result"])
  const ctx = { cwd: "/repo" } as ExtensionContext
  return {
    call: (event: ToolCallEvent) => handlers.get("tool_call")?.(event, ctx),
    result: (event: ToolResultEvent) => handlers.get("tool_result")?.(event, ctx),
  }
}

/** A release repository at `/repo` on branch `topic`, without touching disk. */
const releaseGate = (command: string, cwd: string) =>
  decideCommitGate(command, cwd, {
    git: (args, dir) => (args[0] === "rev-parse" ? dir : args[0] === "branch" ? "topic\n" : null),
    exists: (path) => path === "/repo/.releaserc",
    list: () => [],
    processEnv: {},
  })

const bashCall = (command: string): ToolCallEvent => ({ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command } })

function bashResult(command: string, isError = false, structuredContent?: ToolResultEvent["structuredContent"]): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "c1",
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text: "ok" }],
    details: undefined,
    isError,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  }
}

describe("trunk-dev pi tool_call gate", () => {
  test("blocks a non-conventional commit and allows a conventional one in a release repository", () => {
    const { call } = load({ commitGate: releaseGate })
    expect(call(bashCall("git commit -m 'add feature'"))).toEqual({ block: true, reason: `trunk-dev: ${MESSAGES.commit}` })
    expect(call(bashCall("git commit -m 'feat(api): add feature'"))).toBeUndefined()
  })

  test("blocks a direct push to main and allows a topic-branch push", () => {
    const { call } = load({ commitGate: releaseGate })
    expect(call(bashCall("git push origin main"))).toEqual({ block: true, reason: `trunk-dev: ${MESSAGES.push}` })
    expect(call(bashCall("git push -u origin topic"))).toBeUndefined()
  })

  test("reads the session directory from ctx.cwd and ignores non-bash tools", () => {
    const seen: string[] = []
    const { call } = load({
      commitGate: (_command, cwd) => {
        seen.push(cwd)
        return { reason: "nope" }
      },
    })
    expect(call(bashCall("git commit -m x"))).toEqual({ block: true, reason: "trunk-dev: nope" })
    expect(seen).toEqual(["/repo"])
    expect(call({ type: "tool_call", toolCallId: "c2", toolName: "write", input: { path: "a", content: "git commit -m x" } })).toBeUndefined()
    expect(seen).toEqual(["/repo"])
  })

  test("a gate that throws allows the call", () => {
    const { call } = load({
      commitGate: () => {
        throw new Error("probe failed")
      },
    })
    expect(call(bashCall("git commit -m x"))).toBeUndefined()
  })
})

describe("trunk-dev pi tool_result advisories", () => {
  const advise = (command: string) => (command.includes("gh pr create") ? ["trunk-dev: advice"] : [])

  test("appends skip-CI before MR/PR advice in one text block and keeps structured content", async () => {
    const { result } = load({ advise })
    const command = "gh pr create --title 'feat: x [skip ci]'"
    const structured = { output: "ok", exit_code: 0 }
    expect(await result(bashResult(command, false, structured))).toEqual({
      content: [
        { type: "text", text: "ok" },
        { type: "text", text: `${SKIP_CI_ADVISORY}\ntrunk-dev: advice` },
      ],
      structuredContent: structured,
    })
  })

  test("a failed call, a quiet command and a non-bash tool get nothing", async () => {
    const { result } = load({ advise })
    expect(await result(bashResult("gh pr create --title 'feat: x [skip ci]'", true))).toBeUndefined()
    expect(await result(bashResult("git status"))).toBeUndefined()
    const read: ToolResultEvent = { ...bashResult("git commit -m '[skip ci]'"), toolName: "read", details: undefined }
    expect(await result(read)).toBeUndefined()
  })

  test("a successful shell merge gets the flag-cleanup follow-up; a failing follow-up is silent", async () => {
    const merges: MergeRequest[][] = []
    const { result } = load({
      advise: () => [],
      followUp: async (found) => {
        merges.push([...found])
        return "trunk-dev: created cleanup bead c-1"
      },
    })
    expect(await result(bashResult("gh pr merge 7 --merge"))).toEqual({
      content: [
        { type: "text", text: "ok" },
        { type: "text", text: "trunk-dev: created cleanup bead c-1" },
      ],
    })
    expect(merges).toEqual([[{ forge: "gh", number: "7", cwd: "/repo" }]])
    expect(await result(bashResult("gh pr merge 7", true))).toBeUndefined()
    expect(merges).toHaveLength(1)

    const failing = load({ advise: () => [], followUp: () => Promise.reject(new Error("bd missing")) })
    expect(await failing.result(bashResult("gh pr merge 7"))).toBeUndefined()
  })
})
