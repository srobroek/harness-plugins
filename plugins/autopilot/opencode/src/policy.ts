/** No-questions and permission policy while a run is armed. Pure. */

import type { Grant } from "./args.ts"

/** Tools that ask the user something and wait. */
export const ASK_TOOLS: ReadonlySet<string> = new Set(["question", "parley_ask", "parley_wait", "parley_end", "ask_user", "ask_followup_question"])

/** Whether `tool` (direct or a Code Mode path such as `parley.ask`) asks the user. */
export function isAskTool(tool: string): boolean {
  const name = tool.replace(/^tools\./, "").replace(/[.\-]/g, "_").toLowerCase()
  return ASK_TOOLS.has(name)
}

export const DENY_QUESTION =
  "autopilot is armed: never ask the user. Decide reversible items, log them with autopilot_log (type decision), park irreversible ones as a blocker, and continue."

export type Category = "merge" | "deploy" | "push-default" | "force-push" | "irreversible" | "other"

/** `git`, its global options (`-C dir`, `-c key=value`, `--git-dir=…`), then the subcommand. */
const GIT = String.raw`\bgit(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+`
const git = (rest: string, flags = "") => new RegExp(GIT + rest, flags)

const MERGE = [/\bgh\s+pr\s+merge\b/, /\bglab\s+mr\s+merge\b/, git(String.raw`merge\b.*\b(origin\/)?(main|master)\b`)]
const DEPLOY = [
  /\bcdk\s+(deploy|destroy)\b/,
  /\baws\s+cloudformation\s+(create-stack|update-stack|delete-stack|deploy|execute-change-set)\b/,
  /\bsam\s+(deploy|delete)\b/,
  /\b(terraform|tofu)\s+(apply|destroy)\b/,
  /\bpulumi\s+(up|destroy)\b/,
  /\bsst\s+(deploy|remove)\b/,
]
const PUSH_DEFAULT = git(String.raw`push\b[^|;&]*\s\+?(\S+:)?(refs\/heads\/)?(main|master)(?=$|[\s;|&])`, "m")
/** `--force`, `-f` or a `+` refspec; `--force-with-lease` is the safe form. */
const FORCE = git(String.raw`push\b[^|;&]*\s(--force(?!-with-lease)\b|-f\b|\+\S)`)
/** Commands that discard work or history and cannot be undone from the repository. */
const IRREVERSIBLE = [
  git(String.raw`reset\b[^|;&]*\s--hard\b`),
  git(String.raw`clean\b[^|;&]*\s-[a-z]*f`),
  git(String.raw`branch\b[^|;&]*\s(-D\b|--delete\s+--force\b|-d\s+-f\b)`),
  git(String.raw`push\b[^|;&]*\s(--delete\b|-d\b|\S+\s+:\S)`),
  git(String.raw`stash\s+(drop|clear)\b`),
  git(String.raw`worktree\s+remove\b[^|;&]*\s--force\b`),
  /(^|[\s;&|(])rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/,
  /\bbd\s+(delete|purge)\b/,
]

/** Every category a permission request touches, most severe first; `other` when none applies. */
export function categories(action: string, resources: readonly string[]): Category[] {
  const name = action.toLowerCase()
  const text = resources.join("\n")
  const found: Category[] = []
  if (FORCE.test(text)) found.push("force-push")
  if (PUSH_DEFAULT.test(text)) found.push("push-default")
  if (name === "delivery_land" || name.endsWith("_merge") || MERGE.some((pattern) => pattern.test(text))) found.push("merge")
  if (DEPLOY.some((pattern) => pattern.test(text))) found.push("deploy")
  if (IRREVERSIBLE.some((pattern) => pattern.test(text))) found.push("irreversible")
  return found.length ? found : ["other"]
}

/** The most severe category a permission request touches. */
export function categorize(action: string, resources: readonly string[]): Category {
  return categories(action, resources)[0] as Category
}

export type AskDecision = { effect: "allow" } | { effect: "deny"; reason: string }

function decideCategory(category: Category, grants: readonly Grant[], full: boolean): AskDecision {
  switch (category) {
    case "force-push":
      return { effect: "deny", reason: "autopilot never force-pushes; use --force-with-lease on a feature branch" }
    case "push-default":
      return { effect: "deny", reason: "autopilot never pushes to the default branch; push a feature branch and open a PR" }
    case "merge":
    case "deploy":
      return grants.includes(category)
        ? { effect: "allow" }
        : { effect: "deny", reason: `${category} is not granted for this run (--allow ${category}); logged as a blocker` }
    case "irreversible":
      return full ? { effect: "allow" } : { effect: "deny", reason: "irreversible command parked: it discards work; logged as a blocker (a --full run decides it)" }
    case "other":
      return { effect: "allow" }
  }
}

/**
 * The answer to a permission `ask` while armed. Default grants cover branch work, pushes of
 * feature branches, PRs, beads, dependency bumps, read-only AWS and spikes; `merge` and `deploy`
 * need `--allow`. Commands that discard work are parked unless the run is `--full`. Force pushes
 * and pushes to the default branch are never granted. A request that touches several categories
 * needs every one of them allowed.
 */
export function decideAsk(action: string, resources: readonly string[], grants: readonly Grant[], full: boolean): AskDecision {
  for (const category of categories(action, resources)) {
    const decision = decideCategory(category, grants, full)
    if (decision.effect === "deny") return decision
  }
  return { effect: "allow" }
}

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
