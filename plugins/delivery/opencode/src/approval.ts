/**
 * The exact-head approval and green-check preconditions `delivery_land` applies when
 * asked (`requireApproval`, `requireGreenChecks`), so the shepherd's checks hold
 * whoever calls the tool.
 *
 * Both are read from the forge, never from a caller's claim, and both are bound to the
 * head the merge will be bound to. A read that fails, or a payload this module cannot
 * read, refuses: an unknown approval is not an approval.
 */

import { githubChecks, own, type Precondition, githubApproval as sharedApproval, str } from "@srobroek/opencode-lib/pr-approval"
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

/** Read and judge the approval artifact for the bound head. */
export async function readApproval(run: CliRunner, bound: Bound): Promise<Precondition> {
  if (bound.forge === "github") {
    const argv = ["gh", "pr", "view", bound.number, "--repo", bound.cliRepo, "--json", "author,reviews,comments"]
    const payload = parse(argv, await run(argv, { timeoutMs: bound.timeoutMs, env: bound.env }))
    return payload.ok ? githubApproval(payload.value, bound.head) : payload
  }
  const project = encodeURIComponent(bound.nameWithOwner)
  const argv = [
    "glab",
    "api",
    `projects/${project}/merge_requests/${bound.number}/approvals`,
    "--hostname",
    bound.forgeHost,
  ]
  const payload = parse(argv, await run(argv, { timeoutMs: bound.timeoutMs, env: bound.env }))
  return payload.ok ? gitlabApproval(payload.value, bound.head) : payload
}

/** Read and judge the checks for the bound head. */
export async function readChecks(run: CliRunner, bound: Bound): Promise<Precondition> {
  if (bound.forge === "github") {
    const argv = ["gh", "pr", "checks", bound.number, "--repo", bound.cliRepo, "--json", "name,state,bucket"]
    // `gh pr checks` exits non-zero for failing or pending checks and still prints the list.
    const payload = parse(argv, await run(argv, { timeoutMs: bound.timeoutMs, env: bound.env }), true)
    return payload.ok ? githubChecks(payload.value) : payload
  }
  const project = encodeURIComponent(bound.nameWithOwner)
  const argv = ["glab", "api", `projects/${project}/merge_requests/${bound.number}`, "--hostname", bound.forgeHost]
  const payload = parse(argv, await run(argv, { timeoutMs: bound.timeoutMs, env: bound.env }))
  return payload.ok ? gitlabChecks(payload.value, bound.head) : payload
}
