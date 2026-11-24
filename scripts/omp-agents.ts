// Translates an OpenCode V2 agent file into an OMP task-agent file.
//
// OMP 19.1.1 reads `name`, `description`, `tools`, `spawns` and `model` among other keys from a
// task agent's frontmatter (omp://task-agent-discovery.md, "Agent definition shape"). The
// translation:
//
//   - names the agent by its id and keeps its description;
//   - turns the model-roles tier of the `x-opencode-model-role` request header into `model:`, OMP
//     role aliases tried in order (OMP_ROLES; docs/engineering.md explains the mapping), unless the
//     source names its own roles in `x-omp-model`;
//   - turns a `permissions` list into a `tools` allowlist of the OMP built-ins its unrestricted
//     allows stand for, and the agents its `subagent` rules allow into `spawns`. A list without a
//     deny-all rule starts from OpenCode's allow-everything default; only an agent with no rules
//     at all keeps OMP's default tools;
//   - adds the OMP tools `x-omp-tools` names, which no OpenCode permission stands for;
//   - leaves bash and eval out of a read-only agent (one without an edit tool), because OMP cannot
//     hold OpenCode's per-command shell rules, unless `x-omp-shell` says why the agent needs them;
//   - drops what OMP cannot express (per-resource rules, `ask`, actions without an OMP built-in)
//     and lists each drop in a generated frontmatter comment;
//   - drops `mode`, `steps`, `hidden`, `color`, the fallback `model` and the request headers.
//
// The `x-omp-*` keys sit in `agents.src/<id>.md` only: splitOmpHints takes them out before the
// build composes the OpenCode form, because OpenCode reads a file with an unknown key as V1. The
// prompt body is kept verbatim. ompNameConflicts finds the agents OMP would merge by name.

import { agentRole, MODEL_ROLE_HEADER, type ModelTier, tierFor } from "../lib/src/model-roles.ts"
import { AGENT_MAP, parseFrontmatter, splitList } from "./convert-agent.ts"
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

/** OpenCode allows an action no rule names, so the rules of an agent's own list sit on top of this one. */
const OPENCODE_DEFAULT: Rule = { action: ANY, resource: ANY, effect: "allow" }

/**
 * The OMP `tools` allowlist and `spawns` for an OpenCode rule list, and the rules they cannot
 * carry. No rules keeps OMP's default tools. Any other list is read on top of OpenCode's
 * allow-everything default, so a list without a deny-all rule grants every built-in it does not
 * deny. An empty allowlist stays empty, so the agent gets no built-in tool rather than more than
 * its rules allow.
 */
