/**
 * The exact-head approval and green-check preconditions `delivery_land` applies when
 * asked (`requireApproval`, `requireGreenChecks`), so the shepherd's checks hold
 * whoever calls the tool.
 *
 * Both are read from the forge, never from a caller's claim, and both are bound to the
 * head the merge will be bound to. A read that fails, or a payload this module cannot
 * read, refuses: an unknown approval is not an approval.
 */

import { githubChecks, login, own, type Precondition, githubApproval as sharedApproval, str } from "@srobroek/opencode-lib/pr-approval"
import type { CliResult, CliRunner } from "./forge-adapter.ts"

export { githubChecks, type Precondition }


type Bound = {
  forge: "github" | "gitlab"
  /** `HOST/PATH`, the `--repo` every forge command is given. */
  cliRepo: string
  /** The GitLab project path, for `glab api`. */
  nameWithOwner: string
  forgeHost: string
  number: string
  /** The lower-case whole head oid the merge is bound to. */
  head: string
  env: Readonly<Record<string, string>>
  timeoutMs: number
}

type Parsed = { ok: true; value: unknown } | { ok: false; reason: string }

function parse(argv: readonly string[], result: CliResult, allowExit = false): Parsed {
  const label = argv.join(" ")
  if (!result.ok || result.error !== undefined)
    return { ok: false, reason: `${label}: observed ${result.error ?? "no completion"}, expected exit 0` }
  if (!allowExit && result.exitCode !== 0) {
    const stderr = result.stderr.trim()
    return {
      ok: false,
      reason: `${label}: observed exit ${result.exitCode}, expected exit 0${stderr === "" ? "" : `; stderr: ${stderr.slice(0, 400)}`}`,
    }
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) }
  } catch {
    return { ok: false, reason: `${label}: observed unparseable output (exit ${result.exitCode}), expected JSON` }
  }
}

/** GitHub approval for exactly `head`: an `APPROVED` review of it, or the author's `VERDICT: APPROVE` comment naming it (GitHub refuses a self-approval). */
export const githubApproval = (payload: unknown, head: string): Precondition => sharedApproval(payload, head, { commentVerdict: true })

/**
 * GitHub checks for the head commit, read by its immutable sha and not through the PR: every
 * check run completed as success, neutral or skipped, the combined status is success when
 * there are statuses, and at least one run or status exists. A list the API truncated refuses.
 * Pure: takes `commits/<sha>/check-runs` and `commits/<sha>/status`.
 */
export function githubHeadChecks(checkRuns: unknown, status: unknown): Precondition {
  const runs = own(checkRuns, "check_runs")
  const total = own(checkRuns, "total_count")
  const statusTotal = own(status, "total_count")
  if (!Array.isArray(runs) || typeof total !== "number" || typeof statusTotal !== "number")
    return { ok: false, reason: "checks: observed no check-run or status payload, expected commits/<sha>/check-runs and /status output" }
  if (total > runs.length)
    return { ok: false, reason: `checks: observed ${runs.length} of ${total} check runs, expected the whole list` }
  const bad = runs.filter(
    (run) => str(run, "status") !== "completed" || !["success", "neutral", "skipped"].includes(str(run, "conclusion") ?? ""),
  )
  if (bad.length > 0) {
    const listed = bad.slice(0, 8).map((run) => `${str(run, "name") ?? "?"}=${str(run, "conclusion") ?? str(run, "status") ?? "?"}`)
    return { ok: false, reason: `checks: observed ${listed.join(", ")}, expected every check to pass` }
  }
  if (statusTotal > 0 && str(status, "state") !== "success")
    return { ok: false, reason: `checks: observed combined status ${JSON.stringify(str(status, "state"))}, expected "success"` }
  if (runs.length === 0 && statusTotal === 0)
    return { ok: false, reason: "checks: observed no checks, expected at least one passing check for the head" }
  return { ok: true, evidence: { checks: runs.length, statuses: statusTotal } }
}

/** The identities a GitHub approval trust decision rests on, each read from the forge. */
export type GithubIdentity = {
  /** The authenticated account (`gh api user`), or null when it could not be read. */
  viewer: string | null
  /** The repository role of each approving login, or null when it could not be read. */
  permissions: Readonly<Record<string, string | null | undefined>>
}

const WRITE_ROLES = new Set(["admin", "maintain", "write"])

