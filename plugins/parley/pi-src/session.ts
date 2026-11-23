/**
 * Parley for one pi session: the rounds, the tool calls that wait on them, their persistence in the
 * session file and the message that carries answers no call is left to return. It knows nothing of
 * pi itself; `parley.ts` wires it to the extension API and the panel.
 */

import type { Answer, FileValue, SubmittedAnswer } from "../shared/answers.ts"
import { baseMime, fileNote, summarise } from "../shared/format.ts"
import { isRecord } from "../shared/guards.ts"
import { CLOSED_TTL_MS, fromStored, type StoredRound, stale, toStored } from "../shared/persist.ts"
import { coerceQuestion, type Question, validateQuestions } from "../shared/questions.ts"
import {
  collect,
  holdsDeadline,
  RELOADED_REASON,
  type Round,
  type RoundResult,
  Rounds,
  rekey,
  sameQuestions,
  TIMEOUT,
  timeoutSeconds,
  type WaitMode,
  waitFor,
} from "../shared/rounds.ts"

/** The `unavailable` reason when this pi mode has no panel (print, JSON or RPC mode). */
export const NO_UI = "no_tui"

const DELIVERY_HEAD: Record<"submitted" | "cancelled", string> = {
  submitted:
    "Your parley call ended before the user answered (pi quit or left the session while you waited). The user answered that round afterwards; their answers follow. Act on them; do not ask these questions again.",
  cancelled:
    "Your parley call ended before the user answered (pi quit or left the session while you waited). The user then dismissed that round; go on with your recommendations for its questions, or ask again only if an answer matters.",
}

export class InputError extends Error {}

export interface AskInput {
  readonly questions: readonly Question[]
  readonly title?: string
  readonly round?: number
  readonly wait?: WaitMode
  readonly timeout_s?: number
  readonly format?: "native" | "parley"
}

export interface WaitInput {
  readonly wait?: "all" | "any"
  readonly ids?: readonly string[]
  readonly timeout_s?: number
}

export interface CallContext {
  readonly signal?: AbortSignal
  /** Whether this pi mode can show the panel. */
  readonly ui: boolean
  /** Reports how far the round is, while the call waits. */
  readonly progress?: (round: Round, answered: number, total: number) => void
}

export interface Result extends RoundResult {
  readonly channel?: "tui"
}

/** Why a round closed, for the notice the user sees. */
export type Closure = { readonly round: Round; readonly message?: string }

export interface Deps {
  readonly sessionID: string
  /** The session's working directory, recorded with each stored round. */
  readonly directory: string
  /** Writes a round's latest state into the session, where it outlives compaction, a reload and a resume. */
  readonly persist: (round: StoredRound) => void
  /** Sends text to the session's agent and wakes it: answers that no waiting call can return. */
  readonly deliver: (text: string) => void
  /** Shows the round's panel, or brings it up to date when it already shows. */
  readonly present: (round: Round) => void
  /** A round closed: take its panel down and tell the user why when that is news to them. */
  readonly closed: (closure: Closure) => void
  readonly disabled?: boolean
  readonly now?: () => number
}

type Ask = { result: Result; questions: readonly Question[] }

const unavailable = (reason: string): Result => ({ status: "unavailable", reason, answers: [], pending: [] })

const filesOf = (answer: Answer): FileValue[] => {
  const files = (answer.value as { files?: unknown } | undefined)?.files
  return Array.isArray(files) ? (files as FileValue[]) : []
}

/** What a session message says about one answer's files: text inlined, anything else named by path. */
function uploadNotes(answer: Answer): string[] {
  return filesOf(answer).map(
    (file) =>
      fileNote(answer.id, file, (kept) => kept.path) ??
      `${answer.id}: ${file.name} (${baseMime(file.mime)}, ${file.size} B)${file.path ? ` at ${file.path}` : ""}`,
  )
}

/** The message for a round whose call ended before it closed, in the wording of a parley tool result. */
export function deliveryText(result: RoundResult, questions: readonly Question[]): string {
  const head = result.status === "submitted" ? DELIVERY_HEAD.submitted : DELIVERY_HEAD.cancelled
  return [head, "", summarise(result, questions), ...result.answers.flatMap(uploadNotes)].join("\n")
}

/** The custom-entry payloads of a session branch, oldest first: the latest state of each round wins. */
export function latestRounds(entries: readonly unknown[]): unknown[] {
  const latest = new Map<string, unknown>()
  for (const data of entries) {
    if (!isRecord(data) || typeof data.id !== "string") continue
    latest.delete(data.id)
    latest.set(data.id, data)
  }
  return [...latest.values()]
}

