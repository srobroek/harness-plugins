/**
 * The exact-head approval and green-check preconditions `delivery_land` applies when
 * asked (`requireApproval`, `requireGreenChecks`), so the shepherd's checks hold
 * whoever calls the tool.
 *
 * Both are read from the forge, never from a caller's claim, and both are bound to the
 * head the merge will be bound to. A read that fails, or a payload this module cannot
 * read, refuses: an unknown approval is not an approval.
 */

import {
  approversAt,
  changesRequested,
  commitChecks,
  githubChecks,
  login,
  pages,
  own,
  type Precondition,
  githubApproval as sharedApproval,
  reviewApproval,
  str,
} from "@srobroek/opencode-lib/pr-approval"
import type { CliResult, CliRunner } from "./forge-adapter.ts"

export { githubChecks, type Precondition }


type Bound = {
  forge: "github" | "gitlab"
  /** `HOST/PATH`, the `--repo` every forge command is given. */
  cliRepo: string
  /** The GitLab project path, for `glab api`. */
  nameWithOwner: string
  forgeHost: string
  /** The base branch the merge targets: its protection decides whether the forge enforces review. */
  base: string
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

/** The identities a GitHub approval trust decision rests on, each read from the forge. */
export type GithubIdentity = {
  /** The authenticated account (`gh api user`), or null when it could not be read. */
  viewer: string | null
  /** The repository role of each approving login (lower-case), or null when it could not be read. */
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

export type Trust = { trusted: true; by: string } | { trusted: false; reason: string }

/**
 * Whether the GitHub approval may stand in for a person's confirmation. It is the shared strict
 * review judgment (`reviewApproval`: exact head, not the PR author, and nobody's latest decisive
 * review requests changes), narrowed to approvers with write access; or the same-account case the
 * skill describes (a `VERDICT: APPROVE` comment naming the head, by the authenticated account that
 * is also the PR author), which a changes request vetoes too. Anything not proved is untrusted. Pure.
 *
 * `reviews` is the REST list (`pulls/{n}/reviews`), `view` the `gh pr view --json author,comments` payload.
 */
export function githubTrust(reviews: unknown, view: unknown, head: string, identity: GithubIdentity): Trust {
  const author = login(view)
  const blocking = changesRequested(reviews)
  if (blocking.length > 0) return { trusted: false, reason: `${blocking.join(", ")} requested changes and has not approved since` }
  const strict = reviewApproval(reviews, author, head, {
    eligible: (who) => WRITE_ROLES.has(identity.permissions[who.toLowerCase()] ?? ""),
  })
  if (strict.ok) return { trusted: true, by: String(strict.evidence.reviewer) }
  const comments = own(view, "comments")
  if (author !== null && identity.viewer === author && Array.isArray(comments) && approversAt(reviews, author, head) !== undefined) {
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
export function gitlabTrust(
  approvals: unknown,
  head: string,
  access: Readonly<Record<number, number | null | undefined>>,
  resetOnPush: boolean | null,
): Trust {
  if (own(approvals, "approved") !== true) return { trusted: false, reason: "approval: observed approved false" }
  // An approval that survives pushes says nothing about which commit was approved, whatever sha the MR carries now.
  if (resetOnPush !== true)
    return { trusted: false, reason: "approval: the project does not provably reset approvals on push, so the approval is not bound to the head" }
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

/**
 * Whether the forge itself, and not this client, keeps the merge behind an approval of the pushed
 * head. A prompt-free land rests on a read of the approval taken before the merge, and an approval
 * can be dismissed in between; only a forge that refuses a merge without a current approving review
 * closes that window. `enforced: false` carries why, and keeps the prompt.
 */
export type Enforcement = { enforced: true; via: string } | { enforced: false; reason: string }

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)

/**
 * GitHub: the base branch's rulesets (`rules/branches/<b>`, pages) or classic branch protection
 * (`branches/<b>/protection/required_pull_request_reviews`) require at least one approving review
 * and dismiss stale reviews on push. The two sources are enforced independently by GitHub, so
 * their requirements add up. An unreadable or missing source contributes nothing. Pure.
 */
export function githubReviewEnforcement(rules: unknown, protection: unknown): Enforcement {
  const pullRequestRules = (pages(rules, () => undefined) ?? []).filter((rule) => str(rule, "type") === "pull_request")
  const parameters = pullRequestRules.map((rule) => own(rule, "parameters"))
  const required =
    parameters.some((entry) => count(own(entry, "required_approving_review_count")) >= 1) ||
    count(own(protection, "required_approving_review_count")) >= 1
  const dismisses =
    parameters.some((entry) => own(entry, "dismiss_stale_reviews_on_push") === true) || own(protection, "dismiss_stale_reviews") === true
  if (required && dismisses) return { enforced: true, via: pullRequestRules.length > 0 ? "ruleset" : "branch protection" }
  return {
    enforced: false,
    reason: `the base branch does not provably require an approving review and dismiss stale reviews on push (approving review required: ${required}, stale reviews dismissed: ${dismisses})`,
  }
}

/**
 * GitLab: the merge request's effective approval rules (`merge_requests/<n>/approval_state`, which
 * lists only the rules that apply to this request's target branch) hold at least one mandatory rule
 * (`approvals_required >= 1`), approvals reset on push, and merge requests may not change the
 * approvers. A project rule scoped to another branch therefore never counts. Pure: takes
 * `projects/<id>/approvals` and the approval state, each `undefined` when unreadable.
 */
export function gitlabReviewEnforcement(settings: unknown, state: unknown): Enforcement {
  const rules = own(state, "rules")
  const required = Array.isArray(rules) && rules.some((rule) => count(own(rule, "approvals_required")) >= 1)
  const resets = own(settings, "reset_approvals_on_push") === true
  const locked = own(settings, "disable_overriding_approvers_per_merge_request") === true
  if (required && resets && locked) return { enforced: true, via: "the merge request's approval rules" }
  return {
    enforced: false,
    reason: `the merge request does not provably have an applicable mandatory approval rule, reset approvals on push and lock the approvers (applicable rule requiring an approval: ${required}, reset on push: ${resets}, approvers locked: ${locked})`,
  }
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
    // The strict judgment reads the REST review list (commit ids, and every reviewer's latest decision).
    const reviews = await readJson(run, ["gh", "api", "--paginate", "--slurp", `repos/${bound.nameWithOwner}/pulls/${bound.number}/reviews?per_page=100`, ...host], bound)
    if (!reviews.ok) return { ...result, trusted: { trusted: false, reason: reviews.reason } }
    const viewer = await readJson(run, ["gh", "api", "user", ...host], bound)
    const permissions: Record<string, string | null> = {}
    // Five approvers is more than the gate needs; one trusted approver is enough.
    for (const who of (approversAt(reviews.value, login(payload.value), bound.head) ?? []).slice(0, 5)) {
      const read = await readJson(
        run,
        ["gh", "api", `repos/${bound.nameWithOwner}/collaborators/${encodeURIComponent(who)}/permission`, ...host],
        bound,
      )
      permissions[who] = read.ok && githubPermissionAllows(read.value) ? (str(read.value, "role_name") ?? str(read.value, "permission")) : null
    }
    const trust = githubTrust(reviews.value, payload.value, bound.head, { viewer: viewer.ok ? str(viewer.value, "login") : null, permissions })
    if (!trust.trusted) return { ...result, trusted: trust }
    // The client re-reads are defence in depth. The atomic guarantee is the forge refusing a merge
    // whose approval was dismissed, so a prompt-free land needs the base branch to enforce that.
    const branch = encodeURIComponent(bound.base)
    const rules = await readJson(run, ["gh", "api", "--paginate", "--slurp", `repos/${bound.nameWithOwner}/rules/branches/${branch}?per_page=100`, ...host], bound)
    const protection = await readJson(run, ["gh", "api", `repos/${bound.nameWithOwner}/branches/${branch}/protection/required_pull_request_reviews`, ...host], bound)
    const enforcement = githubReviewEnforcement(rules.ok ? rules.value : undefined, protection.ok ? protection.value : undefined)
    return { ...result, trusted: enforcement.enforced ? trust : { trusted: false, reason: enforcement.reason } }
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
  const settings = await readJson(run, ["glab", "api", `projects/${project}/approvals`, ...host], bound)
  const reset = settings.ok ? own(settings.value, "reset_approvals_on_push") : undefined
  const trust = gitlabTrust(payload.value, bound.head, access, typeof reset === "boolean" ? reset : null)
  if (!trust.trusted) return { ...result, trusted: trust }
  const approvalState = await readJson(run, ["glab", "api", `projects/${project}/merge_requests/${bound.number}/approval_state`, ...host], bound)
  const enforcement = gitlabReviewEnforcement(settings.ok ? settings.value : undefined, approvalState.ok ? approvalState.value : undefined)
  return { ...result, trusted: enforcement.enforced ? trust : { trusted: false, reason: enforcement.reason } }
}

/** Read and judge the checks for the bound head. */
export async function readChecks(run: CliRunner, bound: Bound): Promise<Precondition> {
  if (bound.forge === "github") {
    // By the commit, not the PR: the PR can move to another head between this read and the merge.
    const base = `repos/${bound.nameWithOwner}/commits/${bound.head}`
    const host = ["--hostname", bound.forgeHost]
    const pagesOf = (value: unknown): unknown => (Array.isArray(value) ? value : [value])
    const runs = await readJson(run, ["gh", "api", "--paginate", "--slurp", `${base}/check-runs?per_page=100`, ...host], bound)
    if (!runs.ok) return runs
    const status = await readJson(run, ["gh", "api", "--paginate", "--slurp", `${base}/status?per_page=100`, ...host], bound)
    if (!status.ok) return status
    return commitChecks({ runs: pagesOf(runs.value), status: pagesOf(status.value), required: undefined })
  }
  const project = encodeURIComponent(bound.nameWithOwner)
  const argv = ["glab", "api", `projects/${project}/merge_requests/${bound.number}`, "--hostname", bound.forgeHost]
  const payload = await readJson(run, argv, bound)
  return payload.ok ? gitlabChecks(payload.value, bound.head) : payload
}