/** Whether a `collaborators/<user>/permission` payload grants write, maintain or admin. Pure. */
export function githubPermissionAllows(payload: unknown): boolean {
  const role = str(payload, "role_name")
  if (role !== null) return WRITE_ROLES.has(role)
  const permission = str(payload, "permission")
  return permission === "admin" || permission === "write"
}

/** Logins (not the PR author) whose latest review is an APPROVED one for exactly `head`. Pure. */
export function githubApprovers(payload: unknown, head: string): string[] {
  const author = login(payload)
  const reviews = own(payload, "reviews")
  if (!Array.isArray(reviews)) return []
  const latest = new Map<string, unknown>()
  for (const review of reviews) {
    const who = login(review)
    const state = str(review, "state")
    // A comment-only review leaves the reviewer's verdict unchanged.
    if (who !== null && state !== null && state !== "COMMENTED" && state !== "PENDING") latest.set(who, review)
  }
  return [...latest]
    .filter(([who, review]) => who !== author && str(review, "state") === "APPROVED")
    .filter(([, review]) => str(own(review, "commit"), "oid")?.trim().toLowerCase() === head)
    .map(([who]) => who)
}

export type Trust = { trusted: true; by: string } | { trusted: false; reason: string }

/**
 * Whether the GitHub approval may stand in for a person's confirmation: an exact-head
 * approving review from a user with write access, or the same-account case the skill describes
 * (a `VERDICT: APPROVE` comment naming the head, by the authenticated account that is also the
 * PR author). Anything not proved is untrusted. Pure.
 */
export function githubTrust(payload: unknown, head: string, identity: GithubIdentity): Trust {
  for (const who of githubApprovers(payload, head)) {
    const role = identity.permissions[who]
    if (typeof role === "string" && WRITE_ROLES.has(role)) return { trusted: true, by: who }
  }
  const author = login(payload)
  const comments = own(payload, "comments")
  if (author !== null && identity.viewer === author && Array.isArray(comments)) {
    for (const comment of comments) {
      if (login(comment) !== author) continue
      const body = str(comment, "body") ?? ""
      const first = body.split(/\r?\n/, 1)[0]?.trim() ?? ""
      if (/^VERDICT:\s*APPROVE\b/.test(first) && body.toLowerCase().includes(head)) return { trusted: true, by: author }
    }
  }
  return {
    trusted: false,
    reason: "no exact-head approval from a user with write access, and no author VERDICT comment from the authenticated account",
  }
}

/**
 * GitLab approval: the approvals endpoint reports `approved: true` and the merge
 * request's `sha` is the head. GitLab does not bind an approval to a commit; a project
 * that keeps approvals across pushes can therefore pass this with an older review.
 */
export function gitlabApproval(approvals: unknown, head: string): Precondition {
  const sha = str(approvals, "sha")?.trim().toLowerCase()
  if (own(approvals, "approved") !== true)
    return { ok: false, reason: "approval: observed approved false, expected an approved merge request" }
  if (sha !== undefined && sha !== head)
    return { ok: false, reason: `approval: observed sha ${sha}, expected head ${head}` }
  const by = own(approvals, "approved_by")
  const names = Array.isArray(by) ? by.map((entry) => str(own(entry, "user"), "username")).filter(Boolean) : []
  return { ok: true, evidence: { kind: "gitlab-approvals", approvedBy: names } }
}

/**
 * Whether the GitLab approval may stand in for a person's confirmation: the approvals payload
 * carries the head sha (an approval without one may survive pushes) and an approver holds
 * Developer access or above. `access` maps user id to access level. Pure.
 */
export function gitlabTrust(approvals: unknown, head: string, access: Readonly<Record<number, number | null | undefined>>): Trust {
  if (own(approvals, "approved") !== true) return { trusted: false, reason: "approval: observed approved false" }
  const sha = str(approvals, "sha")?.trim().toLowerCase()
  if (sha !== head) return { trusted: false, reason: `approval: observed sha ${sha ?? "none"}, expected an approval bound to head ${head}` }
  const by = own(approvals, "approved_by")
  if (Array.isArray(by)) {
    for (const entry of by) {
      const user = own(entry, "user")
      const id = own(user, "id")
      const level = typeof id === "number" ? access[id] : undefined
      if (typeof id === "number" && typeof level === "number" && level >= 30) return { trusted: true, by: str(user, "username") ?? String(id) }
    }
  }
  return { trusted: false, reason: "approval: observed no approver with Developer access or above" }
}

