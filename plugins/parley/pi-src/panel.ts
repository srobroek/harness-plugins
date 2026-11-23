/**
 * The parley round panel for pi, and the only module that touches the host's terminal UI: a pi-tui
 * component that `ctx.ui.custom()` shows in place of the editor. The adapter sees it only through
 * `PanelSurface` and `loadPanelSurface`, so a host with another UI replaces this one module. pi-tui
 * is imported at run time (types only here), so a host without it still loads parley and answers
 * `unavailable`. Card state, keys and answer values come from the shared card state machine
 * (`shared/tui-state.ts`), so every kind behaves as in the OpenCode panel. pi has no side panel,
 * clipboard paste or copy, so `f`, `y` and `ctrl+v` are not bound.
 */

import type { Component, Editor, EditorTheme, Focusable, TUI } from "@earendil-works/pi-tui"
import type { FileValue, SubmittedAnswer } from "../shared/answers.ts"
import { visibleQuestions } from "../shared/conditions.ts"
import { optionLabel, type Question, sliderBounds, sliderText } from "../shared/questions.ts"
import type { RoundView } from "../shared/rounds.ts"
import { isStructured, structuredSummary } from "../shared/structured.ts"
import { calendarText, structuredRows, structuredRowText, structuredSetText, structuredStep } from "../shared/structured-ui.ts"
import {
  type Arrow,
  accept,
  acceptsPath,
  applyCompletion,
  arrowAction,
  badge,
  choose,
  completionQuery,
  countdown,
  type Draft,
  draftFromAnswer,
  editable,
  editText,
  enterIsNewline,
  initialDraft,
  kindKeys,
  moveCursor,
  parseSlider,
  rankMove,
  rankPaths,
  rows,
  setFiles,
  setNote,
  setText,
  sliderBar,
  step,
  submissions,
  toggleDefer,
} from "../shared/tui-state.ts"

/** The theme colours the panel uses; pi's `Theme` provides them. */
export type Tone = "accent" | "muted" | "dim" | "text" | "success" | "warning" | "error" | "border" | "toolDiffAdded" | "toolDiffRemoved"

export interface PanelTheme {
  fg(color: Tone, text: string): string
  bold(text: string): string
}

/** Edits that outlive the panel: minimising and reopening a round keeps them. */
export interface PanelState {
  readonly drafts: Map<string, Draft>
  focus: number
}

export const newPanelState = (): PanelState => ({ drafts: new Map(), focus: 0 })

export interface PanelHost {
  /** The round as it is now, or undefined once it closed. */
  readonly round: () => RoundView | undefined
  /** Submits the round. Returns the problems that kept it open; none means it closed. */
  readonly submit: (answers: SubmittedAnswer[]) => readonly string[]
  readonly dismiss: () => void
  /** Hides the panel; the round stays open. */
  readonly minimise: () => void
  /** Reads the files a path field names. Throws with a message for the user. */
  readonly readFiles: (text: string) => FileValue[]
  /** Completion candidates for the path being typed. */
  readonly findPaths: (text: string) => string[]
  readonly now: () => number
}

type Field = "note" | "text"

/** The terminal the panel lays out for: pi's TUI, or a stand-in in tests. */
export type PanelTui = Pick<TUI, "requestRender"> & { readonly terminal: { readonly rows: number } }

const PI_FILE_KEYS: Partial<Record<Question["kind"], string>> = {
  ask_image: "e type a path (tab completes)",
  ask_file: "e type paths (tab completes)",
}

const COMPLETING = new Set(["ask_image", "ask_file", "path", "tags"])

/** The pi-tui members the panel uses. `loadPanelSurface` imports them at run time, so a host without them still loads parley. */
export type TuiKit = Pick<typeof import("@earendil-works/pi-tui"), "Editor" | "parseKey" | "truncateToWidth" | "wrapTextWithAnsi">

/** `parseKey` names shift+letter by the capital letter; the panel's bindings use `shift+<letter>`. */
export function keyName(parse: TuiKit["parseKey"], data: string): string | undefined {
  const key = parse(data)
  return key !== undefined && /^[A-Z]$/.test(key) ? `shift+${key.toLowerCase()}` : key
}

