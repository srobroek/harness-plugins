/**
 * The modes extension for pi. It guards the `debug`, `refactor` and `concept` agents that pi-subagents
 * launches (each loads this file through `subagentOnlyExtensions`) and adds `/mode`, which puts the
 * main session in one of those roles. Every decision is in `policy.ts`; this file reads the session,
 * keeps `/mode`'s state on the branch, and applies verdicts. OMP copies the bundle too, so it imports
 * only types from the host packages.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TSchema } from "typebox"
import { headRefusal } from "../opencode/src/head-guard.ts"
import {
  type AgentId,
  branchMode,
  childMode,
  decideToolCall,
  enterReminder,
  leaveReminder,
  MODE_CHOICES,
  type ModeState,
  readState,
  STATUS_TOOL,
  statusText,
  switchMode,
} from "./policy.ts"

export * from "./policy.ts"

/** The custom entry type `/mode` appends; the last one on the branch is the main session's mode. */
export const STATE_ENTRY = "modes"

/** OMP also loads pi extensions, but its edit tool and task agents differ, so modes stays prompt-only there. */
export function isOmpHost(pi: ExtensionAPI): boolean {
  return (pi as ExtensionAPI & { runtime?: unknown }).runtime !== undefined
}

/** The role instructions for `mode` in the main session: the body of its shipped agent file. */
export type RoleText = (mode: AgentId) => string

const shippedRole: RoleText = (mode) =>
  readFileSync(fileURLToPath(new URL(`../agents/${mode}.md`, import.meta.url)), "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .trim()

/** Test seams; the host never passes them. */
export type Overrides = {
  role?: RoleText
  /** Why a mutating git command may not run in `workdir`; defaults to reading HEAD with git. */
  headCheck?: (workdir: string) => Promise<string | undefined>
  home?: string
}

/** Whether the session has a parent; a host without session headers reads as none, so only the prompt tag names a child mode. */
function hasParent(ctx: ExtensionContext): boolean {
  try {
    return typeof ctx.sessionManager.getHeader()?.parentSession === "string"
  } catch {
    return false
  }
}

export function registerModes(pi: ExtensionAPI, overrides: Overrides = {}): void {
  const role = overrides.role ?? shippedRole
  const headCheck = overrides.headCheck ?? ((workdir: string) => headRefusal(workdir))
  const home = overrides.home ?? homedir()
  let state: ModeState = {}
  /** Reminders for the next turn of the main session. */
  let pending: string[] = []

  /** A child launched as a mode agent runs as that mode; otherwise the main session's `/mode` decides. */
  const activeMode = (ctx: ExtensionContext): { mode?: AgentId; child: boolean } => {
    const child = childMode(ctx.getSystemPrompt() ?? "", pi.getSessionName(), hasParent(ctx))
    return child === undefined ? { mode: state.mode, child: false } : { mode: child, child: true }
  }

  const entering = (mode: AgentId): string => {
    try {
      return `${enterReminder(mode)}\n\n${role(mode)}`
    } catch {
      return enterReminder(mode)
    }
  }

  // Registered before the OMP check: mode agents list it, so a child that lost this extension fails at launch.
  const omp = isOmpHost(pi)
  pi.registerTool({
    name: STATUS_TOOL,
    label: "Mode status",
    description: "Show the active mode, its tools and where it may write, with the scratch paths spelled out.",
    parameters: { type: "object", properties: {}, additionalProperties: false } as unknown as TSchema,
    defaultActive: false,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return { content: [{ type: "text", text: statusText(activeMode(ctx).mode, { cwd: ctx.cwd, home }, { omp }) }], details: {} }
    },
  })
  if (omp) return

  /** The `/mode` states recorded on `entries`, oldest first. */
  const states = (entries: readonly { type: string; customType?: string; data?: unknown }[]) =>
    entries.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY).map((entry) => readState(entry.data))

  /**
   * Bring the mode in line with the branch now active. The state being left is the one in memory, or,
   * for a fresh extension instance, the last `/mode` entry on the old branch; snapshots come from the
   * session file, so they survive a reload.
   */
  const restore = (ctx: ExtensionContext, oldLeafId?: string | null) => {
    const target = states(ctx.sessionManager.getBranch()).at(-1) ?? {}
    const left = state.mode !== undefined || !oldLeafId ? state : (states(ctx.sessionManager.getBranch(oldLeafId)).at(-1) ?? {})
    const earliest = states(ctx.sessionManager.getEntries()).find((recorded) => recorded.saved !== undefined)?.saved
    const next = branchMode(target, left, earliest)
    if (next.tools !== undefined) pi.setActiveTools([...next.tools])
    state = next.state
    pending = state.mode === undefined ? [] : [entering(state.mode)]
  }

  pi.on("session_start", (_event, ctx) => restore(ctx))
  pi.on("session_tree", (event, ctx) => restore(ctx, event.oldLeafId))
  pi.on("session_compact", () => {
    if (state.mode !== undefined) pending = [entering(state.mode)]
  })

  pi.on("before_agent_start", () => {
    if (pending.length === 0) return
    const content = pending.join("\n\n")
    pending = []
    return { message: { customType: STATE_ENTRY, content, display: false } }
  })

  pi.registerCommand("mode", {
    description: "Work as debug, refactor or concept with its tools and guard; /mode off leaves",
    getArgumentCompletions: (prefix) => {
      const items = MODE_CHOICES.filter((choice) => choice.startsWith(prefix.trim())).map((value) => ({ value, label: value }))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => {
      const choice = args.trim()
      if (choice === "") {
        ctx.ui.notify(state.mode === undefined ? "No mode is active. Use /mode debug|refactor|concept." : `Mode: ${state.mode}. Leave with /mode off.`, "info")
        return
      }
      const next = switchMode(state, choice, pi.getActiveTools())
      if (next === undefined) {
        ctx.ui.notify(`Unknown mode "${choice}". Use /mode ${MODE_CHOICES.join("|")}.`, "error")
        return
      }
      if (next.tools !== undefined) pi.setActiveTools([...next.tools])
      pending = [...(next.left === undefined ? [] : [leaveReminder(next.left)]), ...(next.entered === undefined ? [] : [entering(next.entered)])]
      if (next.state !== state) pi.appendEntry(STATE_ENTRY, next.state)
      state = next.state
      ctx.ui.notify(next.notice, "info")
    },
  })

  pi.on("tool_call", async (event, ctx) => {
    // Until the session's mode is known, a failure refuses: this session may be a mode agent's child.
    let active: { mode?: AgentId; child: boolean } = { child: true }
    try {
      active = activeMode(ctx)
      const { mode, child } = active
      if (mode === undefined) return
      const verdict = decideToolCall(mode, event.toolName, event.input, { cwd: ctx.cwd, home })
      if (verdict.effect === "deny") return { block: true, reason: verdict.reason }
      if (verdict.effect === "ask") {
        if (!child && ctx.hasUI && (await ctx.ui.confirm(`${mode} mode`, `${verdict.reason}. Allow this call?`))) return
        return { block: true, reason: `${verdict.reason}; ${child ? "a subagent cannot ask the user" : "the user did not approve it"}` }
      }
      if (verdict.effect === "allow" && verdict.headCheck !== undefined) {
        const refusal = await headCheck(verdict.headCheck)
        if (refusal !== undefined) return { block: true, reason: refusal }
      }
    } catch (error) {
      if (active.child || active.mode !== undefined) {
        return { block: true, reason: `the modes guard failed (${(error as Error).message}), so the call is refused` }
      }
    }
  })
}

export default function modes(pi: ExtensionAPI): void {
  registerModes(pi)
}
