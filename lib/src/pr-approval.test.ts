import { describe, expect, test } from "bun:test"
import { approversAt, changesRequested, commitChecks, githubApproval, requiredContexts, reviewApproval, usesMergeQueue } from "./pr-approval.ts"

const SHA = "a".repeat(40)
const OLD = "b".repeat(40)

const review = (user: string, state: string, commit = SHA) => ({ user: { login: user }, state, commit_id: commit })

describe("reviewApproval (strict, review-only)", () => {
  const eligible = (who: string) => who === "writer"

  test("only an eligible approver counts", () => {
    expect(reviewApproval([review("drive-by", "APPROVED")], "bot", SHA, { eligible }).ok).toBe(false)
    expect(reviewApproval([review("drive-by", "APPROVED"), review("writer", "APPROVED")], "bot", SHA, { eligible }).ok).toBe(true)
  })

  test("anyone's changes request vetoes an eligible approval, eligible or not", () => {
    expect(reviewApproval([review("writer", "APPROVED"), review("anyone", "CHANGES_REQUESTED")], "bot", SHA, { eligible }).ok).toBe(false)
  })

  test("approversAt lists the non-author reviewers whose latest decisive review approves the sha", () => {
    const reviews = [review("a", "APPROVED"), review("B", "APPROVED"), review("c", "APPROVED", OLD), review("d", "APPROVED"), review("d", "DISMISSED"), review("bot", "APPROVED")]
    expect(approversAt(reviews, "bot", SHA)).toEqual(["a", "b"])
    expect(approversAt({ message: "Not Found" }, "bot", SHA)).toBeUndefined()
  })

  test("changesRequested lists everyone whose latest decisive review requests changes", () => {
    expect(changesRequested([review("a", "CHANGES_REQUESTED"), review("b", "CHANGES_REQUESTED"), review("b", "APPROVED")])).toEqual(["a"])
  })

  test.each([
    ["an approval of the sha by someone else", [review("rev", "APPROVED")], "bot", true],
    ["an approval spread over pages", [[review("x", "COMMENTED")], [review("rev", "APPROVED")]], "bot", true],
    ["a login that differs from the author only in case is still the author", [review("BOT", "APPROVED")], "bot", false],
    ["the PR author approving", [review("bot", "APPROVED")], "bot", false],
    ["an approval of an older commit", [review("rev", "APPROVED", OLD)], "bot", false],
    ["no reviews", [], "bot", false],
    ["only comments", [review("rev", "COMMENTED")], "bot", false],
    ["an approval later dismissed", [review("rev", "APPROVED"), review("rev", "DISMISSED")], "bot", false],
    ["an approval then changes requested by the same reviewer", [review("rev", "APPROVED"), review("rev", "CHANGES_REQUESTED")], "bot", false],
    ["an approval while another reviewer still requests changes", [review("rev", "APPROVED"), review("other", "CHANGES_REQUESTED")], "bot", false],
    ["changes requested then approved by the same reviewer", [review("rev", "CHANGES_REQUESTED"), review("rev", "APPROVED")], "bot", true],
    ["an unknown author", [review("rev", "APPROVED")], null, false],
  ])("%s", (_name, reviews, author, ok) => {
    expect(reviewApproval(reviews, author, SHA).ok).toBe(ok)
  })

  test("an unreadable payload refuses", () => {
    expect(reviewApproval({ message: "Not Found" }, "bot", SHA).ok).toBe(false)
  })
})

describe("githubApproval comment verdicts are an option", () => {
  const payload = {
    author: { login: "bot" },
    reviews: [],
    comments: [{ author: { login: "bot" }, body: `VERDICT: APPROVE\n${SHA}` }],
  }
  test("on: the author's verdict comment naming the head approves", () => {
    expect(githubApproval(payload, SHA, { commentVerdict: true }).ok).toBe(true)
  })
  test("off: the same comment does not", () => {
    expect(githubApproval(payload, SHA, { commentVerdict: false }).ok).toBe(false)
  })
})

