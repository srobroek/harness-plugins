/**
 * The autopilot plugin on pi: the run machine of `shared/autopilot.ts` over a pi host. It
 * registers the OpenCode tool names and schemas (except `autopilot_review`), the `/autopilot`
 * command and the gates pi has hooks for. What pi lacks is in the README's pi section.
 *
 * pi runs one session per extension runtime, so the host speaks for the current session only:
 * it prompts that session, ticks it with the in-process timer and reads its own messages. Armed
 * runs and review records live in file storage that every pi process shares, so a subagent
 * child that loads this extension finds its lead's run through its session headers.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Warn } from "@srobroek/opencode-lib/host-log"
import { readSessionHeader, type SessionHeaderView } from "@srobroek/opencode-lib/pi-session-header"
import { Autopilot, type AutopilotHost, type Deps, type HostStorage, type PermissionEvaluation } from "../shared/autopilot.ts"
import { LOG_INPUT_SCHEMA } from "../shared/journal.ts"
import { isAskTool } from "../shared/policy.ts"
import {
  COMMAND_DESCRIPTION,
  EXPORT_REVIEW_DESCRIPTION,
  EXPORT_REVIEW_INPUT,
  type ExportReviewInput,
  LOG_DESCRIPTION,
  MERGE_DESCRIPTION,
  MERGE_INPUT,
  type MergeInput,
  STATUS_INPUT,
  type StatusInput,
  TIMER_STATUS_DESCRIPTION,
} from "../shared/tools.ts"
import { fileStorage, storageDir } from "./storage.ts"

/** The custom message type of the plugin's notices (re-prompt, compaction). */
export const MESSAGE_TYPE = "autopilot"

/** What the setup prompt says to do without parley: pi has no question tool. */
export const ASK_FALLBACK = "without parley, ask them all in one message and end the turn until the user answers"

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Seams for tests; production passes none. */
export type AutopilotPiDeps = Deps & {
  storage?: HostStorage
  readHeader?: (file: string) => SessionHeaderView | undefined
}

/** The session id of a context. */
const sessionOf = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId()

/**
 * Send `text` as a user prompt. Always as a follow-up: pi counts a session as processing while a
 * command or another prompt is being handled even when `isIdle()` says idle, and rejects a plain
 * send then; an idle session takes a follow-up at once.
 */
const sendPrompt = (pi: ExtensionAPI, text: string) => pi.sendUserMessage(text, { deliverAs: "followUp" })

/**
 * The host over the current pi session. `current` is the context of the latest event in this
 * runtime; `authorize` is the plugin's own permission check, since pi has no permission rules.
 */
export function piHost(input: {
  pi: ExtensionAPI
  current: () => ExtensionContext | undefined
  storage: HostStorage
  readHeader: (file: string) => SessionHeaderView | undefined
  authorize: AutopilotHost["authorize"]
}): AutopilotHost {
  const { pi, current, readHeader } = input
  /** Session files learned while walking parent headers, by session id. */
  const files = new Map<string, string>()
  /** The current context when `sessionID` is the current session. */
  const own = (sessionID: string): ExtensionContext | undefined => {
    const ctx = current()
    return ctx !== undefined && sessionOf(ctx) === sessionID ? ctx : undefined
  }
  const elsewhere = (sessionID: string) => new Error(`session ${sessionID} is not the one this pi process runs`)
  return {
    profile: { ticks: "timer", askFallback: ASK_FALLBACK },
    storage: input.storage,
    get directory() {
      return current()?.cwd ?? process.cwd()
    },
    async parentOf(sessionID) {
      const ctx = own(sessionID)
      let parentFile: string | undefined
      if (ctx !== undefined) parentFile = ctx.sessionManager.getHeader()?.parentSession
      else {
        const file = files.get(sessionID)
        const header = file === undefined ? undefined : readHeader(file)
        // A session this process has not walked to, or whose file is unreadable, has an unknown parent.
        if (header === undefined || header.id !== sessionID) return undefined
        parentFile = header.parentSession
      }
      if (parentFile === undefined || parentFile === "") return null
      const parent = readHeader(parentFile)
      if (parent === undefined) return undefined
      files.set(parent.id, parentFile)
      return parent.id
    },
    directoryOf: async (sessionID) => own(sessionID)?.cwd,
    busy: async (sessionID) => {
      const ctx = own(sessionID)
      return ctx !== undefined && !ctx.isIdle()
    },
    // pi lists no child sessions to an extension; see the README.
    children: async () => ({ sessions: [], complete: false }),
    messages: async (sessionID) => {
      const ctx = own(sessionID)
      if (ctx === undefined) throw elsewhere(sessionID)
      return ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
    },
    prompt: async (sessionID, text) => {
      const ctx = own(sessionID)
      if (ctx === undefined) throw elsewhere(sessionID)
      sendPrompt(pi, text)
    },
    notify: async ({ sessionID, text, delivery, metadata }) => {
      if (own(sessionID) === undefined) throw elsewhere(sessionID)
      pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true, details: metadata }, { triggerTurn: true, deliverAs: delivery === "steer" ? "steer" : "followUp" })
    },
    authorize: input.authorize,
    // pi has no worktree API and no directory permission for a recorded lane root to open.
    worktrees: async () => ({ listed: new Set(), primary: new Set() }),
    hosts: (sessionID) => own(sessionID) !== undefined,
  }
}

