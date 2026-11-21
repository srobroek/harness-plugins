import { describe, expect, test } from "bun:test"
import {
  githubApproval,
  githubHeadChecks,
  githubPermissionAllows,
  githubTrust,
  gitlabApproval,
  gitlabChecks,
  gitlabTrust,
} from "./approval.ts"

const HEAD = "0123456789abcdef0123456789abcdef01234567"
const OLD = "1111111111111111111111111111111111111111"

describe("githubApproval", () => {
  test("an APPROVED review for the exact head approves", () => {
    const payload = {
      author: { login: "me" },
      reviews: [{ state: "APPROVED", author: { login: "you" }, commit: { oid: HEAD.toUpperCase() } }],
      comments: [],
    }
    expect(githubApproval(payload, HEAD)).toEqual({
      ok: true,
      evidence: { kind: "review", reviewer: "you", commit: HEAD },
    })
  })

  test("an APPROVED review for another head does not", () => {
    const payload = { author: { login: "me" }, reviews: [{ state: "APPROVED", commit: { oid: OLD } }], comments: [] }
    const result = githubApproval(payload, HEAD)
    expect(result.ok).toBe(false)
  })

  test("a VERDICT comment counts only from the author's own account and only naming the head", () => {
    const comment = (login: string, body: string) => ({
      author: { login: "me" },
      reviews: [],
      comments: [{ author: { login }, body }],
    })
    expect(githubApproval(comment("me", `VERDICT: APPROVE — reviewed ${HEAD}`), HEAD).ok).toBe(true)
    expect(githubApproval(comment("someone", `VERDICT: APPROVE ${HEAD}`), HEAD).ok).toBe(false)
    expect(githubApproval(comment("me", `VERDICT: APPROVE ${OLD}`), HEAD).ok).toBe(false)
    expect(githubApproval(comment("me", `looks fine\nVERDICT: APPROVE ${HEAD}`), HEAD).ok).toBe(false)
    expect(githubApproval(comment("me", `VERDICT: REQUEST-CHANGES ${HEAD}`), HEAD).ok).toBe(false)
  })

  test("a payload without the arrays refuses", () => {
    expect(githubApproval({}, HEAD).ok).toBe(false)
    expect(githubApproval(null, HEAD).ok).toBe(false)
  })
})

describe("gitlab", () => {
  test("approvals need approved true at the head", () => {
    expect(gitlabApproval({ approved: true, sha: HEAD, approved_by: [{ user: { username: "you" } }] }, HEAD)).toEqual({
      ok: true,
      evidence: { kind: "gitlab-approvals", approvedBy: ["you"] },
    })
    expect(gitlabApproval({ approved: false, sha: HEAD }, HEAD).ok).toBe(false)
    expect(gitlabApproval({ approved: true, sha: OLD }, HEAD).ok).toBe(false)
  })

  test("checks need a successful head pipeline on the head", () => {
    expect(gitlabChecks({ head_pipeline: { id: 7, status: "success", sha: HEAD } }, HEAD)).toEqual({
      ok: true,
      evidence: { pipeline: 7 },
    })
    expect(gitlabChecks({ head_pipeline: { status: "running", sha: HEAD } }, HEAD).ok).toBe(false)
    expect(gitlabChecks({ head_pipeline: { status: "success", sha: OLD } }, HEAD).ok).toBe(false)
    expect(gitlabChecks({}, HEAD).ok).toBe(false)
  })
})

describe("githubTrust", () => {
  const review = (login: string, state = "APPROVED", oid = HEAD) => ({ state, author: { login }, commit: { oid } })
  const payload = (reviews: unknown[], comments: unknown[] = []) => ({ author: { login: "me" }, reviews, comments })
  const none = { viewer: null, permissions: {} }

  test("an exact-head APPROVED review counts only from a user with write, maintain or admin", () => {
    for (const role of ["admin", "maintain", "write"])
      expect(githubTrust(payload([review("you")]), HEAD, { viewer: "bot", permissions: { you: role } }).trusted).toBe(true)
    for (const role of ["read", "triage", "none", null])
      expect(githubTrust(payload([review("you")]), HEAD, { viewer: "bot", permissions: { you: role } }).trusted).toBe(false)
  })

  test("a reviewer whose permission was not read does not count", () => {
    expect(githubTrust(payload([review("you")]), HEAD, none).trusted).toBe(false)
  })

  test("a reviewer's later non-approving review withdraws the approval", () => {
    const reviews = [review("you"), review("you", "CHANGES_REQUESTED")]
    expect(githubTrust(payload(reviews), HEAD, { viewer: null, permissions: { you: "write" } }).trusted).toBe(false)
  })

  test("the author's own review does not count", () => {
    expect(githubTrust(payload([review("me")]), HEAD, { viewer: null, permissions: { me: "admin" } }).trusted).toBe(false)
  })

  test("a VERDICT comment counts only when its author is the authenticated account and the PR author", () => {
    const comment = (login: string) => payload([], [{ author: { login }, body: `VERDICT: APPROVE ${HEAD}` }])
    expect(githubTrust(comment("me"), HEAD, { viewer: "me", permissions: {} }).trusted).toBe(true)
    expect(githubTrust(comment("me"), HEAD, { viewer: "other", permissions: {} }).trusted).toBe(false)
    expect(githubTrust(comment("me"), HEAD, none).trusted).toBe(false)
    expect(githubTrust(comment("someone"), HEAD, { viewer: "someone", permissions: {} }).trusted).toBe(false)
  })
})

