/**
 * parley for pi: `parley_ask`, `parley_wait` and `parley_end` with the OpenCode tool names, schemas
 * and wording, and the round panel shown with `ctx.ui.custom()` in place of the editor. Rounds are
 * written into the session as custom entries, so they survive compaction, `/reload` and a resume.
 * Without pi's interactive TUI (print, JSON or RPC mode) `parley_ask` returns `unavailable` at once.
 * pi's own question tools are left alone.
 */

import type { JsonValue } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import type { TSchema } from "typebox"
import { type Round, view } from "../shared/rounds.ts"
import { ASK_DESCRIPTION, askInput, END_DESCRIPTION, endInput, endOutput, resultOutput, WAIT_DESCRIPTION, waitInput } from "../shared/schema.ts"
import { findPaths, readFiles, resolvePath } from "./files.ts"
import { newPanelState, type PanelState, ParleyPanel } from "./panel.ts"
import { type ResultOutput, toolResult } from "./result.ts"
import { type AskInput, type CallContext, type Closure, InputError, PiParley, type WaitInput } from "./session.ts"

/** The custom entry type that holds a round's latest state in the session. */
export const ROUND_ENTRY = "parley-round"
/** The custom message type of answers sent to the agent after its call ended. */
export const MESSAGE_TYPE = "parley"
const STATUS_KEY = "parley"

const schema = (value: object) => value as unknown as TSchema

/** The notice for a round that closed without the user closing it. */
export function closureNotice(closure: Closure): { text: string; level: "info" | "warning" } | undefined {
  const { round, message } = closure
  if (round.reason === "ended") return message ? { text: message, level: "info" } : undefined
  if (round.reason === "timeout") return { text: "The parley round timed out; the agent goes on without it.", level: "warning" }
  if (round.reason === "aborted") return { text: "The parley round was cancelled: its tool call was interrupted.", level: "warning" }
  return undefined
}

/** The custom-entry payloads parley wrote on the session's current branch, oldest first. */
export function branchRounds(ctx: Pick<ExtensionContext, "sessionManager">): unknown[] {
  return ctx.sessionManager
    .getBranch()
    .flatMap((entry) => (entry.type === "custom" && entry.customType === ROUND_ENTRY ? [entry.data] : []))
}

interface Slot {
  readonly roundID: string
  panel?: ParleyPanel
  close?: () => void
  closing: boolean
}

