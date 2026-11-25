import { join } from "node:path"
import {
  type ExtensionAPI,
  getAgentDir,
  isBashToolResult,
  isToolCallEventType,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent"
import { DEFAULT_GIT_WRAPPERS, readGitWrappers } from "@srobroek/opencode-lib/git-wrappers"
import { loadPiOptionsFile } from "@srobroek/opencode-lib/pi-options"
import { decideCommitGate, type Refusal } from "../shared/commit-gate.js"
import { flagCleanupFollowUp, type MergeRequest, shellMerges } from "../shared/flag-cleanup.js"
import { decideMrAdvisory } from "../shared/mr-advisory.js"
import { skipCiAdvisory } from "../shared/skip-ci.js"

/** The actor cleanup beads are written as when the environment names none. */
export const PI_ACTOR = "pi/trunk-dev"

/** The options file in pi's agent directory: `{ "gitWrappers": [...] }`, read as the OpenCode option is. */
export const OPTIONS_FILE = "trunk-dev.json"

export type CommitGate = (command: string, cwd: string) => Refusal | undefined

/** Test seams; pi never passes these. */
export type Overrides = {
  commitGate?: CommitGate
  advise?: (command: string, cwd: string) => string[]
  followUp?: (merges: readonly MergeRequest[]) => Promise<string | undefined>
  /** Replaces `<agentDir>/trunk-dev.json`. */
  optionsPath?: string
}

/**
 * The block for a bash call whose commit or push breaks the policy. A gate that throws
 * allows the call, as the OpenCode adapter does.
 */
export function commitGateBlock(
  event: ToolCallEvent,
  cwd: string,
  gate: CommitGate = decideCommitGate,
): ToolCallEventResult | undefined {
  if (!isToolCallEventType("bash", event)) return undefined
  let refusal: Refusal | undefined
  try {
    refusal = gate(event.input.command, cwd)
  } catch {
    return undefined
  }
  return refusal === undefined ? undefined : { block: true, reason: `trunk-dev: ${refusal.reason}` }
}

/**
 * The notes for a bash call that exited 0: skip-CI first, then MR/PR advisories, then the
 * feature-flag cleanup follow-up for each shell merge. A failed call gets none. `gitWrappers`
 * name the commands read as git.
 */
export async function bashResultNotes(
  event: ToolResultEvent,
  cwd: string,
  overrides: Overrides = {},
  gitWrappers: readonly string[] = DEFAULT_GIT_WRAPPERS,
): Promise<string[]> {
  if (!isBashToolResult(event) || event.isError) return []
  const command: unknown = event.input.command
  if (typeof command !== "string") return []
  const notes: string[] = []
  const skip = skipCiAdvisory(command, cwd, gitWrappers)
  if (skip !== undefined) notes.push(skip)
  notes.push(...(overrides.advise ?? ((text, dir) => decideMrAdvisory(text, dir, { gitWrappers })))(command, cwd))
  const merges = shellMerges(command, cwd)
  if (merges.length > 0) {
    const followUp = overrides.followUp ?? ((found) => flagCleanupFollowUp(found, process.env, undefined, PI_ACTOR))
    const note = await followUp(merges).catch(() => undefined)
    if (note !== undefined) notes.push(note)
  }
  return notes
}

/** The result with `notes` appended as one text block; `undefined` when there are none. */
export function appendNotes(event: ToolResultEvent, notes: readonly string[]): ToolResultEventResult | undefined {
  if (notes.length === 0) return undefined
  const content = [...event.content, { type: "text" as const, text: notes.join("\n") }]
  // Returning `content` alone would drop the structured result programmatic callers read.
  return event.structuredContent === undefined ? { content } : { content, structuredContent: event.structuredContent }
}

export function createExtension(overrides: Overrides = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    const loaded = loadPiOptionsFile(
      overrides.optionsPath ?? join(getAgentDir(), OPTIONS_FILE),
      "trunk-dev",
      "only `git` is read as git",
    )
    const gitWrappers = readGitWrappers(loaded.options)
    const warning = loaded.warning
    if (warning !== undefined)
      pi.on("session_start", (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.notify(warning, "warning")
      })
    const gate = overrides.commitGate ?? ((command: string, cwd: string) => decideCommitGate(command, cwd, { gitWrappers }))
    pi.on("tool_call", (event, ctx) => commitGateBlock(event, ctx.cwd, gate))
    pi.on("tool_result", async (event, ctx) => {
      try {
        return appendNotes(event, await bashResultNotes(event, ctx.cwd, overrides, gitWrappers))
      } catch {
        // Advisories and follow-ups never fail the call they observe.
        return undefined
      }
    })
  }
}

export default createExtension()
