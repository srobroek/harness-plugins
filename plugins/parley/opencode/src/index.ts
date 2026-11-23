import { Plugin } from "@opencode/plugin"
import type { SubmittedAnswer } from "../../shared/answers.ts"
import { render } from "../../shared/format.ts"
import { OUTBOX_KEY_PREFIX, type OutboxEntry, outboxKey } from "../../shared/outbox.ts"
import { ROUND_KEY_PREFIX, roundKey, type StoredRound } from "../../shared/persist.ts"
import type { Question } from "../../shared/questions.ts"
import { ASK_DESCRIPTION, askInput, END_DESCRIPTION, endInput, endOutput, resultOutput, WAIT_DESCRIPTION, waitInput } from "../../shared/schema.ts"
import type { Prompt } from "./fallback.ts"
import { ParleyRpc, type RoundEvent } from "./rpc.ts"
import { type AskInput, type CallContext, InputError, Parley, type RoundStore, settingsFrom, type WaitInput } from "./service.ts"
import { wrapQuestion } from "./takeover.ts"
import { markClosed, readUpload, removeUpload, saveUpload, sweepUploads } from "./uploads.ts"

export { ParleyRpc } from "./rpc.ts"

const options = { permission: "parley" } as const

/** Rounds in the plugin's own storage, one key per round. Nothing is kept when the host offers no storage. */
async function roundStore(ctx: Plugin.Context): Promise<RoundStore | undefined> {
  const storage = ctx.storage
  if (!storage) return undefined
  const directory = ctx.location.directory
  const scanValues = async (prefix: string) => {
    const entries: unknown[] = []
    let after: string | undefined
    do {
      const page = await storage.scan({ prefix, ...(after === undefined ? {} : { after }) })
      entries.push(...page.entries.map((entry) => entry.value))
      after = page.next
    } while (after !== undefined)
    return entries
  }
  return {
    directory,
    // A session of another location, one that is gone, or one the host cannot name is not ours.
    owns: async (sessionID) => (await ctx.session.get({ sessionID })).location.directory === directory,
    list: () => scanValues(ROUND_KEY_PREFIX),
    listOutbox: () => scanValues(OUTBOX_KEY_PREFIX),
    saveOutbox: (entry: OutboxEntry) => storage.set(outboxKey(entry.key), entry as never),
    removeOutbox: (key) => storage.remove(outboxKey(key)),
    save: (round: StoredRound) => storage.set(roundKey(round.id), round as never),
    remove: (roundID) => storage.remove(roundKey(roundID)),
  }
}

