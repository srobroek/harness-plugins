// The Pi pr-reviewer reads untrusted pull request content, so this gate holds it to the same
// surface as its OpenCode allowlist: the two `gh` reads its prompt names, one command per call,
// and `read` of the skill files pi-subagents gives the child. Every other bash command and every
// other read is refused. The gate acts only in a pr-reviewer child session; the agent's `tools`
// list already keeps every other tool away from it.

import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isPiChildAgent } from "@srobroek/opencode-lib/pi-child-agent"

export const PR_REVIEWER = "pr-reviewer"

const NUMBER = "[1-9][0-9]*"
const REPO = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
const FIELDS = "[A-Za-z]+(?:,[A-Za-z]+)*"

/** The only commands the agent may run, whole: no operator, redirection, substitution or second line fits. */
const FORGE_READS: readonly RegExp[] = [
  new RegExp(`^gh pr view ${NUMBER} --repo ${REPO} --json ${FIELDS}$`),
  new RegExp(`^gh pr diff ${NUMBER} --repo ${REPO}$`),
]

export const COMMAND_REASON =
  "blocked by agent-reviewer: pr-reviewer runs only `gh pr view <number> --repo <owner>/<name> --json <fields>` " +
  "and `gh pr diff <number> --repo <owner>/<name>`, one command per call. Report anything else as an evidence gap."

export const READ_REASON =
  "blocked by agent-reviewer: pr-reviewer reads only the skill files listed in its prompt, never repository " +
  "or other local files. Review from the two gh reads."

export type ToolCallLike = { toolName: string; input: unknown }

/** Resolves a path to its canonical form; throws when it cannot, like `fs.realpathSync`. */
export type Realpath = (target: string) => string

/** The directories of the skills pi-subagents lists in a child's system prompt. */
export function skillDirectories(systemPrompt: string): string[] {
  const block = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(systemPrompt)?.[1] ?? ""
  return [...block.matchAll(/<location>([^<]+)<\/location>/g)]
    .map((match) => (match[1] as string).trim())
    .filter((location) => path.isAbsolute(location))
    .map((location) => path.dirname(path.normalize(location)))
}

/** A read path as Pi's read tool resolves it: a leading `@` dropped, `~` expanded, relative to `cwd`. */
function resolveReadPath(value: string, cwd: string, home: string): string {
  const bare = value.startsWith("@") ? value.slice(1) : value
  const expanded = bare === "~" ? home : bare.startsWith("~/") ? path.join(home, bare.slice(2)) : bare
  return path.resolve(cwd, expanded)
}

/** `target` within `dir` once both are canonical, so a symlink inside a skill directory cannot reach outside it. */
function within(target: string, dir: string, realpath: Realpath): boolean {
  try {
    const real = realpath(dir)
    return target === real || target.startsWith(`${real}${path.sep}`)
  } catch {
    return false
  }
}

/**
 * Why the gate refuses a pr-reviewer tool call, or `undefined` when the call is within its surface.
 * A read whose target cannot be resolved (missing, unreadable) is refused.
 */
export function prReviewerBlockReason(
  event: ToolCallLike,
  systemPrompt: string,
  cwd: string,
  home = homedir(),
  realpath: Realpath = realpathSync,
): string | undefined {
  const input = event.input !== null && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {}
  if (event.toolName === "bash") {
    const command = typeof input.command === "string" ? input.command.trim() : ""
    return FORGE_READS.some((read) => read.test(command)) ? undefined : COMMAND_REASON
  }
  if (event.toolName === "read") {
    if (typeof input.path !== "string") return READ_REASON
    let target: string
    try {
      target = realpath(resolveReadPath(input.path, cwd, home))
    } catch {
      return READ_REASON
    }
    return skillDirectories(systemPrompt).some((dir) => within(target, dir, realpath)) ? undefined : READ_REASON
  }
  return undefined
}

/**
 * Registers the gate. It matches the child by pi-subagents' `<active_agent>` prompt tag only, not by
 * session name: OMP loads this bundle too and may name a child session after its agent, and there
 * the gate must stay inert, since OMP's pr-reviewer reads through its `github` tool.
 */
export default function registerPrReviewerGate(pi: Pick<ExtensionAPI, "on">): void {
  pi.on("tool_call", (event, ctx) => {
    const header = ctx.sessionManager?.getHeader?.() as { parentSession?: unknown } | undefined
    const prompt = ctx.getSystemPrompt?.() ?? ""
    if (!isPiChildAgent(PR_REVIEWER, prompt, undefined, typeof header?.parentSession === "string")) return
    const reason = prReviewerBlockReason(event, prompt, ctx.cwd)
    return reason ? { block: true, reason } : undefined
  })
}
