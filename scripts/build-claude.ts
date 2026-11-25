// The Claude Code parts that harness-kit does not generate, derived from a plugin's OpenCode sources.
//
// Claude Code reads a subagent's `tools` and `disallowedTools` but ignores its OpenCode `permissions:`,
// so `scripts/claude-agents.ts` translates each OpenCode agent. For a plugin that lists `claude` in its
// harnesses this writes, next to the OpenCode agent files in `plugins/<name>/common/agents/`:
//
//   <id>.claude.md            the translated subagent (harness-kit copies it to claude/agents/<id>.md)
//
// and under `plugins/<name>/claude/`:
//
//   hooks/hooks.json          the plugin's own hooks (`plugins/<name>/claude-hooks.json`) plus, when an
//                             agent has a resource-restricted `ask`, a PreToolUse guard hook
//   hooks/agent-guard.mjs     the guard (scripts/claude-agent-guard.ts, transpiled)
//   hooks/agent-guards.json   the guard rules per agent
//
// `claudeAgents` in the `agent-plugins` key picks the agents to translate (default: every non-primary one).
// An agent that is not translated keeps only its OpenCode file, `<id>.opencode.md`, so the Claude Code tree
// does not load it.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { type Guard, translateAgent } from "./claude-agents.ts"
import { parseFrontmatter } from "./convert-agent.ts"

export type Output = { file: string; contents: string }

const GUARD_SCRIPT = "agent-guard.mjs"
const GUARD_CONFIG = "agent-guards.json"
const GUARD_SOURCE = path.join(import.meta.dir, "claude-agent-guard.ts")
/** The source's Bun-only entry check; the shipped script calls `main()` unconditionally instead. */
const GUARD_ENTRY = "if (import.meta.main) main()"

/** The command of the guard hook: node or bun runs it, and with neither every guarded call asks. */
const GUARD_FALLBACK =
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"agent guard needs node or bun; asking instead"}}'
const GUARD_COMMAND =
  `R="\${CLAUDE_PLUGIN_ROOT}/hooks/${GUARD_SCRIPT}"; ` +
  `if command -v node >/dev/null 2>&1; then node "$R"; elif command -v bun >/dev/null 2>&1; then bun "$R"; ` +
  `else printf '%s' '${GUARD_FALLBACK}'; fi; exit 0`

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** The file in `common/agents/` that holds an agent's OpenCode form; `variant` gives `<id>.opencode.md` (see `openCodeVariant` in build.ts). */
export function openCodeAgentFile(id: string, variant: boolean): string {
  return `${id}${variant ? ".opencode" : ""}.md`
}

/** Agent ids in `agents`, split into primary and not, in id order. */
function classify(agents: ReadonlyMap<string, string>): { id: string; primary: boolean }[] {
  return [...agents]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, text]) => ({ id, primary: parseFrontmatter(text).data.mode === "primary" }))
}

/** The agent ids translated for Claude Code: the selected ones, or every non-primary agent. */
export function claudeAgentIds(where: string, agents: ReadonlyMap<string, string>, selected: string[] | undefined): string[] {
  const all = classify(agents)
  if (selected === undefined) return all.filter((agent) => !agent.primary).map((agent) => agent.id)
  for (const id of selected) {
    const agent = all.find((candidate) => candidate.id === id)
    if (agent === undefined) throw new Error(`${where}: "claudeAgents" names "${id}", which is not in common/agents/`)
    if (agent.primary) throw new Error(`${where}: "claudeAgents" names the primary agent "${id}"`)
  }
  return [...new Set(selected)].sort()
}

