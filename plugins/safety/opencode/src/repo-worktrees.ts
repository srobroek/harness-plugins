/**
 * A subagent often needs to read a sibling worktree of the repository it works in (the parent checkout,
 * another lane). Each read asks `external_directory`, which a subagent cannot answer. This allows the
 * read-only tools inside the worktrees `git worktree list` reports for the session's own repository,
 * after each reported path has been checked against the repository's own records. Writes, shell commands
 * and every other path keep their ask.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { env as hostEnv } from "node:process"
import { SAFE_GIT_ARGS } from "@srobroek/opencode-lib/safe-git"
import { type SupervisedChild, type SuperviseOptions, supervise } from "@srobroek/opencode-lib/subprocess"
import { insideCanonical, pinned } from "./scratch-dirs.ts"

type Evaluation = { readonly action: string; readonly resources: ReadonlyArray<string>; effect: string }

/** Runs git with the given arguments in `cwd` and returns stdout, or `undefined` on any failure. */
export type GitRun = (args: string[], cwd: string, signal?: AbortSignal) => Promise<string | undefined>

export const GIT_TIMEOUT_MS = 3_000
export const WORKTREE_TTL_MS = 30_000
/** A `.git` file or admin `gitdir` file longer than this is not one git wrote. */
const LINK_FILE_MAX = 4_096

/**
 * Variables that make git use a repository other than the one around `cwd`. They are cleared for these
 * calls (rather than refusing when set), so a polluted environment cannot move the answer or break it.
 */
const REPOSITORY_SELECTORS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const

/** `env` without the variables that select a repository. */
export function gitEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = { ...env }
  for (const name of REPOSITORY_SELECTORS) delete clean[name]
  return clean
}

export type GitSpawn = (argv: string[], options: { cwd: string; env: Record<string, string | undefined> }) => SupervisedChild

const spawnGit: GitSpawn = (argv, options) =>
  Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "ignore", killSignal: "SIGKILL" })

/**
 * A git runner that waits through the shared supervisor, so a lost exit event (Bun on macOS) or a hung
 * git settles at the deadline instead of blocking the permission hook.
 */
export function createGitRunner(
  options: { spawn?: GitSpawn; env?: Readonly<Record<string, string | undefined>> } & Pick<SuperviseOptions, "timeoutMs" | "graceMs" | "pollMs" | "alive"> = {},
): GitRun {
  const spawn = options.spawn ?? spawnGit
  return async (args, cwd, signal) => {
    try {
      const child = spawn(["git", ...SAFE_GIT_ARGS, ...args], { cwd, env: gitEnv(options.env ?? hostEnv) })
      const run = await supervise(child, {
        timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        ...(options.alive ? { alive: options.alive } : {}),
      })
      return run.kind === "exited" && run.exitCode === 0 ? run.stdout : undefined
    } catch {
      return undefined
    }
  }
}

export const runGit: GitRun = createGitRunner()

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

function readSmall(path: string): string | undefined {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > LINK_FILE_MAX) return undefined
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/** The first line of a link file, without its line ending. */
function firstLine(text: string | undefined): string | undefined {
  const line = text?.split("\n", 1)[0]?.replace(/\r$/, "")
  return line === "" ? undefined : line
}

/** The rest of the first line after `prefix`, e.g. `gitdir: ` in a `.git` file. */
function linkTarget(text: string | undefined, prefix: string): string | undefined {
  const line = firstLine(text)
  return line?.startsWith(prefix) && line.length > prefix.length ? line.slice(prefix.length) : undefined
}

/**
 * Whether `root` (a real path) is a worktree of the repository whose real common directory is `common`,
 * by what is on disk rather than what `git worktree list` printed. The main worktree has `.git` as the
 * common directory itself. A linked one has a `.git` file naming `<common>/worktrees/<name>`, and that
 * admin directory's `gitdir` file names the worktree's `.git` back.
 */
