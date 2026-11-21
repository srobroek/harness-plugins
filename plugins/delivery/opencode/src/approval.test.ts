import { describe, expect, test } from "bun:test"
import {
  githubApproval,
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
  const rest = (login: string, state = "APPROVED", commit = HEAD) => ({ user: { login }, state, commit_id: commit })
  const view = (comments: unknown[] = []) => ({ author: { login: "me" }, comments })
  const none = { viewer: null, permissions: {} }

  test("an exact-head APPROVED review counts only from a user with write, maintain or admin", () => {
    for (const role of ["admin", "maintain", "write"])
      expect(githubTrust([rest("you")], view(), HEAD, { viewer: "bot", permissions: { you: role } }).trusted).toBe(true)
    for (const role of ["read", "triage", "none", null])
      expect(githubTrust([rest("you")], view(), HEAD, { viewer: "bot", permissions: { you: role } }).trusted).toBe(false)
  })

  test("a reviewer whose permission was not read does not count", () => {
    expect(githubTrust([rest("you")], view(), HEAD, none).trusted).toBe(false)
  })

  test("one trusted approver is not enough while another reviewer's latest decisive review requests changes", () => {
    const reviews = [rest("you"), rest("other", "CHANGES_REQUESTED")]
    const identity = { viewer: "bot", permissions: { you: "write", other: "write" } }
    const result = githubTrust(reviews, view(), HEAD, identity)
    expect(result.trusted).toBe(false)
    expect(githubTrust([...reviews, rest("other")], view(), HEAD, identity).trusted).toBe(true)
  })

  test("a changes request also vetoes the same-account VERDICT comment", () => {
    const comment = view([{ author: { login: "me" }, body: `VERDICT: APPROVE ${HEAD}` }])
    expect(githubTrust([], comment, HEAD, { viewer: "me", permissions: {} }).trusted).toBe(true)
    expect(githubTrust([rest("other", "CHANGES_REQUESTED")], comment, HEAD, { viewer: "me", permissions: {} }).trusted).toBe(false)
  })

  test("a reviewer's later non-approving decisive review withdraws the approval, and the author's own review never counts", () => {
    const identity = { viewer: null, permissions: { you: "write", me: "admin" } }
    expect(githubTrust([rest("you"), rest("you", "DISMISSED")], view(), HEAD, identity).trusted).toBe(false)
    expect(githubTrust([rest("me")], view(), HEAD, identity).trusted).toBe(false)
  })

  test("an unreadable review list is untrusted", () => {
    expect(githubTrust({ message: "Not Found" }, view(), HEAD, { viewer: "me", permissions: {} }).trusted).toBe(false)
  })

  test("a VERDICT comment counts only when its author is the authenticated account and the PR author", () => {
    const comment = (login: string) => view([{ author: { login }, body: `VERDICT: APPROVE ${HEAD}` }])
    expect(githubTrust([], comment("me"), HEAD, { viewer: "me", permissions: {} }).trusted).toBe(true)
    expect(githubTrust([], comment("me"), HEAD, { viewer: "other", permissions: {} }).trusted).toBe(false)
    expect(githubTrust([], comment("me"), HEAD, none).trusted).toBe(false)
    expect(githubTrust([], comment("someone"), HEAD, { viewer: "someone", permissions: {} }).trusted).toBe(false)
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