/** The hook, its script and the guard rules for the agents of one plugin. */
function guardOutputs(claudeDir: string, guards: Record<string, Guard[]>) {
  const tools = [...new Set(Object.values(guards).flatMap((list) => list.flatMap((guard) => guard.tools)))]
  const source = readFileSync(GUARD_SOURCE, "utf8")
  if (source.split(GUARD_ENTRY).length !== 2) throw new Error(`${GUARD_SOURCE}: needs exactly one "${GUARD_ENTRY}" line`)
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(GUARD_ENTRY, "main()"))
  return {
    files: [
      { file: path.join(claudeDir, "hooks", GUARD_SCRIPT), contents: script },
      { file: path.join(claudeDir, "hooks", GUARD_CONFIG), contents: json(guards) },
    ],
    hooks: {
      description: "Asks before a subagent touches a resource its OpenCode rules ask about; Claude Code ignores subagent hooks of plugins.",
      hooks: { PreToolUse: [{ matcher: tools.join("|"), hooks: [{ type: "command", command: GUARD_COMMAND, timeout: 10 }] }] },
    },
  }
}

type HooksFile = { description?: string; hooks: Record<string, unknown[]> }

/** Merge hook files: descriptions join, and each event lists the entries of every file in order. */
export function mergeHooks(files: readonly HooksFile[]): HooksFile {
  const hooks: Record<string, unknown[]> = {}
  for (const file of files) for (const [event, entries] of Object.entries(file.hooks)) hooks[event] = [...(hooks[event] ?? []), ...entries]
  const description = files.flatMap((file) => (file.description === undefined ? [] : [file.description])).join(" ")
  return { ...(description ? { description } : {}), hooks }
}

export type ClaudeInput = {
  /** `plugins/<name>`. */
  dir: string
  /** The OpenCode form of every agent, by id: composed from `agents.src/` or hand-written. */
  agents: ReadonlyMap<string, string>
  /** `claudeAgents` from the `agent-plugins` key. */
  selected?: string[]
}

/** Every generated Claude Code file of one plugin that lists `claude`. Translation warnings go to `warn`. */
export function claudeOutputs(input: ClaudeInput, warn: (message: string) => void = () => {}): Output[] {
  const name = path.basename(input.dir)
  const where = `plugins/${name}/package.json`
  const claudeDir = path.join(input.dir, "claude")
  const outputs: Output[] = []
  const guards: Record<string, Guard[]> = {}
  for (const id of claudeAgentIds(where, input.agents, input.selected)) {
    const source = `common/agents/${openCodeAgentFile(id, true)}`
    const agent = translateAgent(id, input.agents.get(id) as string, `plugins/${name}/${source}`)
    for (const [reason, drops] of Map.groupBy(agent.dropped, (drop) => drop.reason)) {
      warn(`${name}/${id}: ${reason}: ${drops.map((drop) => drop.rule).join(", ")}`)
    }
    if (agent.guards.length > 0) guards[id] = agent.guards
    outputs.push({ file: path.join(input.dir, "common", "agents", `${id}.claude.md`), contents: agent.contents })
  }
  const own = path.join(input.dir, "claude-hooks.json")
  const hookFiles: HooksFile[] = existsSync(own) ? [JSON.parse(readFileSync(own, "utf8")) as HooksFile] : []
  if (Object.keys(guards).length > 0) {
    const guard = guardOutputs(claudeDir, guards)
    outputs.push(...guard.files)
    hookFiles.push(guard.hooks)
  }
  if (hookFiles.length > 0) outputs.push({ file: path.join(claudeDir, "hooks", "hooks.json"), contents: json(mergeHooks(hookFiles)) })
  return outputs
}

/** Translated agents in `common/agents/` and generated hook files that a fresh render no longer produces. */
export function staleClaudeFiles(input: Pick<ClaudeInput, "dir">, outputs: readonly Output[]): string[] {
  const expected = new Set(outputs.map((output) => output.file))
  const agents = path.join(input.dir, "common", "agents")
  const translated = existsSync(agents) ? readdirSync(agents).filter((file) => file.endsWith(".claude.md")).map((file) => path.join(agents, file)) : []
  const hooks = path.join(input.dir, "claude", "hooks")
  const generated = ["hooks.json", GUARD_SCRIPT, GUARD_CONFIG].map((file) => path.join(hooks, file)).filter(existsSync)
  return [...translated, ...generated].filter((file) => !expected.has(file))
}
