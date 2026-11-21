/**
 * A subagent often needs to read a sibling worktree of the repository it works in (the parent checkout,
 * another lane). Each read asks `external_directory`, which a subagent cannot answer. This allows the
 * read-only tools inside the worktrees `git worktree list` reports for the session's own repository.
 * Writes, shell commands and every other path keep their ask.
 */

import { realpathSync } from "node:fs"
import { inside } from "./scratch-dirs.ts"

type Evaluation = { readonly action: string; readonly resources: ReadonlyArray<string>; effect: string }

/** Runs git with the given arguments in `cwd` and returns stdout, or `undefined` on any failure. */
export type GitRun = (args: string[], cwd: string, signal?: AbortSignal) => Promise<string | undefined>

export const GIT_TIMEOUT_MS = 3_000
export const WORKTREE_TTL_MS = 30_000

/** Config that stops the repository's own settings from running code while worktrees are listed. */
const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]

export const runGit: GitRun = async (args, cwd, signal) => {
  try {
    const child = Bun.spawn(["git", ...SAFE_GIT, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      ...(signal ? { signal } : {}),
    })
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return code === 0 ? out : undefined
  } catch {
    return undefined
  }
}

/** The non-bare worktree paths in `git worktree list --porcelain -z` output. */
export function parseWorktrees(output: string): string[] {
  const paths: string[] = []
  let current: string | undefined
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) current = field.slice("worktree ".length)
    else if (field === "bare") current = undefined
    else if (field === "" && current !== undefined) {
      paths.push(current)
      current = undefined
    }
  }
  if (current !== undefined) paths.push(current)
  return paths
}

/**
 * A lister of the worktree roots of the repository around a directory, cached per directory for `ttlMs`.
 * Paths are canonicalised; one that no longer exists is dropped. A git failure gives no roots and is not cached.
 */
export function createWorktreeLister(
  options: { run?: GitRun; ttlMs?: number; now?: () => number } = {},
): (directory: string, signal?: AbortSignal) => Promise<string[]> {
  const run = options.run ?? runGit
  const ttlMs = options.ttlMs ?? WORKTREE_TTL_MS
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; roots: string[] }>()
  return async (directory, signal) => {
    const hit = cache.get(directory)
    if (hit && now() - hit.at < ttlMs) return hit.roots
    const output = await run(["worktree", "list", "--porcelain", "-z"], directory, signal)
    if (output === undefined) return []
    const roots: string[] = []
    for (const path of parseWorktrees(output)) {
      try {
        roots.push(realpathSync(path))
      } catch {
        // A worktree whose directory is gone has nothing to allow.
      }
    }
    cache.set(directory, { at: now(), roots })
    return roots
  }
}

/** Turn an `external_directory` ask into an allow when every resource is inside one of the worktree roots. */
export function allowWorktreeReads(evaluation: Evaluation, roots: readonly string[]): void {
  if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
  if (evaluation.resources.length === 0 || roots.length === 0) return
  if (evaluation.resources.every((resource) => inside(resource, roots))) evaluation.effect = "allow"
}
