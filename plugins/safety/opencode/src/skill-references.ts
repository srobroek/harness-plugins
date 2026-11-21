/**
 * Skills point their agents at reference files beside `SKILL.md`. An installed plugin's skills live in
 * the plugin cache outside the project, so each read asks `external_directory`, and in a subagent that
 * ask cannot be answered. This allows read-only tools inside the directory of a skill the host lists,
 * never the cache as a whole.
 */

import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, relative } from "node:path"
import { inside } from "./scratch-dirs.ts"

type Evaluation = { readonly action: string; readonly resources: ReadonlyArray<string>; effect: string }

/** Tools that only read the path they were given. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "glob", "grep", "list"])

/** `path` with every symlink resolved, or undefined when it does not resolve. */
function real(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * The real directory of each skill's `SKILL.md`. It skips a directory that is the filesystem root, the
 * home folder or one of its parents, because a stray `SKILL.md` there would open the whole tree. It
 * compares real paths, because `inside` resolves symlinks too. It skips any skill when its directory or
 * the home folder does not resolve.
 */
export function skillDirectories(skills: ReadonlyArray<{ readonly path?: unknown }>, home: string = homedir()): string[] {
  const realHome = real(home)
  if (realHome === undefined) return []
  const dirs = new Set<string>()
  for (const skill of skills) {
    if (typeof skill.path !== "string" || !skill.path.startsWith("/") || basename(skill.path) !== "SKILL.md") continue
    const dir = real(dirname(skill.path))
    if (dir === undefined) continue
    const toHome = relative(dir, realHome)
    if (dir === "/" || !(toHome === ".." || toHome.startsWith("../"))) continue
    dirs.add(dir)
  }
  return [...dirs]
}

/** The skills in a `skill.list` result, which is `{ data }` from the client and a bare array from older hosts. */
export function listedSkills(listed: unknown): ReadonlyArray<{ readonly path?: unknown }> {
  if (Array.isArray(listed)) return listed
  const data = (listed as { data?: unknown } | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Turn an `external_directory` ask into an allow when every resource is inside one of the skill directories. */
export function allowSkillReads(evaluation: Evaluation, dirs: readonly string[]): void {
  if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
  if (evaluation.resources.length === 0 || dirs.length === 0) return
  if (evaluation.resources.every((resource) => inside(resource, dirs))) evaluation.effect = "allow"
}