export default Plugin.define({
  id: "srobroek.parley",
  async setup(ctx) {
    let disposed = false
    let emitEvent: ((event: RoundEvent) => Promise<void>) | undefined
    const service = new Parley({
      settings: settingsFrom(ctx.options, process.env),
      store: await roundStore(ctx),
      save: (file, roundID) => saveUpload(file, roundID),
      closeUploads: (roundID, at) => markClosed(roundID, at),
      sweepUploads: (now) => sweepUploads(now),
      readUpload: (stored) => readUpload(stored),
      removeUpload: (stored) => removeUpload(stored),
      warn: (message) => console.warn(message),
      // A synthetic message, queued behind any running turn and waking an idle session: the user has just
      // answered, and the agent's own call died with the reload, so nothing else would tell it. The id
      // (host format `msg_...`) is fixed per message. The host admits an inbox id once and ignores a
      // retried payload (specs/v2/session.md, "Prompt Admission Precedes Execution"), so retries are safe.
      deliver: async ({ id, sessionID, text, description }) => {
        await ctx.session.synthetic({ id, sessionID, text, description, delivery: "queue", resume: true })
      },
      emit: async (event) => {
        await emitEvent?.(event).catch(() => {})
      },
      questionTool: async () => (await ctx.tool.list()).find((tool) => tool.id === "question"),
    })

    await service.restore()

    // execute.before cannot route `question` to parley: renaming a call only reaches direct (non Code
    // Mode) tools, and parley's are Code Mode tools. So the built-in tool itself is wrapped, and only
    // while a parley TUI is attached here; otherwise the registry holds the untouched built-in tool.
    let takeover: Promise<{ dispose: () => Promise<void> } | undefined> = Promise.resolve(undefined)
    const syncTakeover = () => {
      if (disposed) return
      takeover = takeover.then(async (current) => {
        if (disposed) {
          await current?.dispose()
          return undefined
        }
        const wanted = service.takeoverWanted()
        if (wanted && !current) {
          const handle = await ctx.tool.transform((editor) =>
            editor.update("question", (draft) => {
              draft.execute = wrapQuestion(
                draft.execute,
                (input, context) => service.takeover(input as { questions?: Prompt[] }, call(context)),
                (context) => void service.handedToBuiltin(context.sessionID, context.id),
              )
            }),
          )
          if (disposed) {
            await handle.dispose()
            return undefined
          }
          return handle
        }
        if (!wanted && current) await current.dispose()
        return wanted ? current : undefined
      }, () => undefined)
      return takeover
    }

    const rpc = await ctx.rpc.register(ParleyRpc, {
      attach: async (input) => {
        const result = service.attach(input as { clientID: string; sessionIDs?: string[]; detach?: boolean })
        void syncTakeover()
        return result
      },
      pending: async (input) => service.pending((input ?? {}) as { sessionID?: string }),
      submit: async (input) =>
        service.submit(input as { roundID: string; sessionID?: string; answers: SubmittedAnswer[]; final?: boolean }),
      cancel: async (input) => service.cancel(input as { roundID: string; reason?: string }),
      deliver: async (input) =>
        service.deliver(
          input as {
            sessionID: string
            number?: number
            questions: Question[]
            answers: SubmittedAnswer[]
            deliveryID?: string
            roundID?: string
          },
        ),
    })
    emitEvent = (event) => rpc.events.emit("round", { ...event })

    const call = (context: { sessionID: string; id: string; signal: AbortSignal; progress: CallContext["progress"] }) => ({
      sessionID: context.sessionID,
      callID: context.id,
      signal: context.signal,
      progress: context.progress,
      tool: context,
    })

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "parley_ask",
        description: ASK_DESCRIPTION,
        input: askInput,
        output: resultOutput,
        options,
        execute: async (input, context) => {
          try {
            const { result, questions } = await service.ask(input as AskInput, call(context))
            return render(result, questions, (file) => service.saveUpload(file, result.round_id), (input as AskInput).format === "native" ? "native" : "parley")
          } catch (error) {
            if (error instanceof InputError) throw new Error(error.message)
            throw error
          }
        },
      })
      editor.add({
        name: "parley_wait",
        description: WAIT_DESCRIPTION,
        input: waitInput,
        output: resultOutput,
        options,
        execute: async (input, context) => {
          const { result, questions } = await service.wait(input as WaitInput, call(context))
          return render(result, questions, (file) => service.saveUpload(file, result.round_id))
        },
      })
      editor.add({
        name: "parley_end",
        description: END_DESCRIPTION,
        input: endInput,
        output: endOutput,
        options,
        execute: async (input, context) => {
          const result = await service.end(context.sessionID, (input as { message?: string }).message)
          return { output: result, content: result.closed > 0 ? "Parley closed." : "No open round; done." }
        },
      })
    })

    const sweep = setInterval(() => service.sweep(), 5 * 60_000)
    sweep.unref?.()
    const presence = setInterval(() => void syncTakeover(), 15_000)
    presence.unref?.()

    return () => {
      clearInterval(sweep)
      clearInterval(presence)
      disposed = true
      // Waiting calls end and their last writes finish, within a bound, before the next instance restores.
      const drained = service.suspend()
      void takeover.then((current) => current?.dispose()).catch(() => {})
      void tools.dispose().catch(() => {})
      void rpc.dispose().catch(() => {})
      return drained
    }
  },
})