/** GitLab checks: the head pipeline succeeded and ran on the head. Pure: takes the merge request payload. */
export function gitlabChecks(mr: unknown, head: string): Precondition {
  const pipeline = own(mr, "head_pipeline")
  const status = str(pipeline, "status")
  const sha = str(pipeline, "sha")?.trim().toLowerCase()
  if (status !== "success")
    return { ok: false, reason: `checks: observed head pipeline status ${JSON.stringify(status)}, expected "success"` }
  if (sha !== head)
    return { ok: false, reason: `checks: observed head pipeline sha ${JSON.stringify(sha ?? null)}, expected ${head}` }
  return { ok: true, evidence: { pipeline: own(pipeline, "id") ?? null } }
}

/** The approval gate's verdict beside its evidence: `trusted` says whether it may replace a prompt. */
export type ApprovalRead = Precondition & { trusted?: Trust }

async function readJson(run: CliRunner, argv: string[], bound: Bound): Promise<Parsed> {
  return parse(argv, await run(argv, { timeoutMs: bound.timeoutMs, env: bound.env }))
}

/** Read and judge the approval artifact for the bound head, and who stands behind it. */
export async function readApproval(run: CliRunner, bound: Bound): Promise<ApprovalRead> {
  if (bound.forge === "github") {
    const argv = ["gh", "pr", "view", bound.number, "--repo", bound.cliRepo, "--json", "author,reviews,comments"]
    const payload = await readJson(run, argv, bound)
    if (!payload.ok) return payload
    const result = githubApproval(payload.value, bound.head)
    if (!result.ok) return result
    const host = ["--hostname", bound.forgeHost]
    const viewer = await readJson(run, ["gh", "api", "user", ...host], bound)
    const permissions: Record<string, string | null> = {}
    // Five approvers is more than the gate needs; one trusted approver is enough.
    for (const who of githubApprovers(payload.value, bound.head).slice(0, 5)) {
      const read = await readJson(
        run,
        ["gh", "api", `repos/${bound.nameWithOwner}/collaborators/${encodeURIComponent(who)}/permission`, ...host],
        bound,
      )
      permissions[who] = read.ok && githubPermissionAllows(read.value) ? (str(read.value, "role_name") ?? str(read.value, "permission")) : null
    }
    const trust = githubTrust(payload.value, bound.head, { viewer: viewer.ok ? str(viewer.value, "login") : null, permissions })
    return { ...result, trusted: trust }
  }
  const project = encodeURIComponent(bound.nameWithOwner)
  const host = ["--hostname", bound.forgeHost]
  const payload = await readJson(run, ["glab", "api", `projects/${project}/merge_requests/${bound.number}/approvals`, ...host], bound)
  if (!payload.ok) return payload
  const result = gitlabApproval(payload.value, bound.head)
  if (!result.ok) return result
  const access: Record<number, number | null> = {}
  const by = own(payload.value, "approved_by")
  for (const entry of Array.isArray(by) ? by.slice(0, 5) : []) {
    const id = own(own(entry, "user"), "id")
    if (typeof id !== "number") continue
    const read = await readJson(run, ["glab", "api", `projects/${project}/members/all/${id}`, ...host], bound)
    const level = read.ok ? own(read.value, "access_level") : null
    access[id] = typeof level === "number" ? level : null
  }
  return { ...result, trusted: gitlabTrust(payload.value, bound.head, access) }
}

/** Read and judge the checks for the bound head. */
export async function readChecks(run: CliRunner, bound: Bound): Promise<Precondition> {
  if (bound.forge === "github") {
    // By the commit, not the PR: the PR can move to another head between this read and the merge.
    const base = `repos/${bound.nameWithOwner}/commits/${bound.head}`
    const host = ["--hostname", bound.forgeHost]
    const runs = await readJson(run, ["gh", "api", `${base}/check-runs?per_page=100`, ...host], bound)
    if (!runs.ok) return runs
    const status = await readJson(run, ["gh", "api", `${base}/status?per_page=100`, ...host], bound)
    if (!status.ok) return status
    return githubHeadChecks(runs.value, status.value)
  }
  const project = encodeURIComponent(bound.nameWithOwner)
  const argv = ["glab", "api", `projects/${project}/merge_requests/${bound.number}`, "--hostname", bound.forgeHost]
  const payload = await readJson(run, argv, bound)
  return payload.ok ? gitlabChecks(payload.value, bound.head) : payload
}
