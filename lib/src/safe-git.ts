import { devNull } from "node:os"

/** Config git applies before any repository, user or system config (`-c` outranks them). */
type ConfigPair = readonly [key: string, value: string]

/**
 * `core.fsmonitor` is a program `git status` executes and `core.hooksPath` selects
 * hooks, so a hostile checkout's own config could run code.
 */
const SAFE_GIT_CONFIG: readonly ConfigPair[] = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", devNull],
]

/**
 * Git's global options for every command that runs inside a checkout this tool does
 * not control (a landed worktree, or another repository's checkout).
 *
 * Command-line `-c` outranks repository config. `--no-optional-locks` keeps a read from
 * writing the index.
 */
export const SAFE_GIT_ARGS = [...SAFE_GIT_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]), "--no-optional-locks"] as const

/**
 * Everything in `SAFE_GIT_CONFIG`, plus the programs git runs while it reads history:
 * a global attributes file, and the signature verifiers that `log.showSignature` (also
 * `stash list`) starts for a signed commit.
 */
const HARDENED_GIT_CONFIG: readonly ConfigPair[] = [
  ...SAFE_GIT_CONFIG,
  ["core.attributesFile", devNull],
  ["log.showSignature", "false"],
  ["gpg.program", devNull],
  ["gpg.ssh.program", devNull],
  ["gpg.x509.program", devNull],
  // `wt merge` commits and rebases: signing would run gpg.ssh.defaultKeyCommand.
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["gpg.ssh.defaultKeyCommand", ""],
  // Defense in depth: a lazy fetch would run these (GIT_NO_LAZY_FETCH=1 already stops it).
  ["core.sshCommand", ""],
  ["credential.helper", ""],
  // An empty command makes git fail instead of running one, so a hostile diff.external cannot execute.
  ["diff.external", ""],
]

/** The empty tree: as the attribute source, no path selects a `filter=`, `diff=` or `merge=` driver. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** The oldest git that honours `GIT_NO_LAZY_FETCH` (2.45) and has `GIT_ATTR_SOURCE`, which the hardening needs. */
export const GIT_MIN_VERSION = [2, 45, 0] as const

/** `[major, minor, patch]` from `git --version` output, or undefined when it does not parse. */
export function parseGitVersion(text: string): [number, number, number] | undefined {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** The refusal shown when git is older than `GIT_MIN_VERSION` or its version cannot be read. */
export const GIT_VERSION_MESSAGE = "subagent-worktree needs git 2.45+ for safe automatic merges"

/** Why `git --version` output is not usable for hardened runs, or undefined when it is. An unreadable version fails closed. */
export function gitVersionProblem(text: string): string | undefined {
  const version = parseGitVersion(text)
  if (!version) return GIT_VERSION_MESSAGE
  for (const [index, minimum] of GIT_MIN_VERSION.entries()) {
    const have = version[index] ?? 0
    if (have > minimum) return undefined
    if (have < minimum) return GIT_VERSION_MESSAGE
  }
  return undefined
}

/**
 * Inherited variables that select the repository, work tree or index, name a program git runs, write a trace
 * file or change what a read sees. They are dropped before the hardening is applied: a `GIT_DIR` or
 * `GIT_INDEX_FILE` in the host environment would point `git -C <lane>` at another repository, and the
 * program variables would run what the `-c` overrides below blank.
 */
const INHERITED_GIT_VARIABLES = [
  // Another repository, work tree, index or object store than the one `-C` names.
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_REPLACE_REF_BASE",
  "GIT_GRAFT_FILE",
  "GIT_SHALLOW_FILE",
  // A config file only `git config` reads, so a preflight and the command would see different config.
  "GIT_CONFIG",
  // Programs git runs.
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  // Pathspec switches change what a read sees.
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
] as const

/** Non-`GIT_` variables that git reads to pick a program. */
const PROGRAM_VARIABLES = ["PAGER", "EDITOR", "VISUAL", "SSH_ASKPASS"] as const

/**
 * The environment for a child that runs git, directly or through `wt` or `gh`. It carries the hardening as
 * `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` (command scope, like `-c`), so a child's own git calls inherit it. Any inherited command-scope config is dropped first.
 * `GIT_ATTR_SOURCE` (the empty tree) keeps worktree `.gitattributes` from selecting a driver.
 */
export function hardenedGitEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {}
  const dropped = new Set<string>([...INHERITED_GIT_VARIABLES, ...PROGRAM_VARIABLES])
  for (const [key, value] of Object.entries(base)) {
    // Inherited command-scope config goes too: a `core.worktree` there redirects every read, and GIT_CONFIG_PARAMETERS
    // can set the settings this function pins. Only the overrides below are installed.
    if (value === undefined || dropped.has(key) || key.startsWith("GIT_TRACE")) continue
    if (key === "GIT_CONFIG_PARAMETERS" || key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) continue
    env[key] = value
  }
  let count = 0
  for (const [key, value] of HARDENED_GIT_CONFIG) {
    env[`GIT_CONFIG_KEY_${count}`] = key
    env[`GIT_CONFIG_VALUE_${count}`] = value
    count += 1
  }
  env.GIT_CONFIG_COUNT = String(count)
  env.GIT_ATTR_SOURCE = EMPTY_TREE
  env.GIT_OPTIONAL_LOCKS = "0"
  env.GIT_NO_LAZY_FETCH = "1"
  return env
}

/**
 * The git arguments that list every configured key, NUL-terminated; {@link filterDriverOverrides}
 * picks the filter drivers out. A `--get-regexp` would skip a key that is not valid in the locale's
 * encoding, and with it the driver. Run them in the same directory, with the same environment, as the
 * command they protect: git then evaluates conditional includes (`includeIf`) and per-worktree config the
 * same way for both. An empty listing exits 1.
 *
 * `GIT_ATTR_SOURCE` keeps the work tree's `.gitattributes` from selecting a driver, but `.git/info/attributes`
 * is still read, so a command that hashes work-tree files also needs the drivers disabled by name.
 */
export const FILTER_DRIVER_LISTING = ["config", "--name-only", "-z", "--list"] as const

/**
 * `-c` options that disable every filter driver a {@link FILTER_DRIVER_LISTING} output names, so a command that
 * hashes work-tree files runs no clean or process filter. That includes drivers from the user's global config,
 * git-lfs among them. Undefined when the listing is malformed or a driver name is not UTF-8 or contains `=`, since
 * `-c` cannot name such a driver; the caller must then not run the command.
 *
 * Not covered: a submodule's own drivers when `git status` recurses into it, and a config that changes between
 * the listing and the command.
 */
export function filterDriverOverrides(listing: string): string[] | undefined {
  const keys = listing.split("\0")
  if (keys.pop() !== "") return undefined
  const drivers = new Set<string>()
  for (const key of keys) {
    const last = key.lastIndexOf(".")
    // A key is `filter.<driver>.<variable>`, and `<driver>` may be empty; a two-part `filter.<variable>` names no driver.
    if (!key.startsWith("filter.") || last < "filter.".length) continue
    drivers.add(key.slice("filter.".length, last))
  }
  // Output is decoded as UTF-8 with replacement, so U+FFFD marks a name that was not UTF-8.
  if ([...drivers].some((driver) => driver.includes("=") || driver.includes("\uFFFD"))) return undefined
  return [...drivers].flatMap((driver) =>
    ["clean=", "smudge=", "process=", "required=false"].flatMap((setting) => ["-c", `filter.${driver}.${setting}`]),
  )
}
