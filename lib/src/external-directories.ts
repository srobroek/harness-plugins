/**
 * The `external_directory` resources for directories outside a session, built the way OpenCode builds
 * them for `cd`: the safety plugin asks them for directory flags (`git -C`, `--prefix`, …) and the
 * secret-store plugin for a fnox config outside the project.
 */

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { under } from "./shell-write-targets.ts"

/** The nearest ancestor of `dir` (or `dir` itself) holding `.git`, or `undefined`. */
export function repositoryRoot(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at
    if (dirname(at) === at) return undefined
  }
}

/** The directories inside which a directory needs no approval: the session's and its repository's. */
export function sessionRoots(sessionDirectory: string): string[] {
  const root = repositoryRoot(sessionDirectory)
  return root === undefined || root === dirname(root) ? [sessionDirectory] : [sessionDirectory, root]
}

export type ExternalDirectory = { resource: string; save: string }

/** The `external_directory` resources for the directories outside `roots`, the way OpenCode builds them for `cd`. */
export function externalDirectories(dirs: readonly string[], roots: readonly string[]): ExternalDirectory[] {
  const out = new Map<string, ExternalDirectory>()
  for (const dir of dirs) {
    if (roots.some((root) => under(dir, root))) continue
    const resource = join(dir, "*")
    out.set(resource, { resource, save: join(repositoryRoot(dir) ?? dir, "*") })
  }
  return [...out.values()]
}