describe("githubPermissionAllows", () => {
  test.each([
    [{ permission: "admin", role_name: "admin" }, true],
    [{ permission: "write", role_name: "maintain" }, true],
    [{ permission: "write", role_name: "write" }, true],
    [{ permission: "read", role_name: "triage" }, false],
    [{ permission: "write", role_name: "triage" }, false],
    [{ permission: "write" }, true],
    [{ permission: "read" }, false],
    [{}, false],
    [null, false],
  ])("%j -> %p", (payload, expected) => {
    expect(githubPermissionAllows(payload)).toBe(expected)
  })
})

describe("gitlabTrust", () => {
  const approvals = (sha?: string) => ({ approved: true, ...(sha === undefined ? {} : { sha }), approved_by: [{ user: { id: 5, username: "you" } }] })
  test("needs a head-bound approval, a project that resets approvals on push, and an approver of Developer level or above", () => {
    expect(gitlabTrust(approvals(HEAD), HEAD, { 5: 30 }, true).trusted).toBe(true)
    expect(gitlabTrust(approvals(HEAD), HEAD, { 5: 40 }, true).trusted).toBe(true)
    expect(gitlabTrust(approvals(HEAD), HEAD, { 5: 20 }, true).trusted).toBe(false)
    expect(gitlabTrust(approvals(HEAD), HEAD, {}, true).trusted).toBe(false)
  })
  test("approvals that survive pushes, or whose setting cannot be read, do not prove the approved commit", () => {
    expect(gitlabTrust(approvals(HEAD), HEAD, { 5: 40 }, false).trusted).toBe(false)
    expect(gitlabTrust(approvals(HEAD), HEAD, { 5: 40 }, null).trusted).toBe(false)
  })
  test("an approval without a sha is not bound to the head", () => {
    expect(gitlabTrust(approvals(), HEAD, { 5: 40 }, true).trusted).toBe(false)
    expect(gitlabTrust(approvals(OLD), HEAD, { 5: 40 }, true).trusted).toBe(false)
  })
})

describe("githubHeadChecks", () => {
  const run = (conclusion: string | null, status = "completed") => ({ name: "ci", status, conclusion })
  const runs = (check_runs: unknown[], total = check_runs.length) => ({ total_count: total, check_runs })
  const statuses = (state: string, total = 1) => ({ state, total_count: total })

  test("check runs that completed with success, neutral or skipped, and no failing status, are green", () => {
    expect(githubHeadChecks(runs([run("success"), run("skipped"), run("neutral")]), statuses("pending", 0))).toEqual({ ok: true, evidence: { checks: 3, statuses: 0 } })
    expect(githubHeadChecks(runs([]), statuses("success"))).toEqual({ ok: true, evidence: { checks: 0, statuses: 1 } })
  })

  test.each([
    ["a failed run", runs([run("failure")]), statuses("success", 0)],
    ["an unfinished run", runs([run(null, "in_progress")]), statuses("success", 0)],
    ["a cancelled run", runs([run("cancelled")]), statuses("success", 0)],
    ["a failing status", runs([run("success")]), statuses("failure")],
    ["a pending status", runs([run("success")]), statuses("pending")],
    ["no checks and no statuses", runs([]), statuses("pending", 0)],
    ["a truncated run list", runs([run("success")], 150), statuses("success", 0)],
  ])("%s refuses", (_name, checkRuns, status) => {
    expect(githubHeadChecks(checkRuns, status).ok).toBe(false)
  })

  test("unreadable payloads refuse", () => {
    expect(githubHeadChecks(null, null).ok).toBe(false)
    expect(githubHeadChecks({}, {}).ok).toBe(false)
  })
})