describe("commitChecks", () => {
  const run = (name: string, conclusion: string | null, status = "completed") => ({ name, status, conclusion })
  const runs = (...items: unknown[]) => [{ total_count: items.length, check_runs: items }]
  const status = (...items: { context: string; state: string }[]) => ({ state: "success", statuses: items })
  const check = (over: Partial<Parameters<typeof commitChecks>[0]> = {}) => commitChecks({ runs: runs(run("ci", "success")), status: status(), required: undefined, ...over })

  test.each([
    ["success, neutral and skipped runs", { runs: runs(run("a", "success"), run("b", "neutral"), run("c", "skipped")) }, true],
    ["a green status alone", { runs: runs(), status: status({ context: "legacy", state: "success" }) }, true],
    ["a failed run", { runs: runs(run("a", "success"), run("b", "failure")) }, false],
    ["a cancelled run", { runs: runs(run("a", "cancelled")) }, false],
    ["a run still in progress", { runs: runs(run("a", null, "in_progress")) }, false],
    ["a pending status", { status: status({ context: "legacy", state: "pending" }) }, false],
    ["a failed status next to green runs", { status: status({ context: "legacy", state: "failure" }) }, false],
    ["nothing at all", { runs: runs(), status: status() }, false],
    ["unreadable runs", { runs: { message: "boom" } }, false],
    ["unreadable status", { status: undefined }, false],
  ])("%s", (_name, over, ok) => {
    expect(check(over as never).ok).toBe(ok)
  })

  test("a required context that never ran refuses even though everything present is green", () => {
    expect(check({ required: ["ci", "deploy-check"] })).toMatchObject({ ok: false, reason: expect.stringContaining("deploy-check") })
  })
  test("a required context that is green passes, whether a run or a status", () => {
    expect(check({ status: status({ context: "legacy", state: "success" }), required: ["ci", "legacy"] }).ok).toBe(true)
  })
  test("unreadable requirements fall back to the all-green rule", () => {
    expect(check({ required: undefined }).ok).toBe(true)
  })
})

describe("requiredContexts", () => {
  test("reads branch protection contexts and checks, and ruleset checks, de-duplicated", () => {
    const protection = { contexts: ["ci"], checks: [{ context: "lint", app_id: 1 }] }
    const rules = [[{ type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }, { context: "e2e" }] } }]]
    expect(requiredContexts(protection, rules)).toEqual(["ci", "e2e", "lint"])
  })
  test("readable and empty is an empty requirement, not an unknown one", () => {
    expect(requiredContexts({ contexts: [] }, undefined)).toEqual([])
  })
  test("both unreadable is unknown", () => {
    expect(requiredContexts(undefined, undefined)).toBeUndefined()
  })
})

describe("strict reads fail closed", () => {
  test("requiredContexts with requireBoth is unknown when only one source was read", () => {
    expect(requiredContexts({ contexts: ["ci"] }, undefined, { requireBoth: true })).toBeUndefined()
    expect(requiredContexts(undefined, [[]], { requireBoth: true })).toBeUndefined()
  })
  test("requiredContexts with requireBoth reads when both sources were read", () => {
    expect(requiredContexts({ contexts: ["ci"] }, [[]], { requireBoth: true })).toEqual(["ci"])
  })
  test("requiredContexts without the option keeps reading one source", () => {
    expect(requiredContexts({ contexts: ["ci"] }, undefined)).toEqual(["ci"])
  })
  test("an unparseable rules payload is unreadable under requireBoth", () => {
    expect(requiredContexts({ contexts: [] }, { message: "Not Found" }, { requireBoth: true })).toBeUndefined()
  })
  test("commitChecks with requireKnown refuses when the required contexts are unknown", () => {
    const green = { runs: [{ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }], status: { statuses: [] } }
    expect(commitChecks({ ...green, required: undefined, requireKnown: true })).toMatchObject({ ok: false, reason: expect.stringContaining("unreadable") })
    expect(commitChecks({ ...green, required: [], requireKnown: true }).ok).toBe(true)
    expect(commitChecks({ ...green, required: undefined }).ok).toBe(true)
  })
  test.each([
    ["a merge_queue rule", [[{ type: "pull_request" }, { type: "merge_queue", parameters: {} }]], true],
    ["no merge_queue rule", [[{ type: "pull_request" }]], false],
    ["no rules", [[]], false],
    ["unreadable rules", undefined, false],
  ])("usesMergeQueue: %s", (_name, rules, expected) => {
    expect(usesMergeQueue(rules)).toBe(expected)
  })
})