/** A tool result: the text the model reads, and the same value as details. */
const result = (text: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text }], details })

export function setupAutopilotPi(pi: ExtensionAPI, deps: AutopilotPiDeps = {}): Autopilot {
  let current: ExtensionContext | undefined
  /** Why storage could not be read at start; while set, the ask gate fails closed. */
  let unavailable: string | undefined
  const warn: Warn =
    deps.warn ??
    ((message, data) => {
      const text = `autopilot: ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`
      if (current?.hasUI) current.ui.notify(text, "warning")
      else console.warn(text)
    })
  const track = (ctx: ExtensionContext) => {
    current = ctx
  }

  /**
   * pi has no permission rules, so the run decides as OpenCode's hook decides an `ask`: a running
   * run allows what its grants cover and denies (and journals) the rest. Outside a run the user
   * is asked, and a session that cannot show a dialog is refused.
   */
  const authorize: AutopilotHost["authorize"] = async ({ sessionID, action, resources }) => {
    const event: PermissionEvaluation = { sessionID, action, resources, effect: "ask" }
    await pilot.evaluate(event)
    if (event.effect === "allow") return
    if (event.effect === "deny") throw new Error(event.message ?? `autopilot denied ${action}`)
    const ctx = current
    const asked = `${action} on ${resources.join(" ")}`
    if (ctx === undefined || !ctx.hasUI) throw new Error(`${asked} needs the user's approval, and this session cannot show a dialog`)
    if (!(await ctx.ui.confirm("autopilot: approve?", asked))) throw new Error(`the user declined ${asked}`)
  }

  const host = piHost({ pi, current: () => current, storage: deps.storage ?? fileStorage(storageDir()), readHeader: deps.readHeader ?? readSessionHeader, authorize })
  const pilot = new Autopilot(host, { ...deps, warn })

  /** Read the armed runs again: another pi process (the lead of a subagent child) may have armed one since start. */
  const refreshed = async (): Promise<string | undefined> => {
    try {
      await pilot.refresh()
      unavailable = undefined
      return undefined
    } catch (error) {
      return `autopilot could not read its storage, so it cannot tell whether a run is armed (${errorText(error)})`
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    track(ctx)
    try {
      await pilot.load()
      unavailable = undefined
    } catch (error) {
      unavailable = `autopilot could not read its storage at start (${errorText(error)})`
      warn(unavailable)
    }
  })

  pi.on("session_shutdown", () => {
    pilot.dispose()
    current = undefined
  })

  pi.on("tool_call", async (event, ctx) => {
    track(ctx)
    if (!isAskTool(event.toolName)) return undefined
    // Fail closed: without the armed runs, an ask may belong to an unattended run.
    const failure = (await refreshed()) ?? unavailable
    if (failure !== undefined) return { block: true, reason: failure }
    try {
      await pilot.beforeTool(event.toolName, sessionOf(ctx))
      return undefined
    } catch (error) {
      return { block: true, reason: errorText(error) }
    }
  })

  pi.on("ui_prompt_start", async (event, ctx) => {
    track(ctx)
    const failure = await refreshed()
    if (failure !== undefined) return warn(failure)
    await pilot.dialogWaiting(sessionOf(ctx), event.title ? `${event.kind}: ${event.title}` : event.kind).catch((error: unknown) => warn("dialog record failed", { error: errorText(error) }))
  })

  pi.on("agent_settled", async (event, ctx) => {
    track(ctx)
    // An aborted turn was stopped by someone at the keyboard, who can answer for themselves.
    if (event.aborted) return
    await pilot.idle(sessionOf(ctx)).catch((error: unknown) => warn("idle hook failed", { error: errorText(error) }))
  })

  pi.on("session_compact", async (_event, ctx) => {
    track(ctx)
    await pilot.compacted(sessionOf(ctx)).catch((error: unknown) => warn("compaction recovery failed", { error: errorText(error) }))
  })

  pi.registerCommand("autopilot", {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      track(ctx)
      const text = await pilot.command(sessionOf(ctx), args)
      sendPrompt(pi, text)
    },
  })

  pi.registerTool({
    name: "autopilot_status",
    label: "Autopilot status",
    description: TIMER_STATUS_DESCRIPTION,
    parameters: STATUS_INPUT,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      track(ctx)
      const output = await pilot.status(sessionOf(ctx), params as StatusInput)
      return result(JSON.stringify(output, null, 2), output)
    },
  })
  pi.registerTool({
    name: "autopilot_log",
    label: "Autopilot log",
    description: LOG_DESCRIPTION,
    parameters: LOG_INPUT_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      track(ctx)
      return result(await pilot.log(sessionOf(ctx), params))
    },
  })
  pi.registerTool({
    name: "autopilot_merge",
    label: "Autopilot merge",
    description: MERGE_DESCRIPTION,
    parameters: MERGE_INPUT,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      track(ctx)
      return result(await pilot.merge(sessionOf(ctx), params as MergeInput))
    },
  })
  pi.registerTool({
    name: "autopilot_export_review",
    label: "Autopilot export review",
    description: EXPORT_REVIEW_DESCRIPTION,
    parameters: EXPORT_REVIEW_INPUT,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      track(ctx)
      return result(await pilot.exportReview(sessionOf(ctx), params as ExportReviewInput))
    },
  })
  return pilot
}

export default function (pi: ExtensionAPI): void {
  setupAutopilotPi(pi)
}
