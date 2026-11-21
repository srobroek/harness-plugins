import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import type { CleanupDeps } from "./cleanup.ts"
import { cleanupGate, createGateRegistry, landAuthorizationGated, landGate } from "./gate.ts"
import { setupDelivery } from "./index.ts"
import {
  type Answers,
  cleanupFixtures,
  completed,
  githubPr,
  HEAD_OID,
  linkedWorktree,
  matchingVerbs,
  mergedGithubPr,
  repository,
  runner,
} from "./land-fixture.ts"

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

describe("landAuthorizationGated", () => {
  const gated = { expectHeadSha: HEAD, requireApproval: true, requireGreenChecks: true }
  test("needs the gated input and either a trusted approval or an already merged request", () => {
    expect(landAuthorizationGated(gated, { alreadyMerged: false, approvalTrusted: true })).toBe(true)
    expect(landAuthorizationGated(gated, { alreadyMerged: true, approvalTrusted: false })).toBe(true)
    expect(landAuthorizationGated(gated, { alreadyMerged: false, approvalTrusted: false })).toBe(false)
    expect(landAuthorizationGated({ ...gated, requireApproval: false }, { alreadyMerged: true, approvalTrusted: true })).toBe(false)
  })
})

afterEach(cleanupFixtures)

type Rule = "allow" | "deny"

const GATED = { pr: 470, expectHeadSha: HEAD_OID, requireApproval: true, requireGreenChecks: true }
const greenRuns = completed(JSON.stringify({ total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }))
const approvedBy = (login: string) =>
  completed(JSON.stringify({ author: { login: "author" }, reviews: [{ state: "APPROVED", author: { login }, commit: { oid: HEAD_OID } }], comments: [] }))
const forge = (extra: Answers = {}): Answers => ({
  prView: [completed(githubPr()), completed(mergedGithubPr())],
  approval: approvedBy("reviewer"),
  checkRuns: greenRuns,
  ...extra,
})

/**
 * The real plugin and the real `landPullRequest` over a scripted forge and git process boundary,
 * against a fake host that resolves every permission with `rule`, then the evaluate hook, as OpenCode does.
 */
async function land(rule: Rule, input: Record<string, unknown>, answers: Answers, inline?: (deps: CleanupDeps) => Promise<void>) {
  const { canonical, receipts } = repository()
  // An active Beads ledger defers inline cleanup, so the inline cases run without one.
  if (inline === undefined) mkdirSync(join(canonical, ".beads"))
  // Ownership of the worktree is read with real git, so the inline cases need a real repository.
  if (inline !== undefined) execFileSync("git", ["init", "-q", "-b", "main"], { cwd: canonical })
  const worktree = inline === undefined ? {} : { worktree: linkedWorktree(canonical, "wt") }
  const { run, calls } = runner(answers, canonical)
  const prompts: string[] = []
  let inlineRan = false
  const fake: ReturnType<typeof createFakeContext> = createFakeContext({
    directory: canonical,
    options: { receiptsDirectory: receipts, autoCleanup: inline !== undefined },
    assert: async (call) => {
      const evaluation = { action: call.action, resources: call.resources, effect: rule as string }
      if (rule !== "deny") await fake.fire.permission("evaluate", evaluation)
      if (evaluation.effect === "ask") prompts.push(`${call.action} ${call.resources.join(",")}`)
      if (evaluation.effect === "deny") throw new Error(`${call.action} denied`)
    },
  })
  const context = fake.context as unknown as { location: unknown }
  context.location = { ...(context.location as object), project: { id: "prj" } }
  await setupDelivery(fake.context, {
    cleanup: { run: matchingVerbs(run) },
    ...(inline === undefined
      ? {}
      : {
          inlineCleanup: async (_params, _cwd, deps) => {
            inlineRan = true
            await inline(deps as CleanupDeps)
            return { ok: false, reason: "stopped after authorize" }
          },
        }),
  })
  const execute = fake.tools.get("delivery_land")?.execute as (i: unknown, c: unknown) => Promise<{ output: { ok: boolean } }>
  const outcome = await execute({ ...input, ...worktree }, { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal }).then(
    (result) => (result.output.ok ? "landed" : "refused"),
    (error: Error) => error.message,
  )
  return { prompts, outcome, inlineRan, merged: calls.some((call) => call.argv[1] === "pr" && call.argv[2] === "merge") }
}

describe("delivery_land permission", () => {
  test("a gated land with an approval from a user with write access asks nothing and merges", async () => {
    expect(await land("allow", GATED, forge())).toEqual({ prompts: [], outcome: "landed", inlineRan: false, merged: true })
  })

  test.each([
    ["requireApproval", { ...GATED, requireApproval: undefined }],
    ["requireGreenChecks", { ...GATED, requireGreenChecks: undefined }],
  ])("a land without %s still asks", async (_name, input) => {
    const { prompts } = await land("allow", input, forge())
    expect(prompts).toEqual(["delivery_land srobroek/omp-plugins#470"])
  })

  test("an approval from a user without write access keeps the prompt, and the merge still proceeds once confirmed", async () => {
    const answers = forge({ permission: completed(JSON.stringify({ permission: "read", role_name: "read" })) })
    expect(await land("allow", GATED, answers)).toEqual({ prompts: ["delivery_land srobroek/omp-plugins#470"], outcome: "landed", inlineRan: false, merged: true })
  })

  test("a configured deny still wins for a fully gated land and nothing is merged", async () => {
    expect(await land("deny", GATED, forge())).toEqual({ prompts: [], outcome: "delivery_land denied", inlineRan: false, merged: false })
  })
})

describe("the cleanup a land runs inline", () => {
  const request = (receiptBound: boolean) => ({ worktree: "/w/a", branch: "b", pr: 470, receiptBound })
  const inline = (receiptBound: boolean) => async (deps: CleanupDeps) => deps.authorize?.(request(receiptBound))

  test("asks nothing when it acts on the receipt it just wrote", async () => {
    const result = await land("allow", GATED, forge(), inline(true))
    expect(result.inlineRan).toBe(true)
    expect(result.prompts).toEqual([])
  })

  test("asks when the worktree is not bound to the receipt", async () => {
    expect((await land("allow", GATED, forge(), inline(false))).prompts).toEqual(["delivery_cleanup /w/a"])
  })
})