export default function parley(pi: ExtensionAPI): void {
  let session: PiParley | undefined
  /** pi's interactive UI, when this session has one. */
  let ui: ExtensionUIContext | undefined
  let cwd = process.cwd()
  let slot: Slot | undefined
  /** Card edits per open round, kept while its panel is minimised. */
  const states = new Map<string, PanelState>()

  const updateStatus = () => {
    if (!ui) return
    const round = session?.current()
    const waiting = round !== undefined && slot?.roundID !== round.id
    ui.setStatus(STATUS_KEY, waiting ? ui.theme.fg("warning", `parley: round ${round.number} waiting · /parley`) : undefined)
  }

  const hidePanel = () => {
    const current = slot
    slot = undefined
    if (!current) return
    current.closing = true
    current.close?.()
  }

  const showPanel = (round: Round) => {
    const host = ui
    const parley = session
    if (!host || !parley) return
    if (slot?.roundID === round.id) {
      slot.panel?.refresh()
      return
    }
    hidePanel()
    const current: Slot = { roundID: round.id, closing: false }
    slot = current
    const state = states.get(round.id) ?? newPanelState()
    states.set(round.id, state)
    const base = cwd
    void host
      .custom<void>(
        (tui, theme, _keybindings, done) => {
          current.close = () => done()
          const panel = new ParleyPanel(
            tui,
            theme,
            {
              round: () => {
                const live = parley.rounds.get(round.id)
                return live?.status === "open" ? view(live) : undefined
              },
              submit: (answers) => parley.submit(round.id, answers),
              dismiss: () => parley.dismiss(round.id),
              minimise: () => done(),
              readFiles: (text) => readFiles(text, base),
              findPaths: (text) => findPaths(text, base),
              now: Date.now,
            },
            state,
          )
          current.panel = panel
          // Closed before pi built the panel: finish as soon as it is shown.
          if (current.closing) queueMicrotask(() => done())
          return panel
        },
        { blocked: { kind: "question", message: `Parley round ${round.number} is waiting for your answers` } },
      )
      .catch(() => undefined)
      .finally(() => {
        if (slot === current) slot = undefined
        updateStatus()
      })
    updateStatus()
  }

  const closed = (closure: Closure) => {
    states.delete(closure.round.id)
    if (slot?.roundID === closure.round.id) hidePanel()
    const notice = closureNotice(closure)
    if (notice) ui?.notify(notice.text, notice.level)
    updateStatus()
  }

  const start = (ctx: ExtensionContext) => {
    session?.suspend()
    hidePanel()
    states.clear()
    ui = ctx.mode === "tui" ? ctx.ui : undefined
    cwd = ctx.cwd
    session = new PiParley({
      sessionID: ctx.sessionManager.getSessionId(),
      directory: ctx.cwd,
      persist: (round) => pi.appendEntry(ROUND_ENTRY, round),
      deliver: (text) => pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" }),
      present: showPanel,
      closed,
      disabled: process.env.PARLEY_DISABLE === "1",
    })
    session.restore(branchRounds(ctx))
    updateStatus()
    return session
  }

  const use = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") ui = ctx.ui
    return session ?? start(ctx)
  }

  const call = (ctx: ExtensionContext, signal: AbortSignal | undefined, report?: (text: string) => void): CallContext => ({
    ...(signal === undefined ? {} : { signal }),
    ui: ctx.mode === "tui",
    ...(report === undefined
      ? {}
      : { progress: (round, answered, total) => report(`Parley round ${round.number}: ${answered}/${total} answered in the parley panel`) }),
  })

  const locate = (file: { path?: string }) => (file.path === undefined ? undefined : resolvePath(file.path, cwd))

  pi.on("session_start", (_event, ctx) => {
    start(ctx)
  })
  // /tree moved to another branch: its rounds are the ones that count now.
  pi.on("session_tree", (_event, ctx) => {
    start(ctx)
  })
  pi.on("session_shutdown", () => {
    session?.suspend()
    hidePanel()
    session = undefined
  })

  pi.registerTool<TSchema, ResultOutput | undefined>({
    name: "parley_ask",
    label: "Parley",
    description: ASK_DESCRIPTION,
    parameters: schema(askInput),
    outputSchema: schema(resultOutput),
    async execute(_id, params, signal, onUpdate, ctx) {
      const input = params as AskInput
      const report = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: undefined })
      try {
        const { result, questions } = await use(ctx).ask(input, call(ctx, signal, report))
        const { content, details } = toolResult(result, questions, locate, input.format === "native" ? "native" : "parley")
        return { content, details, structuredContent: details as unknown as JsonValue }
      } catch (error) {
        if (error instanceof InputError) throw new Error(error.message)
        throw error
      }
    },
    renderCall(args, theme) {
      const questions = (args as { questions?: { id?: unknown }[] }).questions ?? []
      const ids = questions.map((question) => String(question.id ?? "?")).join(", ")
      return new Text(`${theme.fg("toolTitle", theme.bold("parley_ask "))}${theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`)}${ids ? theme.fg("dim", ` (${ids})`) : ""}`, 0, 0)
    },
  })

  pi.registerTool<TSchema, ResultOutput | undefined>({
    name: "parley_wait",
    label: "Parley wait",
    description: WAIT_DESCRIPTION,
    parameters: schema(waitInput),
    outputSchema: schema(resultOutput),
    async execute(_id, params, signal, onUpdate, ctx) {
      const report = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: undefined })
      const { result, questions } = await use(ctx).wait(params as WaitInput, call(ctx, signal, report))
      const { content, details } = toolResult(result, questions, locate)
      return { content, details, structuredContent: details as unknown as JsonValue }
    },
  })

  pi.registerTool<TSchema, { ok: boolean; closed: number }>({
    name: "parley_end",
    label: "Parley end",
    description: END_DESCRIPTION,
    parameters: schema(endInput),
    outputSchema: schema(endOutput),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = use(ctx).end((params as { message?: string }).message)
      return {
        content: [{ type: "text", text: result.closed > 0 ? "Parley closed." : "No open round; done." }],
        details: result,
        structuredContent: result,
      }
    },
  })

  pi.registerCommand("parley", {
    description: "Show this session's open parley round",
    handler: async (_args, ctx) => {
      const parley = use(ctx)
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The parley panel needs pi's interactive TUI.", "warning")
        return
      }
      const round = parley.current()
      if (round) showPanel(round)
      else ctx.ui.notify("No open parley round in this session.", "info")
    },
  })
}