export function ompTools(rules: readonly Rule[]): OmpTools {
  if (rules.length === 0) return { dropped: [] }
  const effective = [OPENCODE_DEFAULT, ...rules]
  const dropped: Dropped[] = []
  const drop = (rule: Rule, reason: string) => dropped.push({ action: rule.action, rule: describeRule(rule), reason })
  const tools: string[] = []
  for (const group of TOOL_GROUPS) {
    const { base, after } = groupRules(effective, group.actions)
    const granted = base?.effect === "allow"
    if (base?.effect === "ask") drop(base, ASK)
    for (const rule of after) drop(rule, granted ? RESTRICTED_KEPT : RESTRICTED_LEFT_OUT)
    if (granted) tools.push(...group.tools)
  }
  const spawns = spawnList(effective, drop)
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

/** OMP-only translation hints, from the `x-omp-*` keys of an `agents.src/<id>.md` frontmatter. */
export type OmpHints = {
  /** `x-omp-model`: the OMP role aliases to run on instead of the tier's, such as `"@architect, @slow"`. */
  model?: string
  /** `x-omp-shell`: why a read-only agent keeps bash and eval. */
  shell?: string
  /** `x-omp-tools`: OMP tools to add that no OpenCode permission stands for, such as `github`. */
  tools?: string[]
}

const HINT_KEYS = { model: "x-omp-model", shell: "x-omp-shell", tools: "x-omp-tools" } as const
const HINT_LINE = /^(x-omp-[\w-]*):(.*)$/
const ROLE_LIST = /^@[\w-]+(?:, @[\w-]+)*$/
const TOOL_NAME = /^[a-z][a-z_]*$/

/**
 * The source without its `x-omp-*` frontmatter lines, and the hints those lines carry. Each hint
 * is one top-level line: `x-omp-model` lists OMP roles (`"@role, @role"`), `x-omp-shell` gives a
 * reason, and `x-omp-tools` lists tool names. Any other `x-omp-*` key, a repeated key or a value
 * of the wrong shape throws.
 */
export function splitOmpHints(source: string, where: string): { source: string; hints: OmpHints } {
  const head = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source)?.[0]
  if (head === undefined) return { source, hints: {} }
  const kept: string[] = []
  const values = new Map<string, unknown>()
  for (const line of head.split("\n")) {
    const match = HINT_LINE.exec(line.replace(/\r$/, ""))
    if (!match) {
      kept.push(line)
      continue
    }
    const key = match[1] as string
    if (!Object.values(HINT_KEYS).includes(key as never)) throw new Error(`${where}: unknown key ${key}; the OMP hints are ${Object.values(HINT_KEYS).join(", ")}`)
    if (values.has(key)) throw new Error(`${where}: ${key} is set twice`)
    values.set(key, Bun.YAML.parse(match[2] as string))
  }
  const hints: OmpHints = {}
  const model = values.get(HINT_KEYS.model)
  if (model !== undefined) {
    if (typeof model !== "string" || !ROLE_LIST.test(model)) throw new Error(`${where}: ${HINT_KEYS.model} must list OMP roles on one line, as "@role, @role"`)
    hints.model = model
  }
  const shell = values.get(HINT_KEYS.shell)
  if (shell !== undefined) {
    if (typeof shell !== "string" || !shell.trim()) throw new Error(`${where}: ${HINT_KEYS.shell} must give the reason on one line`)
    hints.shell = shell.trim()
  }
  const tools = values.get(HINT_KEYS.tools)
  if (tools !== undefined) {
    const names = typeof tools === "string" ? splitList(tools) : []
    if (names.length === 0 || names.some((name) => !TOOL_NAME.test(name)) || new Set(names).size !== names.length)
      throw new Error(`${where}: ${HINT_KEYS.tools} must list distinct OMP tool names on one line, as "github, todo"`)
    hints.tools = names
  }
  return { source: kept.join("\n") + source.slice(head.length), hints }
}

/** The OMP tools that run any command: bash, and eval through its `sh()` helper. */
const SHELL_TOOLS: readonly string[] = ["bash", "eval"]

/** The OMP tools that write files; an agent with none of them is read-only. */
const EDIT_TOOLS: readonly string[] = TOOL_GROUPS.find((group) => group.actions.includes("edit"))?.tools ?? []

/**
 * The tools of an agent after the read-only rule, the frontmatter comment it adds, and the
 * prompt notice for a kept shell. A read-only agent, one without an OMP edit tool, loses bash
 * and eval: OMP cannot hold the per-command rules that keep an OpenCode read-only shell from
 * writing. `reason`, from `x-omp-shell`, keeps them and is recorded; the comment is not part of
 * the prompt, so `notice` tells the agent itself that nothing enforces its limits. It throws on
 * an agent the rule does not touch.
 */
export function readOnlyShell(
  tools: readonly string[],
  reason: string | undefined,
  where = "agent",
): { tools: string[]; comment: string[]; notice?: string } {
  const shells = tools.filter((tool) => SHELL_TOOLS.includes(tool))
  const readOnly = shells.length > 0 && !tools.some((tool) => EDIT_TOOLS.includes(tool))
  if (!readOnly) {
    if (reason !== undefined) throw new Error(`${where}: ${HINT_KEYS.shell} applies only to a read-only agent with bash or eval`)
    return { tools: [...tools], comment: [] }
  }
  const named = shells.join(" and ")
  if (reason !== undefined)
    return {
      tools: [...tools],
      comment: [`# Read-only, but keeps ${named}: ${reason}`],
      notice: `Your ${named} ${shells.length > 1 ? "are" : "is"} not limited to read-only commands here: only the session's approval mode gates ${shells.length > 1 ? "them" : "it"}, and nothing enforces the limits in these instructions. You MUST keep to them yourself, and run only the commands they call for.`,
    }
  const left = shells.length > 1 ? "are left out: OMP cannot limit them" : "is left out: OMP cannot limit it"
  return { tools: tools.filter((tool) => !shells.includes(tool)), comment: [`# Read-only: ${named} ${left} to read-only commands.`] }
}

