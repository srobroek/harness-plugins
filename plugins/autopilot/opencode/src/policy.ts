/** No-questions policy and write lanes while a run is armed. Pure. */

import { commitChecks, own, requiredContexts, reviewApproval, str, usesMergeQueue } from "@srobroek/opencode-lib/pr-approval"

/** Tools that ask the user something and wait. */
export const ASK_TOOLS: ReadonlySet<string> = new Set(["question", "parley_ask", "parley_wait", "parley_end", "ask_user", "ask_followup_question"])

/** Whether `tool` (direct or a Code Mode path such as `parley.ask`) asks the user. */
export function isAskTool(tool: string): boolean {
  const name = tool.replace(/^tools\./, "").replace(/[.-]/g, "_").toLowerCase()
  return ASK_TOOLS.has(name)
}

export const DENY_QUESTION =
  "autopilot is armed: never ask the user. Decide reversible items, log them with autopilot_log (type decision), park irreversible ones as a blocker, and continue."

const ASKING = [/\?\s*$/, /\b(should I|shall I|do you want|would you like|let me know|which (one|option) do you)\b/i]

/** Whether the final text of a turn hands a question to the user. */
export function endsWithQuestion(text: string): boolean {
  const paragraphs = text.trim().split(/\n\s*\n/)
  const last = paragraphs.at(-1)?.trim() ?? ""
  if (last === "") return false
  return ASKING.some((pattern) => pattern.test(last))
}

export const REPROMPT =
  "autopilot is armed and the user is away: do not ask. Pick the most likely answer for anything reversible and log it with autopilot_log (type decision); log irreversible or outward-facing items as a blocker with parked: true. Then continue with the next item."

/** Agents that never write to a checkout, so they run without a write lane. */
export const READ_ONLY_AGENTS: ReadonlySet<string> = new Set([
  "explore",
  "researcher",
  "code-reviewer",
  "pr-reviewer",
  "security-reviewer",
  "adversarial-challenger",
  "seance",
  "debug",
  "operator",
  "plan",
])

/** Whether a subagent of `agent` takes one of the run's write lanes. An unknown agent does. */
export function holdsLane(agent: string | undefined): boolean {
  return agent === undefined || !READ_ONLY_AGENTS.has(agent)
}

// --- permission auto-allow ---------------------------------------------------------------------

/** The kinds of effect the permission hook sees. */
export type Effect = "allow" | "deny" | "ask"

/** Resolves a path to its real path, or `undefined` when it does not exist. */
export type Canon = (path: string) => string | undefined

export const EXTERNAL_DIRECTORY = "external_directory"
export const MERGE_ACTION = "autopilot_merge"

/**
 * Whether an `external_directory` ask is for exactly `<root>/*` of one of the run's confirmed
 * worktree `roots`. Both sides are compared by real path, so an alias of a root matches and a
 * sibling that shares the prefix, a path under the root, or a symlink leading outside does not.
 * Only an `ask` is ever turned into an allow.
 */
export function ownWorktreeAsk(input: { action: string; effect: Effect; resources: ReadonlyArray<string>; roots: readonly string[]; canon: Canon }): boolean {
  if (input.effect !== "ask" || input.action !== EXTERNAL_DIRECTORY) return false
  if (input.resources.length === 0 || input.roots.length === 0) return false
  const real = new Set(input.roots.flatMap((root) => input.canon(root) ?? []))
  return input.resources.every((resource) => {
    if (!resource.endsWith("/*")) return false
    const root = resource.slice(0, -2)
    if (!root.startsWith("/") || /[*?]/.test(root)) return false
    const resolved = input.canon(root)
    return resolved !== undefined && real.has(resolved)
  })
}

const FULL_SHA = /^[0-9a-f]{40}$/

/** The permission resource of one merge: `<pr>@<sha>`. */
export function mergeResource(pr: number | string, sha: string): string {
  return `${pr}@${sha}`
}

/** Whether an `autopilot_merge` ask for one `<pr>@<sha>` is covered by the `merge` grant. */
export function grantedMergeAsk(input: { action: string; effect: Effect; resources: ReadonlyArray<string>; allow: readonly string[] }): boolean {
  if (input.effect !== "ask" || input.action !== MERGE_ACTION || !input.allow.includes("merge")) return false
  const [resource, ...rest] = input.resources
  return rest.length === 0 && resource !== undefined && /^\d+@[0-9a-f]{40}$/.test(resource)
}

const text = (holder: unknown, key: string): string | undefined => str(holder, key) ?? undefined

export const MERGE_METHODS = ["squash", "rebase", "merge"] as const
export type MergeMethod = (typeof MERGE_METHODS)[number]

/** Why `method` may not be used on the repository, from `gh repo view --json squashMergeAllowed,rebaseMergeAllowed,mergeCommitAllowed`. */
function methodRefusal(repo: unknown, method: string): string | undefined {
  if (!(MERGE_METHODS as readonly string[]).includes(method)) return `method must be one of ${MERGE_METHODS.join(", ")}`
  const flag = { squash: "squashMergeAllowed", rebase: "rebaseMergeAllowed", merge: "mergeCommitAllowed" }[method as MergeMethod]
  return own(repo, flag) === true ? undefined : `method ${method} is not allowed by the repository (or its settings were unreadable)`
}

