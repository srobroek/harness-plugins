/**
 * The reviewer verdict line, read fence-aware. Shared by the plugins that read a reviewer's reply
 * (`model-roles`, `autopilot`). Pure.
 */

export type Verdict = "approve" | "request-changes" | "comment"

const VERDICT_LINE = /^VERDICT:\s*(APPROVE|REQUEST[-_]CHANGES|COMMENT)\b(.*)$/i
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * The last `VERDICT:` line of `text` and what follows the verdict word on it (trimmed). A line in
 * a fenced block, indented four spaces or a tab, or quoted with `>` is someone else's text and
 * does not count. A fence closes only on a bare line of the same character at least as long as the
 * opening (CommonMark). `REQUEST-CHANGES` and `REQUEST_CHANGES` both read as `request-changes`.
 */
export function parseVerdictLine(text: string): { verdict: Verdict; rest: string } | undefined {
  let found: { verdict: Verdict; rest: string } | undefined
  let fence: { char: string; length: number } | undefined
  for (const line of text.split(/\r?\n/)) {
    if (fence !== undefined) {
      const closes = CLOSE_FENCE.exec(line)?.[1]
      if (closes?.startsWith(fence.char) && closes.length >= fence.length) fence = undefined
      continue
    }
    const opens = OPEN_FENCE.exec(line)
    if (opens?.[1] !== undefined && !(opens[1].startsWith("`") && opens[2]?.includes("`"))) {
      fence = { char: opens[1].charAt(0), length: opens[1].length }
      continue
    }
    if (/^(?: {4}|\t)/.test(line) || /^ {0,3}>/.test(line)) continue
    const match = VERDICT_LINE.exec(line.trim())
    if (match?.[1] !== undefined) found = { verdict: match[1].toLowerCase().replace("_", "-") as Verdict, rest: (match[2] ?? "").trim() }
  }
  return found
}

/** The verdict on the last counted `VERDICT:` line of `text`. */
export function parseVerdict(text: string): Verdict | undefined {
  return parseVerdictLine(text)?.verdict
}
