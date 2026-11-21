/** No-questions policy and write lanes while a run is armed. Pure. */

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

function own(holder: unknown, key: string): unknown {
  return typeof holder === "object" && holder !== null && !Array.isArray(holder) ? (holder as Record<string, unknown>)[key] : undefined
}

const text = (holder: unknown, key: string): string | undefined => {
  const value = own(holder, key)
  return typeof value === "string" ? value : undefined
}

const loginOf = (holder: unknown) => text(own(holder, "author"), "login")

/** Whether the PR carries an approval for exactly `sha`: an APPROVED review of that commit, or the author's `VERDICT: APPROVE` comment naming it. */
function approvedAt(view: unknown, sha: string): boolean {
  const reviews = own(view, "reviews")
  const comments = own(view, "comments")
  if (Array.isArray(reviews) && reviews.some((review) => text(review, "state") === "APPROVED" && text(own(review, "commit"), "oid")?.toLowerCase() === sha)) return true
  const author = loginOf(view)
  if (author === undefined || !Array.isArray(comments)) return false
  return comments.some((comment) => {
    const body = text(comment, "body") ?? ""
    return loginOf(comment) === author && /^VERDICT:\s*APPROVE\b/.test(body.split(/\r?\n/, 1)[0]?.trim() ?? "") && body.toLowerCase().includes(sha)
  })
}

/**
 * Why a PR may not be merged at `sha`, or `undefined` when it may. `view` is `gh pr view --json
 * state,headRefOid,author,reviews,comments`; `checks` is `gh pr checks --json name,state,bucket`.
 * Anything unreadable refuses: an unknown approval is not an approval.
 */
export function mergeRefusal(input: { sha: string; view: unknown; checks: unknown }): string | undefined {
  const sha = input.sha.toLowerCase()
  if (!FULL_SHA.test(sha)) return "sha must be the full 40-digit head commit"
  const head = text(input.view, "headRefOid")?.toLowerCase()
  if (head !== sha) return `PR head is ${head ?? "unreadable"}, not the reviewed ${sha}; review the new head first`
  const state = text(input.view, "state")
  if (state !== "OPEN") return `PR state is ${state ?? "unreadable"}, expected OPEN`
  if (!approvedAt(input.view, sha)) return `no approval for ${sha}: expected an APPROVED review of that commit or a VERDICT: APPROVE comment by the author naming it`
  const checks = input.checks
  if (!Array.isArray(checks) || checks.length === 0) return "checks unreadable or none ran; expected every check on the head to pass"
  const bad = checks.filter((check) => !["pass", "skipping"].includes(text(check, "bucket") ?? ""))
  if (bad.length > 0) return `checks not green: ${bad.slice(0, 8).map((check) => `${text(check, "name") ?? "?"}=${text(check, "bucket") ?? text(check, "state") ?? "?"}`).join(", ")}`
  return undefined
}

/** The `gh pr merge` method flag the repository allows (squash, then rebase, then merge), from `gh repo view --json squashMergeAllowed,rebaseMergeAllowed,mergeCommitAllowed`. */
export function mergeMethodFlag(repo: unknown): "--squash" | "--rebase" | "--merge" | undefined {
  if (own(repo, "squashMergeAllowed") === true) return "--squash"
  if (own(repo, "rebaseMergeAllowed") === true) return "--rebase"
  if (own(repo, "mergeCommitAllowed") === true) return "--merge"
  return undefined
}
