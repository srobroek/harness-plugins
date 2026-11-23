// Translates an OpenCode V2 agent file into an OMP task-agent file.
//
// OMP 19.1.1 reads `name`, `description`, `tools`, `spawns` and `model` among other keys from a
// task agent's frontmatter (omp://task-agent-discovery.md, "Agent definition shape"). The
// translation:
//
//   - names the agent by its id and keeps its description;
//   - turns the model-roles tier of the `x-opencode-model-role` request header into `model:`, OMP
//     role aliases tried in order (OMP_ROLES; docs/engineering.md explains the mapping);
//   - turns a deny-all-first `permissions` list into a `tools` allowlist of the OMP built-ins its
//     unrestricted allows stand for, and the agents its `subagent` rules allow into `spawns`. A
//     list without the deny-all rule is refused: OMP has no tool denylist, so only an agent with
//     no rules at all keeps OMP's default tools;
//   - drops what OMP cannot express (per-resource rules, `ask`, actions without an OMP built-in)
//     and lists each drop in a generated frontmatter comment;
//   - drops `mode`, `steps`, `hidden`, `color`, the fallback `model` and the request headers.
//
// The prompt body is kept verbatim.

import { agentRole, MODEL_ROLE_HEADER, type ModelTier, tierFor } from "../lib/src/model-roles.ts"
import { AGENT_MAP, parseFrontmatter } from "./convert-agent.ts"
import { ANY, actionMatches, describeRule, groupRules, type Rule, readRules } from "./opencode-permissions.ts"

/**
 * The OMP role aliases each tier runs on, in order. OMP skips a role the user has not assigned,
 * so a tier without a built-in OMP role names its old OMP role first and falls back to `slow`,
 * the built-in `strong` role, as model-roles lets `reviewer` and `orchestrate` borrow `strong`.
 */
export const OMP_ROLES: Readonly<Record<ModelTier, readonly string[]>> = {
  cheap: ["smol"],
  standard: ["task"],
  strong: ["slow"],
  reviewer: ["challenger", "slow"],
  orchestrate: ["orchestrate", "slow"],
}

/** OpenCode permission actions and the OMP built-in tools they stand for, in output order. */
const TOOL_GROUPS: ReadonlyArray<{ actions: readonly string[]; tools: readonly string[] }> = [
  { actions: ["read"], tools: ["read"] },
  { actions: ["grep"], tools: ["grep", "ast_grep"] },
  { actions: ["glob"], tools: ["glob"] },
  { actions: ["lsp_*"], tools: ["lsp"] },
  { actions: ["edit"], tools: ["edit", "write", "ast_edit"] },
  { actions: ["shell", "bash"], tools: ["bash"] },
  { actions: ["execute"], tools: ["eval"] },
  { actions: ["websearch"], tools: ["web_search"] },
]

/** The `subagent` actions; allowing one grants `task` and fills `spawns`. OMP adds `wait` to every agent itself. */
const SUBAGENT_ACTIONS = ["subagent", "task"] as const

/** OpenCode agent names and their OMP counterparts; other names are kept. */
const OMP_AGENTS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(AGENT_MAP).map(([omp, openCode]) => [openCode, omp])),
  general: "task",
}

/** Why an action without an OMP built-in is dropped; others get NO_BUILTIN. */
const UNMAPPED_REASONS: Readonly<Record<string, string>> = {
  webfetch: "OMP fetches URLs with read",
  skill: "OMP has no per-agent skill filter",
  external_directory: "OMP has no per-agent directory rule",
  question: "OMP subagents cannot ask the user",
  todowrite: "OMP subagents have no todo tool",
}
const NO_BUILTIN = "no OMP built-in tool; tools filters built-ins only"
const ASK = "OMP has no per-agent ask; left out"
const RESTRICTED_KEPT = "OMP has no per-resource rules; the tool is kept"
const RESTRICTED_LEFT_OUT = "OMP has no per-resource rules; the tool is left out"
const SPAWN_ALL = "OMP spawns cannot exclude an agent"
const SPAWN_GLOB = "OMP spawns takes agent names, not globs"

/** At most this many rules of one action are listed under one reason; more are counted. */
const MAX_LISTED = 6

/** A rule the translation could not carry over, and why. */
export type Dropped = { action: string; rule: string; reason: string }

export type OmpTools = { tools?: string[]; spawns?: string; dropped: Dropped[] }

export type OmpAgent = { id: string; contents: string; dropped: Dropped[] }

/** The `model:` value for a request-header tier: OMP role aliases, or undefined to inherit. */
export function ompModel(tier: string | undefined, where = "agent"): string | undefined {
  if (tier === undefined) return undefined
  const resolved = tierFor(tier)
  if (resolved === undefined) throw new Error(`${where}: ${MODEL_ROLE_HEADER} "${tier}" is not a model tier`)
  if (resolved === "inherit") return undefined
  return OMP_ROLES[resolved].map((role) => `@${role}`).join(", ")
}

