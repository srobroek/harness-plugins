/**
 * Segment-aware write guard for the `debug` agent.
 *
 * Permission globs let `*` span `/`, so a pattern like worktree, star, debug-star also matches a debug-star directory
 * nested inside another lane. This guard decides on path segments after resolving symlinks:
 * a write is allowed only inside the debug ledger directory, or inside `<worktree root>/<hash>/debug-<slug>/`,
 * and never inside the directory the session started in. Each host names its own two roots (`ScratchRoots`).
 */

import { lstatSync, readlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { WRITE_TOOLS, writeTargets } from "@srobroek/opencode-lib/tool-targets"

/** Where `debug` may write, relative to the home directory: its ledger directory and the root of its scratch worktrees. */
export type ScratchRoots = { ledger: string; worktrees: string }

/** OpenCode's roots: `~/.opencode/debug/` and the worktrees OpenCode creates under `~/.local/share/opencode/worktree/`. */
export const OPENCODE_SCRATCH: ScratchRoots = { ledger: ".opencode/debug", worktrees: ".local/share/opencode/worktree" }

export type PathGuardOptions = {
  /** The user's home directory. Defaults to `os.homedir()`. */
  home?: string
  /** The directory the session started in, which is never writable. */
  startDir: string
  /** The host's scratch roots. Defaults to `OPENCODE_SCRATCH`. */
  roots?: ScratchRoots
}

/** The absolute ledger and worktree roots for `options`, under the resolved home directory. */
function scratchDirs(options: PathGuardOptions): { ledger: string; worktrees: string } {
  const home = canonical(options.home ?? homedir())
  const roots = options.roots ?? OPENCODE_SCRATCH
  return { ledger: join(home, roots.ledger), worktrees: join(home, roots.worktrees) }
}

const MAX_LINKS = 40

/**
 * The absolute path with every symlink resolved, walking it one segment at a time with `lstat`.
 * A dangling symlink is followed through `readlink` (relative targets resolve from the link's own
 * directory); only a name with nothing at all behind it counts as missing, and the rest of the path
 * is then taken as written. Any other error, or too many links, throws so the caller fails closed.
 */
export function canonical(path: string): string {
  // Not `resolve(path)`: that would collapse `link/..` lexically before the link is followed.
  const pending = (isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`).split(sep).filter((segment) => segment !== "")
  let current: string = sep
  let links = 0
  while (pending.length > 0) {
    const segment = pending.shift() as string
    if (segment === ".") continue
    if (segment === "..") {
      current = dirname(current)
      continue
    }
    const next = join(current, segment)
    let stats: ReturnType<typeof lstatSync>
    try {
      stats = lstatSync(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return appendLexically(next, pending)
    }
    if (!stats.isSymbolicLink()) {
      current = next
      continue
    }
    if (++links > MAX_LINKS) throw new Error(`too many symbolic links resolving ${path}`)
    const target = readlinkSync(next)
    if (isAbsolute(target)) current = sep
    pending.unshift(...target.split(sep).filter((part) => part !== ""))
  }
  return current
}

/** `base` followed by `segments`, with `.` and `..` applied by name (nothing is left to follow). */
function appendLexically(base: string, segments: readonly string[]): string {
  const parts = base.split(sep).filter((part) => part !== "")
  for (const segment of segments) {
    if (segment === "..") parts.pop()
    else if (segment !== ".") parts.push(segment)
  }
  return sep + parts.join(sep)
}

/**
 * The ways a tool may read a path: as the operating system does (symlinks first, then `..`), and as a
 * tool that normalises `..` by name before it opens the file. A path must pass under both.
 */
export function readings(path: string): string[] {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`
  const lexical = appendLexically(sep, absolute.split(sep).filter((part) => part !== ""))
  return [canonical(absolute), canonical(lexical)]
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/** Why a debug write to `target` is refused, or undefined when it is allowed. */
export function checkDebugWrite(target: string, options: PathGuardOptions): string | undefined {
  try {
    return checkResolved(target, options)
  } catch (error) {
    return `${target} could not be resolved (${(error as Error).message}), so the write is refused`
  }
}

function checkResolved(target: string, options: PathGuardOptions): string | undefined {
  const start = canonical(options.startDir)
  for (const path of readings(isAbsolute(target) ? target : `${start}${sep}${target}`)) {
    const reason = checkReading(target, path, start, options)
    if (reason !== undefined) return reason
  }
  return undefined
}

function checkReading(target: string, path: string, start: string, options: PathGuardOptions): string | undefined {
  const { ledger, worktrees } = scratchDirs(options)
  if (path === start || inside(path, start)) return `${target} is inside the directory this session started in`
  if (inside(path, ledger)) return undefined
  if (inside(path, worktrees)) {
    const [hash, lane, ...rest] = relative(worktrees, path).split(sep)
    if (hash !== undefined && lane !== undefined && /^debug-.+/.test(lane) && rest.length > 0) return undefined
  }
  return `${target} is outside a debug-* scratch worktree and the debug ledger directory`
}

/**
 * Whether `path` is a `debug-*` scratch worktree or inside one: `<worktree root>/<hash>/debug-<slug>[/…]`,
 * after symlinks are resolved and never inside the directory the session started in.
 */
export function isScratchPath(path: string, options: PathGuardOptions): boolean {
  try {
    const { worktrees } = scratchDirs(options)
    const start = canonical(options.startDir)
    return readings(isAbsolute(path) ? path : `${start}${sep}${path}`).every((resolved) => {
      if (resolved === start || inside(resolved, start)) return false
      if (!inside(resolved, worktrees)) return false
      const [hash, lane] = relative(worktrees, resolved).split(sep)
      return hash !== undefined && lane !== undefined && /^debug-.+/.test(lane)
    })
  } catch {
    return false
  }
}

/** Whether `path` is exactly a `debug-*` scratch worktree directory, `<worktree root>/<hash>/debug-<slug>`, not something inside one. */
export function isScratchRoot(path: string, options: PathGuardOptions): boolean {
  try {
    const { worktrees } = scratchDirs(options)
    return isScratchPath(path, options) && readings(isAbsolute(path) ? path : `${canonical(options.startDir)}${sep}${path}`).every((resolved) => relative(worktrees, resolved).split(sep).length === 2)
  } catch {
    return false
  }
}

/** `checkDebugWrite` for an edit, write or patch call by the `debug` agent. */
export function guardDebugWrite(tool: string, input: unknown, agent: string, options: PathGuardOptions): string | undefined {
  if (agent !== "debug" || !WRITE_TOOLS.has(tool)) return undefined
  const targets = writeTargets(tool, input)
  if (targets.length === 0) return "the write has no readable target path, so it cannot be checked"
  for (const target of targets) {
    const reason = checkDebugWrite(target, options)
    if (reason !== undefined) return reason
  }
  return undefined
}
