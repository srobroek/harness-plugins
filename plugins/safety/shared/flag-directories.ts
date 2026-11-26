/**
 * Directory flags OpenCode's shell parser does not check. OpenCode asks for
 * `external_directory` when a `cd`/`pushd` target lies outside the session, but a
 * tool's own directory flag (`git -C`, `make -C`, `npm --prefix`, …) moves the command
 * just as far without that check. This reads those flags so the plugin can ask the
 * same question, against roots that also hold the session repository's worktrees.
 */

import { lstatSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { commondirValue, markedCommonDir, physical, readBounded, verifyCheckout } from "@srobroek/opencode-lib/checkout-marker"
import { type ExternalDirectory, externalDirectories, sessionRoots } from "@srobroek/opencode-lib/external-directories"
import { DEFAULT_GIT_WRAPPERS, isGitCommand } from "@srobroek/opencode-lib/git-wrappers"
import { leadingCd } from "@srobroek/opencode-lib/shell-command"
import { under } from "@srobroek/opencode-lib/shell-write-targets"
import { linkedWorktree } from "./history-rewrite.ts"
import { resolved } from "./resolved-path.ts"
import { base, type Command, walkShell } from "./shell.ts"

/**
 * `$HOME`/`~` expand; any other expansion cannot be read statically and yields `undefined`. A relative
 * value with no known base (`cwd` undefined) is recorded in `unresolved` and also yields `undefined`.
 */
function literalDir(raw: string, cwd: string | undefined, unresolved: string[]): string | undefined {
  const value = raw.replace(/^\$\{?HOME\}?(?=\/|$)/, homedir())
  if (value === "" || /[$`]/.test(value)) return undefined
  if (value === "~" || value.startsWith("~/")) return join(homedir(), value.slice(1))
  if (isAbsolute(value)) return resolve(value)
  if (cwd === undefined) {
    unresolved.push(raw)
    return undefined
  }
  return resolve(cwd, value)
}

type Flag = { names: readonly string[]; /** `-Cdir` spelling allowed. */ attached?: boolean; file?: boolean }

/** Options per command that set the directory it acts in. Later `-C`s nest in earlier ones. */
const FLAGS: Record<string, readonly Flag[]> = {
  make: [{ names: ["-C", "--directory"], attached: true }],
  gmake: [{ names: ["-C", "--directory"], attached: true }],
  npm: [{ names: ["-C", "--prefix"] }],
  pnpm: [{ names: ["-C", "--dir"] }],
  yarn: [{ names: ["--cwd"] }],
  bun: [{ names: ["--cwd"] }],
  cargo: [{ names: ["-C"], attached: true }, { names: ["--manifest-path"], file: true }],
  go: [{ names: ["-C", "--C"] }],
  uv: [{ names: ["--directory", "--project"] }],
}

const GIT_VALUED: ReadonlySet<string> = new Set(["-c", "--namespace", "--config-env", "--super-prefix"])

/** `git`'s global `-C`, `--git-dir` and `--work-tree`, and `GIT_DIR`/`GIT_WORK_TREE` assignments. */
function gitDirectories(command: Command, cwd: string | undefined, unresolved: string[]): string[] {
  const out: string[] = []
  for (const assignment of command.assignments) {
    const match = /^(GIT_DIR|GIT_WORK_TREE)=(.*)$/.exec(assignment)
    const dir = match?.[2] === undefined ? undefined : literalDir(match[2], cwd, unresolved)
    if (dir !== undefined) out.push(dir)
  }
  let at = cwd
  const argv = command.argv
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] as string
    if (!word.startsWith("-")) break
    const [flag] = word.split("=", 1) as [string]
    const value = word.includes("=") ? word.slice(flag.length + 1) : undefined
    if (flag === "-C") {
      const next = literalDir(argv[++i] ?? "", at, unresolved)
      if (next === undefined) return out
      at = next
      out.push(at)
    } else if (flag === "--git-dir" || flag === "--work-tree") {
      const dir = literalDir(value ?? argv[++i] ?? "", at, unresolved)
      if (dir !== undefined) out.push(dir)
    } else if (GIT_VALUED.has(flag) && value === undefined) {
      i++
    }
  }
  return out
}

function toolDirectories(name: string, argv: readonly string[], cwd: string | undefined, unresolved: string[]): string[] {
  if (!Object.hasOwn(FLAGS, name)) return []
  const flags = FLAGS[name] as readonly Flag[]
  const out: string[] = []
  let at = cwd
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] as string
    if (word === "--") break
    for (const flag of flags) {
      let value: string | undefined
      const named = flag.names.find((option) => word === option || word.startsWith(`${option}=`))
      if (named !== undefined) value = word === named ? argv[++i] : word.slice(named.length + 1)
      else if (flag.attached) {
        const short = flag.names.find((option) => /^-[A-Za-z]$/.test(option) && word.startsWith(option))
        if (short !== undefined) value = word.slice(short.length)
      }
      if (value === undefined) continue
      const path = literalDir(value, at, unresolved)
      if (path === undefined) break
      if (flag.file) out.push(dirname(path))
      else {
        // `make -C a -C b` nests; the others take the last one.
        if (name === "make" || name === "gmake") at = path
        out.push(path)
      }
      break
    }
  }
  return out
}

/**
 * Absolute directories `command`'s flags point it at, resolved against `cwd`; `gitWrappers` name the
 * git commands. With `cwd` undefined, relative values go to `unresolved` instead.
 */
export function flagDirectories(
  command: Command,
  cwd: string | undefined,
  gitWrappers: readonly string[] = DEFAULT_GIT_WRAPPERS,
  unresolved: string[] = [],
): string[] {
  if (isGitCommand(command.argv[0], gitWrappers)) return gitDirectories(command, cwd, unresolved)
  return toolDirectories(base(command.argv[0]), command.argv, cwd, unresolved)
}

/** Every flag directory a shell call names, each once, in order. */
export function shellFlagDirectories(source: string, cwd: string, gitWrappers: readonly string[] = DEFAULT_GIT_WRAPPERS): string[] {
  return flagDirectoryReport(source, cwd, gitWrappers).dirs
}

/** A shell call's flag directories, and the relative ones it names when `cwd` (its base) is unknown. */
export type FlagDirectoryReport = { dirs: string[]; unresolved: string[] }

export function flagDirectoryReport(
  source: string,
  cwd: string | undefined,
  gitWrappers: readonly string[] = DEFAULT_GIT_WRAPPERS,
): FlagDirectoryReport {
  const dirs = new Set<string>()
  const unresolved: string[] = []
  for (const command of walkShell(source).commands) for (const dir of flagDirectories(command, cwd, gitWrappers, unresolved)) dirs.add(dir)
  return { dirs: [...dirs], unresolved: [...new Set(unresolved)] }
}

/**
 * A shell call's flag directories, with its leading `cd` read for this check alone; every other gate keeps
 * `leadingCd`, which refuses `;`. Relative values resolve against:
 * - `cwd`, when the call does not start with a directory change;
 * - the target of `cd <dir> &&`, or of a call that is only `cd <dir>`, since nothing after a failed `cd` runs;
 * - both the target and `cwd` for `cd <dir>;` (or `cd <dir>` and a newline): the rest runs in `<dir>` when the
 *   `cd` succeeds and in `cwd` when it fails, so the directories from both bases are reported and each must
 *   pass the roots on its own.
 *
 * After any other leading directory change (one `leadingCd` rejects for its form: quoted, `~`, `$`, `..`, `-`,
 * a redirection, `||`, `pushd`, …) relative values go to `unresolved`.
 */
export function callFlagDirectoryReport(
  command: string,
  cwd: string,
  gitWrappers: readonly string[] = DEFAULT_GIT_WRAPPERS,
): FlagDirectoryReport {
  const lead = leadingCd(command, cwd)
  if (lead.kind !== "rejected") return flagDirectoryReport(command, lead.kind === "dir" ? lead.dir : cwd, gitWrappers)
  // The words before the first `;` or newline, read as a call that is only a `cd`.
  const first = /^[^;\n]*/.exec(command)?.[0] ?? command
  const sequenced = first.length < command.length ? leadingCd(first, cwd) : lead
  if (sequenced.kind !== "dir") return flagDirectoryReport(command, undefined, gitWrappers)
  const moved = flagDirectoryReport(command, sequenced.dir, gitWrappers)
  const stayed = flagDirectoryReport(command, cwd, gitWrappers)
  return { dirs: [...new Set([...moved.dirs, ...stayed.dirs])], unresolved: [] }
}

/** `path` as a real path, or `undefined` when a link loops. */
function real(path: string): string | undefined {
  try {
    return resolved(path)
  } catch {
    return undefined
  }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * The roots of the directory-flag check, as real paths: `sessionRoots` (the session directory and its
 * repository root) and every worktree of that repository. The worktrees are read from disk the way Git
 * records them, without running git: the main worktree when the common directory is a `.git` folder, and the
 * worktree each `<common>/worktrees/<name>/gitdir` names. One counts only when its own `.git` names this
 * repository back (`verifyCheckout`), so a stale entry or another checkout at a recorded path does not.
 */
export function flagCheckRoots(sessionDirectory: string): string[] {
  const roots = new Set(sessionRoots(sessionDirectory).map((root) => real(root) ?? root))
  const common = markedCommonDir(sessionDirectory)
  if (common === null) return [...roots]
  // `common` is physical, and so is every `.git` path `physical` returns: no candidate needs resolving again.
  const candidates = basename(common) === ".git" ? [dirname(common)] : []
  for (const name of entries(join(common, "worktrees"))) {
    const admin = join(common, "worktrees", name)
    const read = readBounded(join(admin, "gitdir"))
    // The admin `gitdir` file is one line like `commondir`: the worktree's `.git`, absolute or relative to `admin`.
    const value = read.kind === "text" ? commondirValue(read.text) : null
    const dotGit = value === null ? null : physical(value.startsWith("/") ? value : `${admin}/${value}`)
    if (dotGit !== null) candidates.push(dirname(dotGit))
  }
  for (const candidate of candidates) {
    if (candidate !== "/" && verifyCheckout(candidate, common).state === "same") roots.add(candidate)
  }
  return [...roots]
}

export const DEFAULT_WORKTREE_ROOTS: readonly string[] = Object.freeze(["~/tmp/worktrees"])

/**
 * The `worktreeRoots` option with a leading `~` expanded against `home`. A list of strings replaces the
 * default and anything else gives it; an entry that is not absolute after expansion is dropped.
 */
export function readWorktreeRoots(raw: unknown, home: string = homedir()): string[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [...DEFAULT_WORKTREE_ROOTS]
  return list.flatMap((entry) => {
    if (typeof entry !== "string") return []
    const expanded = entry === "~" || entry.startsWith("~/") ? join(home, entry.slice(1)) : entry
    return isAbsolute(expanded) ? [expanded] : []
  })
}

/** Whether something is at `path` itself; an error other than a missing entry counts as something. */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== "ENOENT" && code !== "ENOTDIR"
  }
}

/**
 * Whether the real path `path` lies in a linked worktree under the real directory `root`: the nearest `.git`
 * at or above it, looked for no higher than `root`, is the gitfile of a linked worktree whose admin directory
 * names it back (`linkedWorktree`). A plain directory, a main checkout or a submodule does not count.
 */
function inLinkedWorktreeUnder(path: string, root: string): boolean {
  if (!under(path, root)) return false
  for (let at = path; ; at = dirname(at)) {
    const git = join(at, ".git")
    if (present(git)) return linkedWorktree(git)
    if (at === root || dirname(at) === at) return false
  }
}

/**
 * The `external_directory` resources for the flag directories outside {@link flagCheckRoots} and outside every
 * linked worktree under `worktreeRoots` (any repository's), each named as the command spelled it. Directories
 * compare by real path, so `/home/u/x` matches a root at `/local/home/u/x` when one links to the other, and a
 * symlink out of a root counts as outside. One whose real path cannot be read (a link loop) counts as outside too.
 */
export function externalFlagDirectories(
  dirs: readonly string[],
  sessionDirectory: string,
  worktreeRoots: readonly string[],
): ExternalDirectory[] {
  if (dirs.length === 0) return []
  const roots = flagCheckRoots(sessionDirectory)
  const rooted = worktreeRoots.flatMap((root) => real(root) ?? [])
  const outside = dirs.filter((dir) => {
    const path = real(dir)
    if (path === undefined) return true
    return !roots.some((root) => under(path, root)) && !rooted.some((root) => inLinkedWorktreeUnder(path, root))
  })
  // With no roots, `externalDirectories` builds the resources for exactly these directories.
  return externalDirectories(outside, [])
}