/**
 * The OMP `tools` allowlist and `spawns` for an OpenCode rule list, and the rules they cannot
 * carry. No rules keeps OMP's default tools; any other list must start from a deny-all rule.
 * An empty allowlist stays empty, so the agent gets no built-in tool rather than more than
 * its rules allow.
 */
export function ompTools(rules: readonly Rule[], where = "agent"): OmpTools {
  if (rules.length === 0) return { dropped: [] }
  if (!rules.some((rule) => rule.action === ANY && rule.resource === ANY && rule.effect === "deny"))
    throw new Error(`${where}: OMP tools is an allowlist; start permissions with a deny-all rule`)
  const dropped: Dropped[] = []
  const drop = (rule: Rule, reason: string) => dropped.push({ action: rule.action, rule: describeRule(rule), reason })
  const tools: string[] = []
  for (const group of TOOL_GROUPS) {
    const { base, after } = groupRules(rules, group.actions)
    const granted = base?.effect === "allow"
    if (base?.effect === "ask") drop(base, ASK)
    for (const rule of after) drop(rule, granted ? RESTRICTED_KEPT : RESTRICTED_LEFT_OUT)
    if (granted) tools.push(...group.tools)
  }
  const spawns = spawnList(rules, drop)
  if (spawns !== undefined) tools.push("task")
  for (const rule of rules) {
    const mapped = [...TOOL_GROUPS.flatMap((group) => group.actions), ...SUBAGENT_ACTIONS].some((action) =>
      actionMatches(rule.action, action),
    )
    if (rule.action !== ANY && rule.effect !== "deny" && !mapped) drop(rule, UNMAPPED_REASONS[rule.action] ?? NO_BUILTIN)
  }
  return { tools, ...(spawns === undefined ? {} : { spawns }), dropped }
}

/** The agents the `subagent` rules let the agent spawn: `*`, a name list, or undefined for none. */
function spawnList(rules: readonly Rule[], drop: (rule: Rule, reason: string) => void): string | undefined {
  const { base, after } = groupRules(rules, SUBAGENT_ACTIONS)
  if (base?.effect === "allow") {
    for (const rule of after) drop(rule, SPAWN_ALL)
    return ANY
  }
  if (base?.effect === "ask") drop(base, ASK)
  const names: string[] = []
  for (const rule of after) {
    if (rule.resource.includes(ANY)) {
      drop(rule, SPAWN_GLOB)
      continue
    }
    const name = OMP_AGENTS[rule.resource] ?? rule.resource
    if (names.includes(name)) names.splice(names.indexOf(name), 1)
    if (rule.effect === "allow") names.push(name)
    else if (rule.effect === "ask") drop(rule, ASK)
  }
  return names.length > 0 ? names.join(", ") : undefined
}

/** Frontmatter comment lines naming every dropped rule, grouped by reason. */
export function droppedComment(dropped: readonly Dropped[]): string[] {
  if (dropped.length === 0) return []
  const lines = ["# OMP cannot express these OpenCode permissions; they are dropped:"]
  for (const [reason, drops] of Map.groupBy(dropped, (drop) => drop.reason)) {
    const parts = [...Map.groupBy(drops, (drop) => drop.action)].map(([action, list]) =>
      list.length > MAX_LISTED ? `${list.length} ${action} rules` : list.map((drop) => drop.rule).join(", "),
    )
    lines.push(`#   ${reason}: ${parts.join(", ")}`)
  }
  return lines
}

const quote = (value: string) => JSON.stringify(value)

/**
 * The OMP task agent for one OpenCode agent file, or a thrown error when it cannot be
 * translated: a missing description, an unknown tier, or a rule list OMP cannot hold.
 */
export function translateOmpAgent(id: string, text: string, where = `agents/${id}.md`): OmpAgent {
  const { data, body } = parseFrontmatter(text)
  const description = data.description
  if (typeof description !== "string" || !description.trim()) throw new Error(`${where}: description is required`)
  const request = data.request as { headers?: Record<string, string> } | undefined
  const model = ompModel(agentRole(request), where)
  const { tools, spawns, dropped } = ompTools(readRules(where, data.permissions), where)
  const lines = [
    "---",
    `# Generated by scripts/build.ts from ${where}. Do not edit.`,
    ...droppedComment(dropped),
    `name: ${id}`,
    `description: ${quote(description)}`,
  ]
  // An empty `tools:` reads as YAML null, which OMP takes as its default tools; `[]` means none.
  if (tools !== undefined) lines.push(`tools: ${tools.length > 0 ? tools.join(", ") : "[]"}`)
  if (spawns !== undefined) lines.push(`spawns: ${quote(spawns)}`)
  if (model !== undefined) lines.push(`model: ${quote(model)}`)
  lines.push("---")
  return { id, contents: `${lines.join("\n")}\n${body}`, dropped }
}
