/**
 * parley for pi: `parley_ask`, `parley_wait` and `parley_end` with the OpenCode tool names, schemas
 * and wording. Round logic lives in `session.ts` and `shared/`; everything that touches the host's
 * terminal UI (`ctx.ui.custom()` and pi-tui) sits behind `PanelSurface` in `panel.ts`, loaded on
 * first use. Rounds are written into the session as custom entries, so they survive compaction,
 * `/reload` and a resume. Where the host cannot show the panel (print, JSON or RPC mode, or a host
 * without `ctx.ui.custom` or the pi-tui members the panel needs) `parley_ask` returns `unavailable`
 * at once. pi's own question tools are left alone.
 */

import type { JsonValue } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TSchema } from "typebox"
import { type Round, view } from "../shared/rounds.ts"
import { ASK_DESCRIPTION, askInput, END_DESCRIPTION, endInput, endOutput, resultOutput, WAIT_DESCRIPTION, waitInput } from "../shared/schema.ts"
import { findPaths, readFiles, resolvePath } from "./files.ts"
import { loadPanelSurface, newPanelState, type OpenPanel, type PanelState, type PanelSurface } from "./panel.ts"
import { type ResultOutput, toolResult } from "./result.ts"
import { type AskInput, type CallContext, type Closure, InputError, NO_UI, PiParley, type WaitInput } from "./session.ts"

/** The custom entry type that holds a round's latest state in the session. */
export const ROUND_ENTRY = "parley-round"
/** The custom message type of answers sent to the agent after its call ended. */
export const MESSAGE_TYPE = "parley"
const STATUS_KEY = "parley"

const schema = (value: object) => value as unknown as TSchema

/** The parts of a host UI context parley calls; every one may be missing on a host other than pi. */
interface HostUI {
  readonly custom?: unknown
  readonly notify?: (message: string, type?: "info" | "warning" | "error") => void
  readonly setStatus?: (key: string, text: string | undefined) => void
  readonly theme?: { fg?: (color: "warning", text: string) => string }
}

/** The notice for a round that closed without the user closing it. */
export function closureNotice(closure: Closure): { text: string; level: "info" | "warning" } | undefined {
  const { round, message } = closure
  if (round.reason === "ended") return message ? { text: message, level: "info" } : undefined
  if (round.reason === "timeout") return { text: "The parley round timed out; the agent goes on without it.", level: "warning" }
  if (round.reason === "aborted") return { text: "The parley round was cancelled: its tool call was interrupted.", level: "warning" }
  if (round.reason === NO_UI) return { text: "The parley panel could not be shown here; the agent was told.", level: "warning" }
  return undefined
}

/** The custom-entry payloads parley wrote on the session's current branch, oldest first. */
export function branchRounds(ctx: Pick<ExtensionContext, "sessionManager">): unknown[] {
  const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : []
  return branch.flatMap((entry) => (entry.type === "custom" && entry.customType === ROUND_ENTRY ? [entry.data] : []))
}

/** Whether this context can show the panel at all: pi's interactive TUI with `ctx.ui.custom`. */
const panelContext = (ctx: ExtensionContext) => ctx.mode === "tui" && typeof (ctx.ui as HostUI | undefined)?.custom === "function"