export class PiParley {
  readonly rounds = new Rounds()
  readonly #now: () => number
  /** Open rounds read back from the session that no call waits on: their answers go out as a message. */
  readonly #orphans = new Set<string>()
  /** One per waiting call; aborted when the session goes away, so the calls end and leave the round open. */
  readonly #waits = new Set<AbortController>()
  #suspended = false
  /** The agent's closing message while `#close` runs, for the notice of that closure. */
  #message: string | undefined

  constructor(readonly deps: Deps) {
    this.#now = deps.now ?? Date.now
    this.rounds.subscribe((round) => this.#changed(round))
  }

  /** Puts back the rounds an earlier pi process left in this session branch. Call once, before any tool runs. */
  restore(entries: readonly unknown[]) {
    const now = this.#now()
    const keep: Round[] = []
    for (const data of latestRounds(entries)) {
      const restored = fromStored(data)?.round
      if (!restored || stale(restored, now, CLOSED_TTL_MS)) continue
      // A fork or clone carries its parent's rounds; they belong to this session now.
      keep.push(restored.sessionID === this.deps.sessionID ? restored : { ...restored, sessionID: this.deps.sessionID })
    }
    this.rounds.restore(keep)
    for (const round of keep) if (round.status === "open") this.#orphans.add(round.id)
  }

  /** The session's open round. */
  current() {
    return this.rounds.current(this.deps.sessionID)
  }

  async ask(input: AskInput, call: CallContext): Promise<Ask> {
    const questions = (Array.isArray(input.questions) ? input.questions.map(coerceQuestion) : input.questions) as Question[]
    if (this.deps.disabled) return { result: unavailable("disabled"), questions }
    if (!call.ui) {
      const errors = validateQuestions(questions)
      if (errors.length > 0) throw new InputError(`Invalid questions:\n- ${errors.join("\n- ")}`)
      return { result: unavailable(NO_UI), questions }
    }
    return this.#open({ ...input, questions }, call)
  }

  async wait(input: WaitInput, call: CallContext): Promise<Ask> {
    const round = this.current() ?? this.rounds.latest(this.deps.sessionID)
    if (!round) return { result: { status: "none", answers: [], pending: [] }, questions: [] }
    if (round.status === "open") {
      this.#extendDeadline(round, input.timeout_s)
      // The agent now waits on the user: bring the round back up if it was minimised or restored.
      if (call.ui) this.deps.present(round)
    }
    const result = await this.#await(round, { mode: input.wait ?? "all", ids: input.ids, timeout_s: input.timeout_s, call })
    return { result, questions: round.questions }
  }

  end(message?: string) {
    const round = this.current()
    const closed = round !== undefined && this.#close(round, "ended", message)
    return { ok: true, closed: closed ? 1 : 0 }
  }

  /** The panel's submission. Returns the problems that kept the round open; none means it closed. */
  submit(roundID: string, answers: readonly SubmittedAnswer[]): readonly string[] {
    return this.rounds.submit(roundID, answers, true, this.#now()).errors
  }

  /** The user dismissed the round in the panel. */
  dismiss(roundID: string) {
    const round = this.rounds.get(roundID)
    if (round) this.#close(round, "user_closed")
  }

  /** The session is going away: waiting calls end as `unavailable` and their rounds stay open in the session. */
  suspend() {
    this.#suspended = true
    for (const wait of [...this.#waits]) wait.abort()
  }

  #close(round: Round, reason: string, message?: string) {
    this.#message = message
    try {
      return this.rounds.cancel(round.id, reason, this.#now())
    } finally {
      this.#message = undefined
    }
  }

  #persist(round: Round) {
    this.deps.persist(toStored(round, this.deps.directory))
  }

  #changed(round: Round) {
    this.#persist(round)
    if (round.status === "open") return
    this.deps.closed({ round, ...(this.#message === undefined ? {} : { message: this.#message }) })
    // The agent ended it itself; anything else closing a restored round goes to the agent as a message.
    if (!this.#orphans.delete(round.id) || round.reason === "ended") return
    this.deps.deliver(deliveryText(collect(round), round.questions))
    this.#persist(round)
  }

  async #open(input: AskInput, call: CallContext): Promise<Ask> {
    const restored = this.current()
    // A restored round that no call waits on: a call asking the same questions takes it over.
    if (restored && this.#orphans.has(restored.id) && validateQuestions(input.questions).length === 0) {
      if (sameQuestions(restored.questions, input.questions)) {
        this.deps.present(restored)
        const result = await this.#await(restored, {
          mode: input.wait ?? "all",
          ids: input.questions.map((question) => question.id),
          timeout_s: input.timeout_s,
          call,
        })
        return { result, questions: input.questions }
      }
      const keys = rekey(restored.questions, input.questions)
      if (keys.size > 0) return this.#openRenamed(input, call, keys)
    }
    return this.#openNew(input, call)
  }

  /** New questions whose ids the restored round already uses join it renamed; the result uses the asked ids. */
  async #openRenamed(input: AskInput, call: CallContext, keys: Map<string, string>): Promise<Ask> {
    const renamed = input.questions.map((question) => ({
      ...question,
      id: keys.get(question.id) ?? question.id,
      ...(question.show_if ? { show_if: { ...question.show_if, id: keys.get(question.show_if.id) ?? question.show_if.id } } : {}),
    }))
    const { result } = await this.#openNew({ ...input, questions: renamed }, call)
    const original = new Map([...keys].map(([from, to]) => [to, from]))
    const back = (id: string) => original.get(id) ?? id
    return {
      questions: input.questions,
      result: { ...result, answers: result.answers.map((answer) => ({ ...answer, id: back(answer.id) })), pending: result.pending.map(back) },
    }
  }

  async #openNew(input: AskInput, call: CallContext): Promise<Ask> {
    const opened = this.rounds.open(
      this.deps.sessionID,
      {
        questions: input.questions,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.round === undefined ? {} : { round: input.round }),
      },
      this.#now(),
    )
    if ("errors" in opened) throw new InputError(`Invalid questions:\n- ${opened.errors.join("\n- ")}`)
    const { round, joined } = opened
    if ((input.wait ?? "all") !== "none") this.#extendDeadline(round, input.timeout_s)
    this.deps.present(round)
    const result = await this.#await(round, {
      mode: input.wait ?? "all",
      ids: joined ? input.questions.map((question) => question.id) : undefined,
      timeout_s: input.timeout_s,
      call,
    })
    return { result, questions: round.questions }
  }

  /** Records when a waiting call gives up, so the panel can count down. The latest deadline wins. */
  #extendDeadline(round: Round, timeout_s: number | undefined) {
    const seconds = timeoutSeconds(timeout_s)
    if (seconds === 0 || round.status !== "open") return
    round.deadline = Math.max(round.deadline ?? 0, this.#now() + seconds * 1000)
    this.#persist(round)
  }

  async #await(
    round: Round,
    options: { mode: WaitMode; ids?: readonly string[] | undefined; timeout_s?: number | undefined; call: CallContext },
  ): Promise<Result> {
    const { call, ids } = options
    this.#orphans.delete(round.id)
    const leave = new AbortController()
    this.#waits.add(leave)
    if (this.#suspended) leave.abort()
    const total = () => (ids === undefined ? round.questions.length : round.questions.filter((q) => ids.includes(q.id)).length)
    const answered = () => [...round.answers.keys()].filter((id) => ids === undefined || ids.includes(id)).length
    const report = () => call.progress?.(round, answered(), total())
    const stop = this.rounds.subscribe((changed) => {
      if (changed.id === round.id && changed.status === "open") report()
    })
    try {
      report()
      const outcome = await waitFor(this.rounds, round, {
        mode: options.mode,
        ...(ids === undefined ? {} : { ids }),
        timeoutMs: timeoutSeconds(options.timeout_s) * 1000,
        signal: call.signal === undefined ? leave.signal : AbortSignal.any([call.signal, leave.signal]),
      })
      if (outcome === "aborted" && this.#suspended && call.signal?.aborted !== true)
        return {
          status: "unavailable",
          reason: RELOADED_REASON,
          round: round.number,
          round_id: round.id,
          answers: [],
          pending: round.questions.map((question) => question.id).filter((id) => !round.answers.has(id)),
          channel: "tui",
        }
      // An interrupted call cancels its round; a timeout closes it only for the call holding the latest deadline.
      const closing = outcome === "aborted" ? "aborted" : outcome === "timeout" && holdsDeadline(round, this.#now()) ? TIMEOUT : undefined
      if (closing) this.#close(round, closing)
      return { ...collect(round, { ...(ids === undefined ? {} : { ids }), timedOut: outcome === "timeout" }), channel: "tui" }
    } finally {
      stop()
      this.#waits.delete(leave)
      this.#persist(round)
    }
  }
}