/** The hint line under the round: the focused card's own keys, then the shared ones. */
export function panelHints(question: Question | undefined, single: boolean, editing?: { field: Field; enterSaves: boolean; suggestions: boolean }) {
  if (editing) {
    const enter = editing.enterSaves ? "enter save · shift+enter newline" : "enter newline"
    const paths = editing.field === "text" && question && COMPLETING.has(question.kind) ? (editing.suggestions ? " · ↑/↓ suggestion · tab complete" : " · tab complete") : ""
    return `${enter}${paths} · esc done · ctrl+s submit`
  }
  const own = question ? (PI_FILE_KEYS[question.kind] ?? kindKeys(question)) : ""
  const shared = single
    ? "enter submit · a accept · n note · d defer · esc minimise · D dismiss"
    : "tab/j/k question · a accept · n note · d defer · ctrl+s submit · esc minimise · D dismiss"
  return own === "" ? shared : `${own} · ${shared}`
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

const codeLines = (code: string) => code.split("\n").map((line) => `  ${line}`)

export class ParleyPanel implements Component, Focusable {
  #focused = false
  #editing: { readonly id: string; readonly field: Field } | undefined
  #editor: Editor | undefined
  #errors: readonly string[] = []
  #confirming = false
  #suggestions: string[] = []
  #selected = 0
  #scroll = 0
  #cache: { width: number; lines: string[] } | undefined
  readonly #timer: ReturnType<typeof setInterval>

  constructor(
    readonly kit: TuiKit,
    readonly tui: PanelTui,
    readonly theme: PanelTheme,
    readonly host: PanelHost,
    readonly state: PanelState = newPanelState(),
  ) {
    // The countdown ticks in the last ten minutes before the round closes.
    this.#timer = setInterval(() => {
      if (countdown(this.#remaining()) !== undefined) this.refresh()
    }, 1000)
    this.#timer.unref?.()
  }

  get focused() {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    if (this.#editor) this.#editor.focused = value
  }

  /** Redraws with the round's current state (questions joined, deadline moved). */
  refresh() {
    this.#cache = undefined
    this.tui.requestRender()
  }

  invalidate() {
    this.#cache = undefined
    this.#editor?.invalidate()
  }

  dispose() {
    clearInterval(this.#timer)
  }

  // State

  #remaining() {
    const deadline = this.host.round()?.deadline
    return deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - this.host.now()) / 1000))
  }

  #draft(question: Question): Draft {
    let draft = this.state.drafts.get(question.id)
    if (!draft) {
      const answer = this.host.round()?.answers.find((candidate) => candidate.id === question.id)
      draft = answer ? draftFromAnswer(question, answer) : initialDraft(question)
      this.state.drafts.set(question.id, draft)
    }
    return draft
  }

  /** The questions the user sees: conditional ones only once the answer they wait on matches. */
  #questions(): Question[] {
    const all = this.host.round()?.questions ?? []
    for (const question of all) this.#draft(question)
    const visible = visibleQuestions(all, (id) => {
      const draft = this.state.drafts.get(id)
      return draft?.status === "answered" || draft?.status === "accepted" ? draft.value : undefined
    })
    if (this.state.focus >= visible.length) this.state.focus = Math.max(0, visible.length - 1)
    return visible
  }

  #current(): Question | undefined {
    return this.#questions()[this.state.focus]
  }

  #update(fn: (question: Question, draft: Draft) => Draft) {
    const question = this.#current()
    if (!question) return
    this.state.drafts.set(question.id, fn(question, this.#draft(question)))
    this.#errors = []
  }

  #moveCard(delta: number) {
    const count = this.#questions().length
    if (count === 0) return
    this.state.focus = (this.state.focus + delta + count) % count
    this.#scroll = 0
  }

  #arrow(key: Arrow, single: boolean) {
    const question = this.#current()
    const action = question ? arrowAction(question, key) : undefined
    if (!action) return
    if (action.kind === "question") {
      if (!single) this.#moveCard(action.delta)
    } else if (action.kind === "cursor") this.#update((q, d) => moveCursor(q, d, action.delta))
    else this.#update((q, d) => step(q, d, action.delta))
  }

  #startEdit(field: Field) {
    const question = this.#current()
    if (!question || (field === "text" && !editable(question))) return
    const draft = this.#draft(question)
    const editor = new this.kit.Editor(this.tui as TUI, this.#editorTheme())
    editor.setText(field === "note" ? draft.note : editText(question, draft))
    editor.focused = this.#focused
    editor.onSubmit = (text) => this.#finishEdit(text)
    this.#editor = editor
    this.#editing = { id: question.id, field }
    this.#suggestions = []
  }

  #editorTheme(): EditorTheme {
    const fg = (tone: Tone) => (text: string) => this.theme.fg(tone, text)
    return {
      borderColor: fg("accent"),
      selectList: { selectedPrefix: fg("accent"), selectedText: fg("accent"), description: fg("muted"), scrollInfo: fg("dim"), noMatch: fg("warning") },
    }
  }

  /** Saves the open field into its card. A value the card rejects is reported and the field closes. */
  #finishEdit(text = this.#editor?.getExpandedText() ?? "") {
    const edit = this.#editing
    this.#editing = undefined
    this.#editor = undefined
    this.#suggestions = []
    const question = this.host.round()?.questions.find((candidate) => candidate.id === edit?.id)
    if (!edit || !question) return
    const draft = this.#draft(question)
    const save = (next: Draft) => {
      this.state.drafts.set(question.id, next)
      this.#errors = []
    }
    if (edit.field === "note") return save(setNote(draft, text))
    if (isStructured(question)) {
      const result = structuredSetText(question, draft, text)
      if ("error" in result) this.#errors = [result.error]
      else save(result.draft)
      return
    }
    if (question.kind === "ask_image" || question.kind === "ask_file") {
      try {
        save(setFiles(question, draft, text.trim() === "" ? [] : this.host.readFiles(text), "typed"))
      } catch (error) {
        this.#errors = [error instanceof Error ? error.message : String(error)]
      }
      return
    }
    if (question.kind === "slider") {
      const parsed = parseSlider(question, text)
      if (parsed !== undefined && "error" in parsed) {
        this.#errors = [parsed.error]
        return
      }
    }
    save(setText(question, draft, text))
  }

  #submit() {
    if (this.#editing) this.#finishEdit()
    const questions = this.#questions()
    const drafts = Object.fromEntries(questions.map((question) => [question.id, this.#draft(question)]))
    this.#errors = this.host.submit(submissions(questions, drafts))
  }

  /** Enter on a one-question round: with nothing picked yet it takes the row under the cursor, like a question dialog. */
  #send() {
    const question = this.#current()
    const draft = question ? this.#draft(question) : undefined
    if (question && draft?.status === "unset" && draft.note.trim() === "" && rows(question).length > 0 && question.kind !== "pick_many")
      this.#update((q, d) => choose(q, d))
    this.#submit()
  }

  #lookup() {
    const question = this.host.round()?.questions.find((candidate) => candidate.id === this.#editing?.id)
    const text = this.#editor?.getText() ?? ""
    if (!question || this.#editing?.field !== "text" || !COMPLETING.has(question.kind) || completionQuery(text).query === "") {
      this.#suggestions = []
      return
    }
    const candidates = question.kind === "tags" ? [...(question.config?.suggestions ?? [])] : this.host.findPaths(text)
    this.#suggestions = rankPaths(
      completionQuery(text).query,
      candidates.filter((candidate) => question.kind === "tags" || acceptsPath(question, candidate)),
    )
    this.#selected = 0
  }

  // Input

  handleInput(data: string): void {
    const key = keyName(this.kit.parseKey, data)
    if (this.#confirming) {
      this.#confirming = false
      if (key === "y" || key === "enter") {
        this.host.dismiss()
        return
      }
    } else if (this.#editing) this.#editInput(data, key)
    else if (!this.#cardInput(key)) return
    this.refresh()
  }

  #editInput(data: string, key: string | undefined) {
    const editor = this.#editor
    const edit = this.#editing
    if (!editor || !edit) return
    if (key === "escape") return this.#finishEdit()
    if (key === "ctrl+s" || key === "ctrl+enter") return this.#submit()
    if (this.#suggestions.length > 0 && (key === "up" || key === "down")) {
      const count = this.#suggestions.length
      this.#selected = (this.#selected + (key === "up" ? -1 : 1) + count) % count
      return
    }
    if (key === "tab") {
      const choice = this.#suggestions[this.#selected]
      if (choice !== undefined) {
        editor.setText(applyCompletion(editor.getText(), choice))
        this.#lookup()
      }
      return
    }
    const question = this.host.round()?.questions.find((candidate) => candidate.id === edit.id)
    // Code answers take enter as a new line; ctrl+s or esc saves them.
    if (key === "enter" && question && enterIsNewline(question, edit.field)) editor.handleInput("\x1b\r")
    else editor.handleInput(data)
    if (this.#editing) this.#lookup()
  }

  /** Handles a key on the focused card; false when the panel does not use it. */
  #cardInput(key: string | undefined): boolean {
    const single = (this.host.round()?.questions.length ?? 0) === 1
    switch (key) {
      case "tab":
      case "j":
        if (single) this.#update((q, d) => moveCursor(q, d, 1))
        else this.#moveCard(1)
        return true
      case "shift+tab":
      case "k":
        if (single) this.#update((q, d) => moveCursor(q, d, -1))
        else this.#moveCard(-1)
        return true
      case "up":
      case "down":
      case "left":
      case "right":
        this.#arrow(key, single)
        return true
      case "space":
        this.#update((q, d) => choose(q, d))
        return true
      case "enter":
        if (single) this.#send()
        else this.#update((q, d) => choose(q, d))
        return true
      case "shift+up":
      case "shift+k":
        this.#update((q, d) => rankMove(q, d, -1))
        return true
      case "shift+down":
      case "shift+j":
        this.#update((q, d) => rankMove(q, d, 1))
        return true
      case "shift+left":
      case "shift+right": {
        const question = this.#current()
        if (question?.kind === "date" || question?.kind === "datetime") this.#update((q, d) => structuredStep(q, d, key === "shift+left" ? -1 : 1, true))
        return true
      }
      case "a":
        this.#update(accept)
        return true
      case "d":
        this.#update((q, d) => toggleDefer(d, q))
        return true
      case "n":
        this.#startEdit("note")
        return true
      case "e":
        this.#startEdit("text")
        return true
      case "ctrl+s":
      case "ctrl+enter":
        this.#submit()
        return true
      case "escape":
        this.host.minimise()
        return false
      case "shift+d":
        this.#confirming = true
        return true
      case "pageUp":
        this.#scroll = Math.max(0, this.#scroll - this.#bodyRows())
        return true
      case "pageDown":
        this.#scroll += this.#bodyRows()
        return true
      default:
        if (key !== undefined && /^[1-9]$/.test(key)) {
          this.#update((q, d) => choose(q, d, Number(key) - 1))
          return true
        }
        return false
    }
  }

  // Rendering

  #bodyRows() {
    return Math.max(6, Math.floor(this.tui.terminal.rows * 0.4))
  }

  render(width: number): string[] {
    if (this.#cache?.width === width) return this.#cache.lines
    const w = Math.max(1, width)
    const out: string[] = []
    const push = (text: string, indent = "") => {
      for (const line of this.kit.wrapTextWithAnsi(text, Math.max(1, w - indent.length))) out.push(`${indent}${line}`)
    }
    const t = this.theme
    const view = this.host.round()
    if (!view) {
      push(t.fg("dim", "This parley round has closed."))
      return this.#store(w, out)
    }
    const questions = this.#questions()
    const single = view.questions.length === 1
    const ready = questions.filter((q) => {
      const draft = this.#draft(q)
      return draft.status !== "unset" || draft.note.trim() !== ""
    }).length
    const title = `Parley round ${view.number}${view.title ? ` · ${view.title}` : ""}`
    const status = [countdown(this.#remaining()), `${ready}/${plural(questions.length, "question")} ready`].filter(Boolean).join(" · ")
    out.push(t.fg("border", "─".repeat(w)))
    push(`${t.fg("accent", t.bold(title))}  ${t.fg("muted", status)}`)
    if (!single) {
      const tabs = questions.map((q, index) => {
        const label = ` ${badge(this.#draft(q), q).split(" ")[0]} Q${index + 1} ${q.title.length > 24 ? `${q.title.slice(0, 23)}…` : q.title} `
        return index === this.state.focus ? t.fg("accent", t.bold(`[${label.trim()}]`)) : t.fg("muted", label)
      })
      push(tabs.join(" "))
    }
    out.push("")
    const question = questions[this.state.focus]
    if (question) this.#card(question, this.state.focus, push, out, w)
    for (const error of this.#errors) push(t.fg("error", `! ${error}`))
    out.push("")
    if (this.#confirming) push(t.fg("warning", "Dismiss this round? The agent gets a cancelled result for every question. y dismiss · any other key keeps it"))
    else {
      const editing = this.#editing
      const question = this.#current()
      const hints = panelHints(
        question,
        single,
        editing && question
          ? { field: editing.field, enterSaves: !enterIsNewline(question, editing.field), suggestions: this.#suggestions.length > 0 }
          : undefined,
      )
      push(t.fg("dim", hints))
    }
    out.push(t.fg("border", "─".repeat(w)))
    return this.#store(w, out)
  }

  #store(width: number, lines: string[]) {
    const fitted = lines.map((line) => this.kit.truncateToWidth(line, width))
    this.#cache = { width, lines: fitted }
    return fitted
  }

  /** The material a card shows above its answer rows, scrolled with pgup/pgdn when it is long. */
  #material(q: Question, width: number): string[] {
    const t = this.theme
    const lines: string[] = []
    const add = (text: string, tone: Tone = "text") => {
      for (const line of text.split("\n")) for (const wrapped of this.kit.wrapTextWithAnsi(t.fg(tone, line), Math.max(1, width - 1))) lines.push(` ${wrapped}`)
    }
    if (q.body) add(q.body)
    if (q.kind === "review") {
      if (q.markdown) add(q.markdown)
      for (const section of q.sections ?? []) {
        add(t.bold(section.title), "accent")
        add(section.content)
      }
    }
    if (q.kind === "show_diff")
      for (const line of (q.diff ?? "").split("\n"))
        add(line, line.startsWith("+") && !line.startsWith("+++") ? "toolDiffAdded" : line.startsWith("-") && !line.startsWith("---") ? "toolDiffRemoved" : "muted")
    return lines
  }

  #card(q: Question, index: number, push: (text: string, indent?: string) => void, out: string[], width: number) {
    const t = this.theme
    const draft = this.#draft(q)
    push(`${t.bold(`Q${index + 1} ${q.title}`)}  ${t.fg(draft.status === "deferred" ? "warning" : "muted", badge(draft, q))}`)
    if ((q.depends_on?.length ?? 0) > 0) push(t.fg("dim", `after: ${q.depends_on?.join(", ")}`))
    const material = this.#material(q, width)
    const room = this.#bodyRows()
    if (material.length > room) {
      this.#scroll = Math.min(this.#scroll, material.length - room)
      if (this.#scroll > 0) push(t.fg("dim", `↑ ${plural(this.#scroll, "more line")} (pgup)`))
      out.push(...material.slice(this.#scroll, this.#scroll + room))
      const below = material.length - this.#scroll - room
      if (below > 0) push(t.fg("dim", `↓ ${plural(below, "more line")} (pgdn)`))
    } else {
      this.#scroll = 0
      out.push(...material)
    }
    const recommended = this.#recommended(q)
    if (recommended !== undefined) push(t.fg("success", `★ Recommended: ${recommended}`))
    if (q.kind === "ask_code" && typeof q.recommended === "string" && editText(q, draft) !== q.recommended) {
      push(t.fg("success", "★ Recommended:"))
      for (const line of codeLines(q.recommended)) push(t.fg("muted", line))
    }
    if (q.rationale) push(t.fg("muted", `Why: ${q.rationale}`))
    out.push("")
    this.#body(q, draft, push, out, width)
    if (this.#editing?.id === q.id && this.#editing.field === "note") {
      push(t.fg("muted", "Note:"))
      this.#editorLines(out, width)
    } else if (draft.note.trim() !== "") push(t.fg("muted", `Note: ${draft.note}`))
  }

  #recommended(q: Question): string | undefined {
    const rec = q.recommended
    if (rec === undefined || q.kind === "ask_code") return undefined
    if (q.kind === "slider" && typeof rec === "number") return sliderText(q, rec)
    if (Array.isArray(rec)) return rec.map((id) => optionLabel(q, String(id))).join(", ")
    if (typeof rec === "object") return isStructured(q) ? structuredSummary(q, rec) : JSON.stringify(rec)
    if (typeof rec === "string" && (q.options?.length ?? 0) > 0) return optionLabel(q, rec)
    return String(rec)
  }

  #editorLines(out: string[], width: number) {
    for (const line of this.#editor?.render(Math.max(1, width - 2)) ?? []) out.push(` ${line}`)
  }

  #row(push: (text: string) => void, cursor: boolean, marker: string, label: string, extra?: { description?: string | undefined; recommended?: boolean }) {
    const t = this.theme
    const head = `${cursor ? t.fg("accent", "›") : " "} ${marker}${marker === "" ? "" : " "}${cursor ? t.bold(label) : label}`
    const star = extra?.recommended ? ` ${t.fg("success", "★")}` : ""
    const description = extra?.description ? `  ${t.fg("dim", extra.description)}` : ""
    push(`${head}${star}${description}`)
  }

  /** The editable value line: the open editor, or the saved text after its label. */
  #field(q: Question, draft: Draft, label: string, placeholder: string, out: string[], push: (text: string, indent?: string) => void, width: number) {
    const t = this.theme
    if (this.#editing?.id === q.id && this.#editing.field === "text") {
      push(t.fg("dim", `${label}:`))
      this.#editorLines(out, width)
      for (const [index, candidate] of this.#suggestions.entries())
        push(index === this.#selected ? t.fg("accent", `› ${candidate}`) : t.fg("muted", `  ${candidate}`), "  ")
      return
    }
    const shown = q.kind === "slider" ? ((draft.value as { other?: string } | undefined)?.other ?? "") : editText(q, draft)
    if (shown === "") push(`${t.fg("dim", `${label}:`)} ${t.fg("dim", placeholder)}`)
    else if (q.kind === "ask_code") {
      push(t.fg("dim", `${label}:`))
      for (const line of codeLines(shown)) push(line)
    } else push(`${t.fg("dim", `${label}:`)} ${q.kind === "slider" ? `other: ${shown}` : shown}`)
  }

  #body(q: Question, draft: Draft, push: (text: string, indent?: string) => void, out: string[], width: number) {
    const t = this.theme
    const value = draft.value as Record<string, unknown> | undefined
    const cursorAt = (index: number) => draft.cursor === index
    const isRec = (id: string) => (Array.isArray(q.recommended) ? q.recommended.includes(id) : q.recommended === id)
    if (isStructured(q)) {
      if (q.kind === "date" || q.kind === "datetime") for (const line of calendarText(String(value?.value ?? "")).split("\n")) push(t.fg("muted", line), " ")
      structuredRows(q).forEach((row, index) => {
        this.#row(push, cursorAt(index), "", `${row.label}: ${structuredRowText(q, draft, row.id)}`)
      })
      if (q.kind === "allocate") {
        const total = Object.values((value?.allocations as Record<string, number> | undefined) ?? {}).reduce((sum, n) => sum + n, 0)
        push(t.fg("dim", `Total: ${total} / ${q.config?.total ?? 100} ${q.unit ?? "points"}`))
      }
      if (q.kind === "tags" || q.kind === "colour") push(structuredSummary(q, value))
      if (editable(q)) this.#field(q, draft, "value (e)", q.placeholder ?? "type the selected value", out, push, width)
      return
    }
    switch (q.kind) {
      case "pick_one":
      case "pick_many":
        ;(q.options ?? []).forEach((option, index) => {
          const selected = value?.selected
          const picked = Array.isArray(selected) ? selected.includes(option.id) : selected === option.id
          const marker = q.kind === "pick_many" ? (picked ? "[x]" : "[ ]") : picked ? "(•)" : "( )"
          this.#row(push, cursorAt(index), marker, `${index + 1}. ${option.label}`, { description: option.description, recommended: isRec(option.id) })
        })
        if (editable(q)) this.#field(q, draft, "other (e)", "type your own answer", out, push, width)
        return
      case "show_options":
        ;(q.options ?? []).forEach((option, index) => {
          const picked = value?.selected === option.id
          this.#row(push, cursorAt(index), picked ? "(•)" : "( )", `${index + 1}. ${option.label}`, { recommended: isRec(option.id) })
          if (option.description) push(t.fg("muted", option.description), "      ")
          for (const pro of option.pros ?? []) push(t.fg("success", `+ ${pro}`), "      ")
          for (const con of option.cons ?? []) push(t.fg("error", `− ${con}`), "      ")
        })
        return
      case "emoji_react": {
        const emojis = rows(q)
        push(
          emojis
            .map((emoji, index) => {
              const picked = value?.emoji === emoji
              const cell = `${picked ? "(•)" : "( )"} ${emoji}${q.recommended === emoji ? "★" : ""}`
              return cursorAt(index) ? t.fg("accent", `›${cell}`) : ` ${cell}`
            })
            .join("  "),
        )
        return
      }
      case "confirm":
      case "thumbs":
      case "review":
      case "show_diff":
        rows(q).forEach((id, index) => {
          const picked = value?.choice === id || value?.decision === id
          const label =
            q.kind === "confirm" ? (id === "yes" ? (q.yes_label ?? "Yes") : (q.no_label ?? "No")) : q.kind === "thumbs" ? (id === "up" ? "👍 up" : "👎 down") : id === "approve" ? "Approve" : "Request changes"
          this.#row(push, cursorAt(index), picked ? "(•)" : "( )", label, { recommended: q.recommended === id })
        })
        if (q.kind === "review" || q.kind === "show_diff") this.#field(q, draft, "feedback (e)", "what should change?", out, push, width)
        return
      case "rank": {
        const order = (value?.order as string[] | undefined) ?? rows(q)
        order.forEach((id, index) => {
          this.#row(push, cursorAt(index), `${index + 1}.`, optionLabel(q, id), { description: q.options?.find((option) => option.id === id)?.description })
        })
        return
      }
      case "slider": {
        const bounds = sliderBounds(q)
        const current = (value?.value as number | undefined) ?? bounds.min
        push(`${sliderBar(q, current)} ${sliderText(q, current)}`, " ")
        push(t.fg("dim", `${q.labels?.min ?? bounds.min} … ${q.labels?.mid ? `${q.labels.mid} … ` : ""}${q.labels?.max ?? bounds.max}`), " ")
        this.#field(q, draft, q.allow_other === true ? "value or other (e)" : "value (e)", `${bounds.min}–${bounds.max}`, out, push, width)
        return
      }
      case "rate": {
        const bounds = sliderBounds(q)
        ;(q.options ?? []).forEach((option, index) => {
          const rating = (value?.ratings as Record<string, number> | undefined)?.[option.id]
          const count = bounds.max - bounds.min + 1
          const filled = rating === undefined ? 0 : rating - bounds.min + 1
          const stars = count <= 10 ? `${"★".repeat(filled)}${"☆".repeat(count - filled)}` : String(rating ?? "–")
          this.#row(push, cursorAt(index), stars, option.label, { description: option.description })
        })
        return
      }
      case "ask_text":
        this.#field(q, draft, "answer (e)", q.placeholder ?? "type your answer", out, push, width)
        return
      case "ask_code":
        this.#field(q, draft, `code${q.language ? ` (${q.language})` : ""} (e)`, q.placeholder ?? "write the code", out, push, width)
        return
      case "ask_image":
      case "ask_file":
        for (const file of ((value?.files as FileValue[] | undefined) ?? []) as FileValue[]) push(`📎 ${file.name} (${file.mime}, ${file.size} B)`, " ")
        this.#field(q, draft, q.multiple ? "paths, comma or line separated (e)" : "path (e)", q.kind === "ask_image" ? "screenshot.png" : "./path/to/file", out, push, width)
        return
    }
  }
}

// The host surface: the one place parley calls `ctx.ui.custom()`. A host whose UI differs replaces this
// module with its own `loadPanelSurface`; the adapter depends only on `PanelSurface`.

/** What the adapter hands a surface to show one round. */
export interface PanelRequest {
  /** The round and what the user's keys do to it; the surface adds minimising. */
  readonly host: Omit<PanelHost, "minimise">
  readonly state: PanelState
  /** Why pi is blocked while the panel shows, for terminals that report program status. */
  readonly label: string
  /** Runs once when the panel goes away: `shown` is false when the host never showed it. */
  readonly onGone: (shown: boolean) => void
}

/** A shown panel, as the adapter drives it. */
export interface OpenPanel {
  /** Redraws with the round's current state. */
  refresh(): void
  /** Takes the panel down; `onGone` follows. */
  close(): void
}

export interface PanelSurface {
  /** Shows a round through the host UI `ui`, or returns undefined when that UI cannot show one. */
  open(ui: unknown, request: PanelRequest): OpenPanel | undefined
}

type Custom = (
  factory: (tui: PanelTui, theme: PanelTheme, keybindings: unknown, done: (result: undefined) => void) => Component,
  options: { blocked: { kind: "question"; message: string } },
) => unknown

const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof (value as { then?: unknown } | null)?.then === "function"

/** The panel surface over pi's `ctx.ui.custom()` and a pi-tui kit. */
export function piSurface(kit: TuiKit): PanelSurface {
  return {
    open(ui, request) {
      const custom = (ui as { custom?: unknown } | undefined)?.custom
      if (typeof custom !== "function") return undefined
      let panel: ParleyPanel | undefined
      let finish: (() => void) | undefined
      let closing = false
      let gone = false
      const leave = () => {
        if (gone) return
        gone = true
        request.onGone(panel !== undefined)
      }
      let shown: unknown
      try {
        shown = (custom as Custom).call(
          ui,
          (tui, theme, _keybindings, done) => {
            finish = () => done(undefined)
            panel = new ParleyPanel(kit, tui, theme, { ...request.host, minimise: () => done(undefined) }, request.state)
            // Closed before the host built the panel: finish as soon as it shows.
            if (closing) queueMicrotask(() => done(undefined))
            return panel
          },
          { blocked: { kind: "question", message: request.label } },
        )
      } catch {
        return undefined
      }
      // pi's RPC mode answers `custom()` without showing anything; a promise that settles unbuilt reports it through `onGone`.
      if (!isThenable(shown)) return undefined
      shown.then(leave, leave)
      return {
        refresh: () => panel?.refresh(),
        close: () => {
          closing = true
          finish?.()
        },
      }
    },
  }
}

/** The pi panel surface over a pi-tui module, or undefined when the module lacks a member the panel needs. */
export function surfaceFrom(module: unknown): PanelSurface | undefined {
  const { Editor, parseKey, truncateToWidth, wrapTextWithAnsi } = (module ?? {}) as Partial<TuiKit>
  if (typeof Editor !== "function" || typeof parseKey !== "function" || typeof truncateToWidth !== "function" || typeof wrapTextWithAnsi !== "function")
    return undefined
  return piSurface({ Editor, parseKey, truncateToWidth, wrapTextWithAnsi })
}

/** The pi panel surface, or undefined when the host has no pi-tui it can lend. Imported at run time, so parley loads without it. */
export async function loadPanelSurface(): Promise<PanelSurface | undefined> {
  try {
    return surfaceFrom(await import("@earendil-works/pi-tui"))
  } catch {
    return undefined
  }
}
