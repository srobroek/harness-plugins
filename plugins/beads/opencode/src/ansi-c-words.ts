/**
 * Bash expands `$'...'` into the string its escapes spell, so the gate has to read that string,
 * not the source text: `$'a\nb'` is two lines, and `$'a\0b'` is `a`, because bash cuts an
 * ANSI-C word at the first NUL. This is a static reading of literal words, never an evaluator.
 */

const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
}

type Decoded = { text: string; end: number }

/** Decodes the body of a `$'...'` word that starts at `from`; `end` is the index after its closing quote. */
function decodeAnsiC(source: string, from: number): Decoded | null {
  let text = ""
  let truncated = false
  const emit = (chunk: string): void => {
    if (!truncated) text += chunk
  }
  const code = (value: number): void => {
    if (value === 0) truncated = true
    else emit(String.fromCodePoint(value))
  }
  let i = from
  while (i < source.length) {
    const ch = source[i] as string
    if (ch === "'") return { text, end: i + 1 }
    if (ch !== "\\") {
      emit(ch)
      i++
      continue
    }
    const next = source[i + 1]
    if (next === undefined) return null
    i += 2
    const simple = SIMPLE_ESCAPES[next]
    if (simple !== undefined) {
      emit(simple)
    } else if (/[0-7]/.test(next)) {
      const digits = /^[0-7]{0,2}/.exec(source.slice(i))?.[0] ?? ""
      i += digits.length
      code(Number.parseInt(next + digits, 8) & 0xff)
    } else if (next === "x" || next === "u" || next === "U") {
      const max = next === "x" ? 2 : next === "u" ? 4 : 8
      const digits = new RegExp(`^[0-9A-Fa-f]{0,${max}}`).exec(source.slice(i))?.[0] ?? ""
      if (digits.length === 0) {
        emit(`\\${next}`)
      } else {
        i += digits.length
        const value = Number.parseInt(digits, 16)
        if (value > 0x10ffff) emit(`\\${next}${digits}`)
        else code(value)
      }
    } else if (next === "c" && i < source.length) {
      const control = (source.charCodeAt(i) as number) & 0x1f
      i++
      code(control)
    } else {
      emit(`\\${next}`)
    }
  }
  return null
}

/**
 * Replaces each unquoted `$'...'` word part in `source` with the single-quoted string bash
 * would make of it. An unterminated one is left as written.
 */
export function expandAnsiCQuotes(source: string): string {
  if (!source.includes("$'")) return source
  let out = ""
  let quote: '"' | "'" | null = null
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string
    if (quote === "'") {
      if (ch === "'") quote = null
    } else if (quote === '"') {
      if (ch === "\\") {
        out += ch + (source[i + 1] ?? "")
        i++
        continue
      }
      if (ch === '"') quote = null
    } else if (ch === "\\") {
      out += ch + (source[i + 1] ?? "")
      i++
      continue
    } else if (ch === "$" && source[i + 1] === "'") {
      const decoded = decodeAnsiC(source, i + 2)
      if (decoded !== null) {
        out += `'${decoded.text.replaceAll("'", `'"'"'`)}'`
        i = decoded.end - 1
        continue
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch
    }
    out += ch
  }
  return out
}
