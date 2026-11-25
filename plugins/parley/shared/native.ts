import { describeValue } from "./answers.ts"
import { NOTES_HINT } from "./notes.ts"
import type { Question } from "./questions.ts"
import type { RoundResult } from "./rounds.ts"

/** One asked question in the built-in question tool's wording. */
export interface NativeEntry {
  readonly question: string
  readonly answer: readonly string[]
  readonly note?: string
  readonly deferred: boolean
}

/**
 * The built-in tool's model text, verbatim, followed by parley's extras on their own lines:
 * one `Note on "…": …` per note and a `Deferred: …` line for questions the user put off.
 */
export function nativeText(entries: readonly NativeEntry[]): string {
  const formatted = entries
    .map((entry) => `"${entry.question}"="${entry.answer.length ? entry.answer.join(", ") : "Unanswered"}"`)
    .join(", ")
  const lines = [`User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`]
  for (const entry of entries) if (entry.note) lines.push(`Note on "${entry.question}": ${entry.note}`)
  if (entries.some((entry) => entry.note)) lines.push(NOTES_HINT)
  const deferred = entries.filter((entry) => entry.deferred).map((entry) => `"${entry.question}"`)
  if (deferred.length > 0) lines.push(`Deferred (the user will answer later): ${deferred.join(", ")}`)
  return lines.join("\n")
}

/** `parley_ask` with `format: "native"`: the question tool's sentence, keyed by question title. */
export function nativeSummary(result: RoundResult, questions: readonly Question[]): string {
  const asked = result.pending.length + result.answers.length
  const scope = asked === 0 ? questions : questions.filter((q) => result.pending.includes(q.id) || result.answers.some((a) => a.id === q.id))
  return nativeText(
    scope.map((question) => {
      const answer = result.answers.find((candidate) => candidate.id === question.id)
      const value = answer?.value as { text?: unknown } | undefined
      const described =
        value === undefined ? "" : typeof value.text === "string" ? value.text : describeValue(question, value)
      return {
        question: question.title,
        answer: described === "" ? [] : [described],
        ...(answer?.note ? { note: answer.note } : {}),
        deferred: answer?.status === "deferred",
      }
    }),
  )
}