/** The OMP tools for a translated allowlist and the hints, with the comment the read-only rule adds. */
function hintedTools(tools: string[] | undefined, hints: OmpHints, where: string): { tools?: string[]; comment: string[]; notice?: string } {
  if (tools === undefined) {
    if (hints.tools !== undefined || hints.shell !== undefined)
      throw new Error(`${where}: ${HINT_KEYS.tools} and ${HINT_KEYS.shell} need a permissions list; without one the agent keeps OMP's default tools`)
    return { comment: [] }
  }
  const added = hints.tools ?? []
  const present = added.filter((tool) => tools.includes(tool))
  if (present.length > 0) throw new Error(`${where}: ${HINT_KEYS.tools} repeats ${present.join(", ")}, which the permissions already grant`)
  return readOnlyShell([...tools, ...added], hints.shell, where)
}

const SOURCE_PREFIX = "# Generated by scripts/build.ts from "

/**
 * The OMP task agent for one OpenCode agent file, or a thrown error when it cannot be
 * translated: a missing description, an unknown tier, a malformed rule list, or hints that do
 * not fit the agent.
 */
export function translateOmpAgent(id: string, text: string, where = `agents/${id}.md`, hints: OmpHints = {}): OmpAgent {
  const { data, body } = parseFrontmatter(text)
  const description = data.description
  if (typeof description !== "string" || !description.trim()) throw new Error(`${where}: description is required`)
  const request = data.request as { headers?: Record<string, string> } | undefined
  const tierModel = ompModel(agentRole(request), where)
  const model = hints.model ?? tierModel
  const translated = ompTools(readRules(where, data.permissions))
  const { tools, comment, notice } = hintedTools(translated.tools, hints, where)
  const lines = ["---", `${SOURCE_PREFIX}${where}. Do not edit.`, ...comment, ...droppedComment(translated.dropped), `name: ${id}`, `description: ${quote(description)}`]
  // An empty `tools:` reads as YAML null, which OMP takes as its default tools; `[]` means none.
  if (tools !== undefined) lines.push(`tools: ${tools.length > 0 ? tools.join(", ") : "[]"}`)
  if (translated.spawns !== undefined) lines.push(`spawns: ${quote(translated.spawns)}`)
  if (model !== undefined) lines.push(`model: ${quote(model)}`)
  lines.push("---")
  // The notice opens the prompt, ahead of the instructions it qualifies.
  const prompt = notice === undefined ? body : `\n${notice}\n${body}`
  return { id, contents: `${lines.join("\n")}\n${prompt}`, dropped: translated.dropped }
}

/**
 * OMP's bundled agents. A plugin agent of the same name replaces the bundled one for every
 * caller (omp://task-agent-discovery.md, "Bundled agents" and "Merge and collision rules").
 */
export const OMP_BUNDLED_AGENTS: readonly string[] = ["scout", "reviewer", "security-reviewer", "task", "sonic"]

/** One plugin's translated OMP agent file. */
export type ShippedOmpAgent = { plugin: string; id: string; contents: string }

/** An OMP agent file without its source comment, the one line that differs between plugins. */
const withoutSource = (contents: string) => {
  const lines = contents.split("\n")
  return lines.filter((line, index) => !(index === 1 && line.startsWith(SOURCE_PREFIX))).join("\n")
}

/**
 * The problems OMP's first-wins merge by agent name would hide: an agent named like a bundled
 * one, and an agent several plugins ship whose OMP files differ apart from the source comment.
 * OMP has no plugin dependency, so each plugin ships its own copy, and the copies must match.
 */
export function ompNameConflicts(agents: readonly ShippedOmpAgent[]): string[] {
  const problems: string[] = []
  for (const agent of agents)
    if (OMP_BUNDLED_AGENTS.includes(agent.id)) problems.push(`${agent.plugin}: agent ${agent.id} would replace OMP's bundled ${agent.id}; rename it`)
  for (const [id, copies] of Map.groupBy(agents, (agent) => agent.id)) {
    const [first, ...rest] = copies as [ShippedOmpAgent, ...ShippedOmpAgent[]]
    for (const copy of rest)
      if (withoutSource(copy.contents) !== withoutSource(first.contents))
        problems.push(`agent ${id}: the OMP files of ${first.plugin} and ${copy.plugin} differ, and OMP loads only the first; make them match`)
  }
  return problems
}