export default function parley(pi: ExtensionAPI): void {
  let session: PiParley | undefined
  /** The host UI of a context that can show the panel. */
  let ui: HostUI | undefined
  let cwd = process.cwd()
  let surface: Promise<PanelSurface | undefined> | undefined
  /** The loaded surface, once a panel context asked for it. */
  let loaded: PanelSurface | undefined
  let shown: { readonly roundID: string; panel?: OpenPanel } | undefined
  /** Card edits per open round, kept while its panel is minimised. */
  const states = new Map<string, PanelState>()

  const useSurface = async () => {
    surface ??= loadPanelSurface().catch(() => undefined)
    loaded = await surface
    return loaded
  }

  const updateStatus = () => {
    if (!ui) return
    const round = session?.current()
    const waiting = round !== undefined && shown?.roundID !== round.id
    const text = `parley: round ${round?.number} waiting · /parley`
    ui.setStatus?.(STATUS_KEY, waiting ? (ui.theme?.fg?.("warning", text) ?? text) : undefined)
  }

  const hidePanel = () => {
    const current = shown
    shown = undefined
    current?.panel?.close()
  }

  const showPanel = (round: Round) => {
    const parley = session
    if (!parley) return
    if (shown?.roundID === round.id) {
      shown.panel?.refresh()
      return
    }
    hidePanel()
    const state = states.get(round.id) ?? newPanelState()
    states.set(round.id, state)
    const base = cwd
    const current: { readonly roundID: string; panel?: OpenPanel } = { roundID: round.id }
    shown = current
    const panel = loaded?.open(ui, {
      host: {
        round: () => {
          const live = parley.rounds.get(round.id)
          return live?.status === "open" ? view(live) : undefined
        },
        submit: (answers) => parley.submit(round.id, answers),
        dismiss: () => parley.dismiss(round.id),
        readFiles: (text) => readFiles(text, base),
        findPaths: (text) => findPaths(text, base),
        now: Date.now,
      },
      state,
      label: `Parley round ${round.number} is waiting for your answers`,
      onGone: (built) => {
        if (shown === current) shown = undefined
        if (!built) parley.withdraw(round.id)
        updateStatus()
      },
    })
    if (panel === undefined) {
      if (shown === current) shown = undefined
      parley.withdraw(round.id)
      return
    }
    current.panel = panel
    updateStatus()
  }

  const closed = (closure: Closure) => {
    states.delete(closure.round.id)
    if (shown?.roundID === closure.round.id) hidePanel()
    const notice = closureNotice(closure)
    if (notice) ui?.notify?.(notice.text, notice.level)
    updateStatus()
  }

  const start = (ctx: ExtensionContext) => {
    session?.suspend()
    hidePanel()
    states.clear()
    ui = panelContext(ctx) ? (ctx.ui as HostUI) : undefined
    cwd = ctx.cwd ?? process.cwd()
    session = new PiParley({
      sessionID: typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "session",
      directory: cwd,
      // Without these the rounds still work; they just do not outlive the process.
      persist: typeof pi.appendEntry === "function" ? (round) => pi.appendEntry(ROUND_ENTRY, round) : () => {},
      deliver:
        typeof pi.sendMessage === "function"
          ? (text) => pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" })
          : () => {},
      present: showPanel,
      closed,
      disabled: process.env.PARLEY_DISABLE === "1",
    })
    session.restore(branchRounds(ctx))
    updateStatus()
    return session
  }

  /** The session for a call, and whether the call can show the panel. */
  const use = async (ctx: ExtensionContext) => {
    const parley = session ?? start(ctx)
    if (!panelContext(ctx)) return { parley, panel: false }
    ui = ctx.ui as HostUI
    return { parley, panel: (await useSurface()) !== undefined }
  }

  const call = (panel: boolean, signal: AbortSignal | undefined, report?: (text: string) => void): CallContext => ({
    ...(signal === undefined ? {} : { signal }),
    ui: panel,
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
        const { parley, panel } = await use(ctx)
        const { result, questions } = await parley.ask(input, call(panel, signal, report))
        const { content, details } = toolResult(result, questions, locate, input.format === "native" ? "native" : "parley")
        return { content, details, structuredContent: details as unknown as JsonValue }
      } catch (error) {
        if (error instanceof InputError) throw new Error(error.message)
        throw error
      }
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
      const { parley, panel } = await use(ctx)
      const { result, questions } = await parley.wait(params as WaitInput, call(panel, signal, report))
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
      const { parley } = await use(ctx)
      const result = parley.end((params as { message?: string }).message)
      return {
        content: [{ type: "text", text: result.closed > 0 ? "Parley closed." : "No open round; done." }],
        details: result,
        structuredContent: result,
      }
    },
  })

  if (typeof pi.registerCommand === "function")
    pi.registerCommand("parley", {
      description: "Show this session's open parley round",
      handler: async (_args, ctx) => {
        const { parley, panel } = await use(ctx)
        const notify = (ctx.ui as HostUI | undefined)?.notify
        if (!panel) {
          notify?.("The parley panel needs pi's interactive TUI.", "warning")
          return
        }
        const round = parley.current()
        if (round) showPanel(round)
        else notify?.("No open parley round in this session.", "info")
      },
    })
}