/**
 * Why a PR may not be merged at `sha` with `method`, or `undefined` when it may. `view` is `gh pr
 * view --json state,headRefOid,baseRefName,author`; `reviews`, `runs` and `status` are the REST
 * payloads for the PR's reviews and the commit's check runs and status; `protection` and `rules` are
 * the base branch's required-status-checks protection and rulesets, `undefined` when unreadable (which refuses). Approval is a review by someone other than the
 * author, on exactly `sha`; comments never count. Anything unreadable refuses.
 */
export function mergeRefusal(input: { sha: string; method: string; view: unknown; reviews: unknown; runs: unknown; status: unknown; protection: unknown; rules: unknown; repo: unknown }): string | undefined {
  const sha = input.sha.toLowerCase()
  if (!FULL_SHA.test(sha)) return "sha must be the full 40-digit head commit"
  const head = text(input.view, "headRefOid")?.toLowerCase()
  if (head !== sha) return `PR head is ${head ?? "unreadable"}, not the reviewed ${sha}; review the new head first`
  const state = text(input.view, "state")
  if (state !== "OPEN") return `PR state is ${state ?? "unreadable"}, expected OPEN`
  const method = methodRefusal(input.repo, input.method)
  if (method !== undefined) return method
  const approval = reviewApproval(input.reviews, text(own(input.view, "author"), "login") ?? null, sha)
  if (!approval.ok) return approval.reason
  if (usesMergeQueue(input.rules)) return "the base branch uses a merge queue; merge queues unsupported"
  const required = requiredContexts(input.protection, input.rules, { requireBoth: true })
  const checks = commitChecks({ runs: input.runs, status: input.status, required, requireKnown: true })
  return checks.ok ? undefined : checks.reason
}

// --- recorded worktree roots -------------------------------------------------------------------

/** A recorded worktree root: where it was, what it resolved to, and which inode it was. */
export type RootIdentity = { path: string; real: string; dev: string; ino: string }

/** What `lstat` says about a path (the last component is not followed). */
export type Probe = { isDirectory: boolean; isSymbolicLink: boolean; dev: string; ino: string }
export type Lstat = (path: string) => Probe | undefined

/** The identity of `path` when it is a plain directory (not a symlink), else `undefined`. */
export function identifyRoot(path: string, lstat: Lstat, canon: Canon): RootIdentity | undefined {
  const stat = lstat(path)
  const resolved = canon(path)
  if (stat === undefined || resolved === undefined || !stat.isDirectory || stat.isSymbolicLink) return undefined
  return { path, real: resolved, dev: stat.dev, ino: stat.ino }
}

/** Whether `root` is still the directory that was recorded: same inode, same device, same real path, still not a symlink. */
export function rootIntact(root: RootIdentity, lstat: Lstat, canon: Canon): boolean {
  const now = identifyRoot(root.path, lstat, canon)
  return now !== undefined && now.real === root.real && now.dev === root.dev && now.ino === root.ino
}

/**
 * Whether a child session's directory is a worktree the run may record: the child can write
 * (not a read-only agent), the project lists the directory, it is not the primary checkout, and it
 * carries the linked-worktree marker.
 */
export function recordableLane(input: { agent: string | undefined; directory: string; listed: ReadonlySet<string>; primary: ReadonlySet<string>; canon: Canon; linked: (directory: string) => boolean }): boolean {
  if (!holdsLane(input.agent)) return false
  const resolved = input.canon(input.directory)
  return resolved !== undefined && input.listed.has(resolved) && !input.primary.has(resolved) && input.linked(input.directory)
}

/**
 * Whether `gh pr merge` really merged the PR at `sha`. `view` is `gh pr view --json
 * state,headRefOid,mergeCommit,autoMergeRequest` read afterwards. Success needs MERGED, the
 * reviewed head and a merge commit. `disableAuto` says the PR may still be queued to merge later
 * (open, or an auto-merge request recorded), so the caller must cancel that.
 */
export function mergeOutcome(view: unknown, sha: string): { ok: true } | { ok: false; reason: string; disableAuto: boolean } {
  const state = text(view, "state")
  const head = text(view, "headRefOid")?.toLowerCase()
  const queued = own(view, "autoMergeRequest") != null
  const disableAuto = state !== "MERGED" || queued
  if (view === undefined) return { ok: false, reason: "could not read the PR after merging, so the merge is unconfirmed", disableAuto }
  if (state !== "MERGED") return { ok: false, reason: `PR is ${state ?? "unreadable"} after gh pr merge, not MERGED; it may be queued for a later merge`, disableAuto }
  if (head !== sha) return { ok: false, reason: `PR merged at ${head ?? "an unreadable head"}, not the reviewed ${sha}`, disableAuto }
  if (own(view, "mergeCommit") == null) return { ok: false, reason: "PR is MERGED but has no merge commit", disableAuto }
  if (queued) return { ok: false, reason: "PR is MERGED but an auto-merge request is still recorded", disableAuto }
  return { ok: true }
}
