/**
 * Which git reads the `git_read` tool runs. Pure: it decides on the subcommand and arguments the model sent and
 * never starts git. Process hardening (config, environment, filter drivers, timeout, output cap) is `git-read.ts`.
 */

/** The subcommands `git_read` runs. Anything else, mutating or not, is refused. */
export const GIT_READ_SUBCOMMANDS = [
  "log",
  "show",
  "diff",
  "branch",
  "rev-parse",
  "merge-base",
  "ls-files",
  "cat-file",
  "ls-tree",
  "for-each-ref",
] as const
export type GitReadSubcommand = (typeof GIT_READ_SUBCOMMANDS)[number]

/** `args` is the argv after `git` and its global options: the subcommand, the forced guards, then the caller's arguments. */
export type GitReadDecision = { allowed: true; args: string[] } | { allowed: false; reason: string }

/**
 * Long options refused on every subcommand, with every abbreviation of them: git's option parser accepts a unique
 * prefix, so `--outp=x` is `--output=x`.
 */
const REFUSED_LONG_OPTIONS: ReadonlyArray<readonly [option: string, why: string]> = [
  ["output", "writes a file"],
  ["ext-diff", "runs an external diff program"],
  ["textconv", "runs a textconv program"],
  ["show-signature", "runs a signature verifier"],
  ["no-index", "reads files outside the repository"],
]

/** No listed subcommand needs `-o`, and other tools spell an output file with it. */
const REFUSED_SHORT_OPTIONS: ReadonlySet<string> = new Set(["-o"])

/** Forced on the subcommands that print diffs, so a repository's diff driver config runs no program. */
const DIFF_GUARDS = ["--no-ext-diff", "--no-textconv"] as const
const DIFF_SUBCOMMANDS: ReadonlySet<GitReadSubcommand> = new Set(["log", "show", "diff"])

/**
 * `branch` only lists: `--list` is required and every option must be one of these, so no form creates, deletes,
 * renames, copies, re-points or re-tracks a branch. Abbreviations and bundled short options are refused.
 */
const BRANCH_LIST_FLAGS: ReadonlySet<string> = new Set([
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "-i",
  "--ignore-case",
  "--no-abbrev",
  "--omit-empty",
  "--no-column",
  "--no-color",
])

/**
 * `branch --list` options that take a value, accepted only as `--<option>=<value>`: given separately, the value
 * argument could be `--list` itself, leaving the next argument to name a branch to create.
 */
const BRANCH_LIST_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
  "--abbrev",
  "--column",
  "--color",
])

/** `cat-file` prints one object's content (`-p`) or type (`-t`); `--batch`, `--filters` and `--textconv` are refused. */
const CAT_FILE_MODES: ReadonlySet<string> = new Set(["-p", "-t"])

export function isGitReadSubcommand(name: string): name is GitReadSubcommand {
  return (GIT_READ_SUBCOMMANDS as readonly string[]).includes(name)
}

/**
 * Why `arg` is refused on any subcommand, or undefined. Every argument is checked, including those after `--`: an
 * option that takes a separate value could swallow the `--` and leave the next argument parsed as an option.
 */
function refusedOption(arg: string): string | undefined {
  if (REFUSED_SHORT_OPTIONS.has(arg)) return `${arg} is refused`
  if (!arg.startsWith("--")) return undefined
  const name = arg.slice(2).split("=", 1)[0] ?? ""
  if (name === "") return undefined
  const match = REFUSED_LONG_OPTIONS.find(([option]) => option.startsWith(name))
  if (match === undefined) return undefined
  const [option, why] = match
  return name === option ? `--${option} ${why}` : `${arg} abbreviates --${option}, which ${why}; spell options in full`
}

function branchProblem(args: readonly string[]): string | undefined {
  if (!args.includes("--list")) return "branch runs only with --list"
  for (const arg of args) {
    if (!arg.startsWith("-") || BRANCH_LIST_FLAGS.has(arg)) continue
    const separator = arg.indexOf("=")
    const name = separator === -1 ? arg : arg.slice(0, separator)
    if (!BRANCH_LIST_VALUE_OPTIONS.has(name)) return `branch ${arg} is refused: only listing options run`
    if (separator === -1) return `branch ${arg} is refused: give its value as ${name}=<value>`
  }
  return undefined
}

function catFileProblem(args: readonly string[]): string | undefined {
  const [mode, object, ...rest] = args
  const valid = mode !== undefined && CAT_FILE_MODES.has(mode) && object !== undefined && !object.startsWith("-") && rest.length === 0
  return valid ? undefined : "cat-file runs only as `cat-file -p <object>` or `cat-file -t <object>`"
}

/** The argv for one read, or why it is refused. */
export function gitReadArgs(subcommand: string, args: readonly string[]): GitReadDecision {
  if (!isGitReadSubcommand(subcommand)) {
    return { allowed: false, reason: `${JSON.stringify(subcommand)} is not a git_read subcommand; use one of ${GIT_READ_SUBCOMMANDS.join(", ")}` }
  }
  for (const arg of args) {
    const why = refusedOption(arg)
    if (why !== undefined) return { allowed: false, reason: why }
  }
  const problem = subcommand === "branch" ? branchProblem(args) : subcommand === "cat-file" ? catFileProblem(args) : undefined
  if (problem !== undefined) return { allowed: false, reason: problem }
  return { allowed: true, args: [subcommand, ...(DIFF_SUBCOMMANDS.has(subcommand) ? DIFF_GUARDS : []), ...args] }
}
