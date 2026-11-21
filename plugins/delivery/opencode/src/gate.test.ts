import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import type { CleanupDeps } from "./cleanup.ts"
import * as realCleanup from "./cleanup.ts"
import { cleanupGate, createGateRegistry, landGate } from "./gate.ts"
import * as realLand from "./land.ts"
import type { LandDeps } from "./land.ts"

const HEAD = "a".repeat(40)

describe("landGate", () => {
  const gated = { pr: 7, expectHeadSha: HEAD, requireApproval: true, requireGreenChecks: true }
  test("is true only when the head is bound and approval and checks are both required", () => {
    expect(landGate(gated)).toBe(true)
  })
  test.each([
    ["no head", { ...gated, expectHeadSha: undefined }],
    ["blank head", { ...gated, expectHeadSha: "  " }],
    ["no approval", { ...gated, requireApproval: undefined }],
    ["approval false", { ...gated, requireApproval: false }],
    ["no checks", { ...gated, requireGreenChecks: undefined }],
    ["checks as a string", { ...gated, requireGreenChecks: "true" }],
    ["head as a number", { ...gated, expectHeadSha: 1 }],
  ])("is false with %s", (_name, input) => {
    expect(landGate(input)).toBe(false)
  })
  test.each([[null], [undefined], ["requireApproval"], [7]])("is false for a non-object %p", (input) => {
    expect(landGate(input)).toBe(false)
  })
})

describe("cleanupGate", () => {
  const bound = { worktree: "/w/a", branch: "b", pr: 7, receiptBound: true }
  test("is true for a verified receipt that names the worktree and branch", () => {
    expect(cleanupGate(bound)).toBe(true)
  })
  test.each([
    ["receipt not bound", { ...bound, receiptBound: false }],
    ["bound flag absent", { ...bound, receiptBound: undefined }],
    ["no worktree", { ...bound, worktree: "" }],
    ["no branch", { ...bound, branch: "" }],
    ["branch missing", { ...bound, branch: undefined }],
    ["pr zero", { ...bound, pr: 0 }],
    ["pr fraction", { ...bound, pr: 1.5 }],
  ])("is false with %s", (_name, request) => {
    expect(cleanupGate(request)).toBe(false)
  })
})

describe("createGateRegistry", () => {
  test("skips a resource only while a gated assert is in flight", () => {
    const gates = createGateRegistry()
    expect(gates.skips("delivery_land", ["o/r#1"])).toBe(false)
    const leave = gates.enter("delivery_land", "o/r#1", true)
    expect(gates.skips("delivery_land", ["o/r#1"])).toBe(true)
    expect(gates.skips("delivery_cleanup", ["o/r#1"])).toBe(false)
    expect(gates.skips("delivery_land", ["o/r#1", "o/r#2"])).toBe(false)
    leave()
    leave()
    expect(gates.skips("delivery_land", ["o/r#1"])).toBe(false)
  })
  test("an ungated assert for the same resource in flight keeps the prompt", () => {
    const gates = createGateRegistry()
    gates.enter("delivery_land", "o/r#1", true)
    const leave = gates.enter("delivery_land", "o/r#1", false)
    expect(gates.skips("delivery_land", ["o/r#1"])).toBe(false)
    leave()
    expect(gates.skips("delivery_land", ["o/r#1"])).toBe(true)
  })
  test("no resources is never skipped", () => {
    expect(createGateRegistry().skips("delivery_land", [])).toBe(false)
  })
})

// The tools run for real up to their authorize step; the forge and the repository are replaced.
const originalCleanup = { ...realCleanup }
const originalLand = { ...realLand }
let receiptBound = true

beforeAll(() => {
  mock.module("./land.ts", () => ({
    ...originalLand,
    landPullRequest: async (_params: unknown, deps: LandDeps) => {
      await deps.authorize?.({ resource: "o/r#7", forge: "github", head: HEAD, merge: "squash", setupAutoDelete: false })
      return { ok: false, text: "stub: stopped after authorize", next: [] }
    },
  }))
  mock.module("./cleanup.ts", () => ({
    ...originalCleanup,
    cleanupDelivery: async (_params: unknown, _cwd: string, deps: CleanupDeps) => {
      await deps.authorize?.({ worktree: "/w/a", branch: "b", pr: 7, receiptBound })
      return { ok: false, reason: "stub: stopped after authorize" }
    },
  }))
})
afterAll(() => {
  mock.module("./land.ts", () => originalLand)
  mock.module("./cleanup.ts", () => originalCleanup)
})
beforeEach(() => {
  receiptBound = true
})

type Rule = "allow" | "deny"

/** Plugin set up against a fake host that resolves every permission with `rule`, then the evaluate hook, as OpenCode does. */
async function run(tool: string, rule: Rule, input: Record<string, unknown>) {
  const prompts: string[] = []
  const fake: ReturnType<typeof createFakeContext> = createFakeContext({
    assert: async (call) => {
      const evaluation = { action: call.action, resources: call.resources, effect: rule as string }
      if (rule !== "deny") await fake.fire.permission("evaluate", evaluation)
      if (evaluation.effect === "ask") prompts.push(`${call.action} ${call.resources.join(",")}`)
      if (evaluation.effect === "deny") throw new Error(`${call.action} denied`)
    },
  })
  const { default: plugin } = await import("./index.ts")
  await plugin.setup(fake.context)
  const execute = fake.tools.get(tool)?.execute as (i: unknown, c: unknown) => Promise<{ content: string }>
  const outcome = await execute(input, { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal }).then(
    () => "ran",
    (error: Error) => error.message,
  )
  return { prompts, outcome }
}

describe("delivery_land permission", () => {
  const gated = { pr: 7, expectHeadSha: HEAD, requireApproval: true, requireGreenChecks: true }

  test("a fully gated land asks nothing when the rules allow", async () => {
    expect((await run("delivery_land", "allow", gated)).prompts).toEqual([])
  })

  test.each([
    ["expectHeadSha", { ...gated, expectHeadSha: undefined }],
    ["requireApproval", { ...gated, requireApproval: undefined }],
    ["requireGreenChecks", { ...gated, requireGreenChecks: undefined }],
    ["all gates", { pr: 7 }],
  ])("a land without %s still asks", async (_name, input) => {
    expect((await run("delivery_land", "allow", input)).prompts).toEqual(["delivery_land o/r#7"])
  })

  test("a configured deny still wins for a fully gated land", async () => {
    const { prompts, outcome } = await run("delivery_land", "deny", gated)
    expect(prompts).toEqual([])
    expect(outcome).toBe("delivery_land denied")
  })
})

describe("delivery_cleanup permission", () => {
  test("a cleanup bound to a verified receipt asks nothing when the rules allow", async () => {
    expect((await run("delivery_cleanup", "allow", { pr: 7 })).prompts).toEqual([])
  })

  test("a cleanup whose receipt does not bind the target worktree and branch still asks", async () => {
    receiptBound = false
    expect((await run("delivery_cleanup", "allow", { pr: 7 })).prompts).toEqual(["delivery_cleanup /w/a"])
  })

  test("a configured deny still wins for a bound cleanup", async () => {
    const { outcome } = await run("delivery_cleanup", "deny", { pr: 7 })
    expect(outcome).toBe("delivery_cleanup denied")
  })
})
