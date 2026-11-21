/**
 * Bash expands `$'...'` into the bytes its escapes spell, so the gate has to read those bytes,
 * not the source text: `$'a\nb'` is two lines, `$'a\0b'` is `a` (bash cuts an ANSI-C word at the
 * first NUL), and `$'\xc3\xa9'` is the two bytes of `é`, not the two characters `Ã©`.
 * This is a static reading of literal words, never an evaluator.
 *
 * Words travel through the shell tokenizer as JavaScript strings. A byte that is not part of a
 * valid UTF-8 sequence cannot be a character, so it is carried as a lone surrogate U+DC80..U+DCFF
 * (Python's `surrogateescape`), and `stringToBytes` turns the string back into the bytes a path
 * names.
 */

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  e: 0x1b,
  E: 0x1b,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  "'": 0x27,
  '"': 0x22,
  "?": 0x3f,
}

const ESCAPED_BYTE_BASE = 0xdc00

/** The bytes a word names: UTF-8 for characters, the raw byte for each escaped one. */
export function stringToBytes(text: string): Buffer {
  const chunks: Buffer[] = []
  let plain = ""
  const flush = (): void => {
    if (plain !== "") chunks.push(Buffer.from(plain, "utf8"))
    plain = ""
  }
  for (const char of text) {
    const code = char.codePointAt(0) as number
    if (code >= ESCAPED_BYTE_BASE + 0x80 && code <= ESCAPED_BYTE_BASE + 0xff) {
      flush()
      chunks.push(Buffer.from([code - ESCAPED_BYTE_BASE]))
    } else {
      plain += char
    }
  }
  flush()
  return Buffer.concat(chunks)
}

/** The word those bytes make: UTF-8 where valid, a lone surrogate for each byte that is not. */
export function bytesToString(bytes: Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let out = ""
  for (let i = 0; i < bytes.length; ) {
    const lead = bytes[i] as number
    const length = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2
    if (lead >= 0xc2 || lead < 0x80) {
      try {
        out += decoder.decode(bytes.subarray(i, i + length))
        i += length
        continue
      } catch {
        // not a valid sequence: fall through and carry the byte alone
      }
    }
    out += String.fromCharCode(ESCAPED_BYTE_BASE + lead)
    i++
  }
  return out
}

type Decoded = { bytes: Buffer; end: number }

/** Decodes the body of a `$'...'` word that starts at `from`; `end` is the index after its closing quote. */
function decodeAnsiC(source: string, from: number): Decoded | null {
  const chunks: Buffer[] = []
  let truncated = false
  const emit = (chunk: Buffer | number[]): void => {
    if (!truncated) chunks.push(Buffer.from(chunk))
  }
  const emitText = (text: string): void => emit(Buffer.from(text, "utf8"))
  const emitByte = (value: number): void => {
    if (value === 0) truncated = true
    else emit([value])
  }
  let i = from
  while (i < source.length) {
    const char = String.fromCodePoint(source.codePointAt(i) as number)
    if (char === "'") return { bytes: Buffer.concat(chunks), end: i + 1 }
    if (char !== "\\") {
      emitText(char)
      i += char.length
      continue
    }
    const next = source[i + 1]
    if (next === undefined) return null
    i += 2
    const simple = SIMPLE_ESCAPES[next]
    if (simple !== undefined) {
      emitByte(simple)
    } else if (/[0-7]/.test(next)) {
      const digits = /^[0-7]{0,2}/.exec(source.slice(i))?.[0] ?? ""
      i += digits.length
      emitByte(Number.parseInt(next + digits, 8) & 0xff)
    } else if (next === "x") {
      const digits = /^[0-9A-Fa-f]{0,2}/.exec(source.slice(i))?.[0] ?? ""
      if (digits.length === 0) {
        emitText("\\x")
      } else {
        i += digits.length
        emitByte(Number.parseInt(digits, 16))
      }
    } else if (next === "u" || next === "U") {
      const digits = new RegExp(`^[0-9A-Fa-f]{0,${next === "u" ? 4 : 8}}`).exec(source.slice(i))?.[0] ?? ""
      const value = Number.parseInt(digits, 16)
      if (digits.length === 0 || value > 0x10ffff) {
        emitText(`\\${next}${digits}`)
        i += digits.length
      } else {
        i += digits.length
        if (value === 0) truncated = true
        else emitText(String.fromCodePoint(value))
      }
    } else if (next === "c" && i < source.length) {
      const control = (source.charCodeAt(i) as number) & 0x1f
      i++
      emitByte(control)
    } else {
      emitText(`\\${next}`)
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
        out += `'${bytesToString(decoded.bytes).replaceAll("'", `'"'"'`)}'`
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
