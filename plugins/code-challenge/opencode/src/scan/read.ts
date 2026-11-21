import { readBoundedBytes } from "@srobroek/opencode-lib/bounded-read"

export type TextRead = { kind: "absent" } | { kind: "unreadable" } | { kind: "text"; text: string }

// The text of a regular, non-symlink file of at most `maxBytes`; anything else is `absent` or `unreadable`.
export function readText(path: string, maxBytes: number): TextRead {
  const read = readBoundedBytes(path, maxBytes)
  if (read.kind === "bytes") return { kind: "text", text: read.bytes.toString("utf8") }
  return { kind: read.kind }
}
