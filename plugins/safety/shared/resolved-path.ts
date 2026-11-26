/** Real paths for paths that may not exist yet, shared by the OpenCode relaxations and the directory-flag check. */

import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"

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