function belongs(root: string, common: string): boolean {
  try {
    const dotgit = join(root, ".git")
    const stat = lstatSync(dotgit)
    if (stat.isDirectory()) return realpathSync(dotgit) === common
    const named = linkTarget(readSmall(dotgit), "gitdir: ")
    if (named === undefined) return false
    const admin = realpathSync(isAbsolute(named) ? named : resolve(root, named))
    if (dirname(admin) !== join(common, "worktrees")) return false
    const back = firstLine(readSmall(join(admin, "gitdir")))
    if (back === undefined) return false
    return realpathSync(isAbsolute(back) ? back : resolve(admin, back)) === dotgit
  } catch {
    return false
  }
}

type Trusted = { readonly path: string; readonly dev: number; readonly ino: number }
type Entry = { readonly at: number; readonly roots: readonly Trusted[] }

/** A root is still what was cached: not a symlink, same device and inode, same real path, user-owned. */
function unchanged(root: Trusted, uid: (() => number | undefined) | undefined): boolean {
  try {
    const stat = lstatSync(root.path)
    return !stat.isSymbolicLink() && stat.dev === root.dev && stat.ino === root.ino && pinned(root.path, uid)
  } catch {
    return false
  }
}

/**
 * A lister of the worktree roots of the repository around a directory, cached per directory for `ttlMs`.
 * Only a root that links back to the repository and belongs to the current user is listed. Every call
 * re-checks the cached roots against the disk; one that changed drops the entry and gives no roots, so the
 * request keeps asking. Concurrent lookups for one directory share one git run. A git failure gives no
 * roots and is not cached.
 */
export function createWorktreeLister(
  options: { run?: GitRun; ttlMs?: number; now?: () => number; uid?: () => number | undefined } = {},
): (directory: string, signal?: AbortSignal) => Promise<string[]> {
  const run = options.run ?? runGit
  const ttlMs = options.ttlMs ?? WORKTREE_TTL_MS
  const now = options.now ?? Date.now
  const cache = new Map<string, Entry>()
  const inflight = new Map<string, Promise<Entry | undefined>>()

  async function load(directory: string, signal: AbortSignal | undefined): Promise<Entry | undefined> {
    const commonOut = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"], directory, signal)
    const listed = commonOut === undefined ? undefined : await run(["worktree", "list", "--porcelain", "-z"], directory, signal)
    if (commonOut === undefined || listed === undefined) return undefined
    let common: string
    try {
      common = realpathSync(commonOut.trim())
    } catch {
      return undefined
    }
    const roots: Trusted[] = []
    for (const path of parseWorktrees(listed)) {
      try {
        const real = realpathSync(path)
        if (real === "/" || !pinned(real, options.uid) || !belongs(real, common)) continue
        const stat = lstatSync(real)
        roots.push({ path: real, dev: stat.dev, ino: stat.ino })
      } catch {
        // A worktree whose directory is gone has nothing to allow.
      }
    }
    return { at: now(), roots }
  }

  return async (directory, signal) => {
    let entry = cache.get(directory)
    if (entry !== undefined && now() - entry.at >= ttlMs) {
      cache.delete(directory)
      entry = undefined
    }
    if (entry === undefined) {
      let pending = inflight.get(directory)
      if (pending === undefined) {
        pending = load(directory, signal).finally(() => inflight.delete(directory))
        inflight.set(directory, pending)
      }
      entry = await pending
      if (entry === undefined) return []
      cache.set(directory, entry)
    }
    if (!entry.roots.every((root) => unchanged(root, options.uid))) {
      cache.delete(directory)
      return []
    }
    return entry.roots.map((root) => root.path)
  }
}

/** Turn an `external_directory` ask into an allow when every resource is inside one of the checked worktree roots. */
export function allowWorktreeReads(evaluation: Evaluation, roots: readonly string[]): void {
  if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
  if (evaluation.resources.length === 0 || roots.length === 0) return
  // The lister just re-checked each root against the disk; none is resolved again here.
  if (evaluation.resources.every((resource) => insideCanonical(resource, roots))) evaluation.effect = "allow"
}
