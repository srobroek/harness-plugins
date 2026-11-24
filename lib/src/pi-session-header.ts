/**
 * The header of a pi session file: its first line, `{ "type": "session", "id", "parentSession"? }`.
 * pi and pi-subagents record the launching session's file as `parentSession`, so a session's
 * lineage can be read from the session files themselves.
 */

import { closeSync, lstatSync, openSync, readSync } from "node:fs"

/** The header fields of a pi session file the plugins read. */
export type SessionHeaderView = { id: string; parentSession?: string }

/** A header is one short JSON line; a longer first line is not a header worth trusting. */
const HEADER_BYTES = 16 * 1024

/** The header (first line) of a session file, or `undefined` when it cannot be read as one. */
export function readSessionHeader(file: string): SessionHeaderView | undefined {
  let fd: number | undefined
  try {
    if (!lstatSync(file).isFile()) return undefined
    fd = openSync(file, "r")
    const buffer = Buffer.alloc(HEADER_BYTES)
    const length = readSync(fd, buffer, 0, HEADER_BYTES, 0)
    const text = buffer.subarray(0, length).toString("utf8")
    const end = text.indexOf("\n")
    if (end < 0 && length === HEADER_BYTES) return undefined
    return headerView(JSON.parse(end < 0 ? text : text.slice(0, end)))
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The fields of a parsed header object, or `undefined` when it is not a session header. */
export function headerView(value: unknown): SessionHeaderView | undefined {
  if (value === null || typeof value !== "object") return undefined
  const header = value as { type?: unknown; id?: unknown; parentSession?: unknown }
  if (header.type !== "session" || typeof header.id !== "string" || header.id === "") return undefined
  return typeof header.parentSession === "string" && header.parentSession !== ""
    ? { id: header.id, parentSession: header.parentSession }
    : { id: header.id }
}
