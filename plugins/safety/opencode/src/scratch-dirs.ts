/**
 * Subagents read the OpenCode temp folder (repomix packs, scratch files) and the worktree folder of their
 * own project (subagent lanes). Both are OpenCode's, so an `external_directory` ask for them is noise; this
 * turns it into an allow. A deny and every other action are left alone.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"

type Evaluation = { readonly action: string; readonly resources: ReadonlyArray<string>; effect: string }

/**
 * The folders OpenCode fills for this user: its temp folder, `<data>/opencode/worktree/<key>` for the
 * project, where the key is the first six characters of the project id (project `41bad135…` keeps its
 * worktrees in `…/worktree/41bad1`), and the two places a truncated tool result points the agent to:
 * `<data>/opencode/shell/<full project id>` (shell output files) and `<data>/opencode/tool-output`.
 */
export function scratchRoots(
  projectID: string,
  where: { home?: string; temp?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): string[] {
  const home = where.home ?? homedir()
  const env = where.env ?? process.env
  const data = env.XDG_DATA_HOME?.startsWith("/") ? env.XDG_DATA_HOME : join(home, ".local", "share")
  return [
    join(where.temp ?? realpathSync(tmpdir()), "opencode"),
    join(data, "opencode", "worktree", projectID.slice(0, 6)),
    join(data, "opencode", "shell", projectID),
    join(data, "opencode", "tool-output"),
  ]
}

/**
 * The real paths of `directories` (the session's directory and its repository root), as roots. OpenCode
 * compares path strings, so a request spelled through a symlink alias of the directory (`/home/u` for
 * `/local/home/u`) asks even though it is the same folder; `inside` resolves the request the same way, so
 * only paths that really lie in the directory match. A missing, relative or filesystem-root entry is dropped.
 */
export function realRoots(directories: readonly string[]): string[] {
  const roots: string[] = []
  for (const directory of directories) {
    try {
      const real = isAbsolute(directory) ? realpathSync(directory) : undefined
      if (real !== undefined && dirname(real) !== real) roots.push(real)
    } catch {}
  }
  return roots
}

/** How many dangling links `resolved` follows before it gives up, as `realpath` does for a loop. */
const MAX_LINKS = 40

/**
 * `path` with symlinks resolved as far as it exists; the rest is appended unchanged. A dangling link is
 * followed to its target, so a link to a folder that does not exist yet still resolves to where it points.
 * Throws on a link loop.
 */
export function resolved(path: string, links = 0): string {
  const missing: string[] = []
  let at = path
  while (!present(at) && dirname(at) !== at) {
    missing.unshift(basename(at))
    at = dirname(at)
  }
  if (existsSync(at)) return join(realpathSync(at), ...missing)
  if (links >= MAX_LINKS) throw new Error(`too many symbolic links: ${path}`)
  const target = readlinkSync(at)
  return join(resolved(isAbsolute(target) ? target : join(dirname(at), target), links + 1), ...missing)
}

/** Whether `path` exists itself, a dangling symlink included. */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** A resource (`~/…`, an absolute path or a `dir/*` pattern) as a canonical path, or `undefined` when it is not one. */
function canonicalResource(resource: string): string | undefined {
  const expanded = resource === "~" || resource.startsWith("~/") ? join(homedir(), resource.slice(1)) : resource
  if (!isAbsolute(expanded)) return undefined
  const path = expanded.replace(/\/\*{1,2}$/, "")
  if (/[*?[\]{}]/.test(path) || path.split("/").includes("..")) return undefined
  return resolved(path)
}

function within(real: string, root: string): boolean {
  const rel = relative(root, real)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Whether a resource lies inside one of the `roots`; each root is resolved through its symlinks first. */
export function inside(resource: string, roots: readonly string[]): boolean {
  const real = canonicalResource(resource)
  return real !== undefined && roots.some((root) => within(real, resolved(root)))
}

/**
 * Like {@link inside} for roots that are already canonical (checked by the caller just before): a root is
 * compared as given, never re-resolved, so a root swapped for a symlink cannot move the boundary.
 */
export function insideCanonical(resource: string, roots: readonly string[]): boolean {
  const real = canonicalResource(resource)
  return real !== undefined && roots.some((root) => within(real, root))
}

/**
 * Whether `root` is still the folder it was computed to be: it exists, no component of its path is a
 * symlink, its real path equals the path, and the current user owns it. A folder swapped for a symlink
 * (or made by someone else) after the path was computed is not trusted.
 */
export function pinned(root: string, uid: () => number | undefined = () => process.getuid?.()): boolean {
  try {
    if (!isAbsolute(root) || realpathSync(root) !== root) return false
    let at: string = sep
    for (const part of root.split(sep).filter(Boolean)) {
      at = join(at, part)
      if (lstatSync(at).isSymbolicLink()) return false
    }
    const owner = uid()
    return owner === undefined || lstatSync(root).uid === owner
  } catch {
    return false
  }
}

/** Turn an `external_directory` ask into an allow when every resource is inside a pinned root. */
export function allowScratch(evaluation: Evaluation, roots: readonly string[], uid?: () => number | undefined): void {
  if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
  if (evaluation.resources.length === 0) return
  const trusted = roots.filter((root) => pinned(root, uid))
  // `pinned` just proved each trusted root is its own real path, so none is resolved again.
  if (evaluation.resources.every((resource) => insideCanonical(resource, trusted))) evaluation.effect = "allow"
}
