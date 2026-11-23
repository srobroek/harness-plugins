/**
 * Who a pi session is, as the beads gates see it: the actor its `bd` calls write under and
 * whether pi-subagents started it.
 *
 * pi runs a foreground subagent as a second session inside the parent's process, so the process
 * environment is shared and cannot carry a per-session actor. Each session's own header can: pi
 * and pi-subagents record the launching session's file as `parentSession`, so the lineage from
 * the root session down to this one is read from the session files themselves.
 */

import { closeSync, lstatSync, openSync, readSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

/** The header fields of a pi session file the gates read. */
export type SessionHeaderView = { id: string; parentSession?: string }

/** A session id as it may appear in an actor: pi's own ids (UUIDs) pass unchanged. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** A header is one short JSON line; a longer first line is not a header worth trusting. */
const HEADER_BYTES = 16 * 1024

/** The deepest parent chain followed; pi-subagents' own nesting limit is far lower. */
export const MAX_LINEAGE_DEPTH = 16

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

/**
 * Session ids from the root session down to `session`, following each `parentSession` header.
 * A parent that cannot be read, has an unsafe id or repeats one ends the walk there, so the
 * oldest session reached stands in for the root.
 */
export function sessionLineage(
  session: SessionHeaderView,
  readHeader: (file: string) => SessionHeaderView | undefined = readSessionHeader,
  maxDepth = MAX_LINEAGE_DEPTH,
): string[] {
  const lineage = [session.id]
  let parent = session.parentSession
  for (let depth = 0; parent !== undefined && depth < maxDepth; depth++) {
    const header = readHeader(parent)
    if (header === undefined || !SAFE_SEGMENT.test(header.id) || lineage.includes(header.id)) break
    lineage.unshift(header.id)
    parent = header.parentSession
  }
  return lineage
}

/**
 * The actor a session's `bd` calls write under: `pi/<root session>/.../<this session>`. Every
 * session has one, the interactive root included, so no session writes under an actor it
 * inherited from the process that started pi. Its descendants' actors start with it.
 */
export function piActor(lineage: readonly string[]): string {
  const segments = lineage.map((id) => (SAFE_SEGMENT.test(id) ? id : id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "session"))
  return `pi/${segments.join("/")}`
}

/** Whether a claim held by `assignee` is this session's own or one of its descendants'. */
export function actorCovers(actor: string, assignee: string): boolean {
  return assignee === actor || assignee.startsWith(`${actor}/`)
}

/** The env variable pi-subagents sets in a detached runner, which hosts only child sessions. */
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD"

/**
 * Whether pi-subagents started this session. A detached runner marks its whole process. A
 * foreground child shares the parent's process, so it is told apart by where its session
 * lives: pi-subagents stores children under `<parent session dir>/<parent session name>/`,
 * while `/fork` and `/clone` put the new session beside the original. A child whose session
 * is not persisted has a parent but no file.
 */
export function isSubagentChild(input: {
  env: Readonly<Record<string, string | undefined>>
  parentSession?: string
  sessionFile?: string
}): boolean {
  if (input.env[SUBAGENT_CHILD_ENV] === "1") return true
  const parent = input.parentSession
  if (parent === undefined || parent === "") return false
  if (input.sessionFile === undefined || input.sessionFile === "") return true
  const childRoot = resolve(join(dirname(parent), basename(parent, ".jsonl")))
  const path = relative(childRoot, resolve(input.sessionFile))
  return path !== "" && !path.startsWith("..") && !isAbsolute(path)
}
