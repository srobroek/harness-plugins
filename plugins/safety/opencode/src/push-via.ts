/*
 * The `push-via` guard: on a host where plain `git push` to one forge cannot work, a wrapper
 * command (for example `dgit`) is the only way to push. With `pushVia: { host, command }` set,
 * a plain `git push` whose remote resolves to `host` is refused with a hint to use the wrapper.
 *
 * Fails open: when the destination is uncertain the push passes. That covers an unresolvable
 * remote (no repository, unknown remote, git missing, `--git-dir`), a directory that a `cd`,
 * `pushd` or a wrapper's `-C` may have changed, and a config override (`-c`, `--config-env`,
 * `GIT_CONFIG_*`) that can move the remote. The guard saves a doomed network call; it is not a
 * security boundary, so it never models git more than that.
 */

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { leadingCdCwd } from "@srobroek/opencode-lib"
import { SAFE_GIT_ARGS, untrustedLocalGitEnv } from "@srobroek/opencode-lib/safe-git"
import { base, type Command, gitInvocation, SHELLS } from "./shell.ts"

export type PushViaConfig = { host: string; command: string }

// The effective push URLs for `remote` (a remote name, a URL or path, or `undefined` for the default
// push remote), run in `cwd`; `undefined` when git cannot say.
export type RemoteResolver = (cwd: string, remote: string | undefined) => string[] | undefined

const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// `{ pushVia: { host, command } }`; anything malformed leaves the guard off.
export function readPushVia(options: Readonly<Record<string, unknown>> | undefined): PushViaConfig | undefined {
  const raw = options?.pushVia
  if (typeof raw !== "object" || raw === null) return undefined
  const { host, command } = raw as Record<string, unknown>
  if (typeof host !== "string" || typeof command !== "string") return undefined
  if (!HOST.test(host) || !COMMAND.test(command)) return undefined
  return { host: host.toLowerCase(), command }
}

// The lower-case host of a remote URL (`scheme://` or scp-like `[user@]host:path`); `undefined` for a path or a name.
export function hostOf(url: string): string | undefined {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)/.exec(url)
  let authority: string | undefined
  if (scheme) {
    if (scheme[1]?.toLowerCase() === "file") return undefined
    authority = scheme[2]?.replace(/^.*@/, "").replace(/:\d*$/, "")
  } else {
    authority = /^(?:[^@/:]+@)?([^/:@]+):/.exec(url)?.[1]
  }
  return authority ? authority.toLowerCase() : undefined
}

function git(cwd: string, args: string[], inherited: Readonly<Record<string, string | undefined>>): string[] | undefined {
  const result = spawnSync("git", [...SAFE_GIT_ARGS, "-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: untrustedLocalGitEnv(inherited),
  })
  if (result.status !== 0) return undefined
  const lines = result.stdout.split("\n").filter((line) => line !== "")
  return lines.length === 0 ? undefined : lines
}

// Reads local config only; never contacts a remote. A remote name goes through
// `remote get-url --push --all` (`pushurl` and `pushInsteadOf` apply, every URL is listed). Only a word that is
// not a configured remote and looks like a URL or path is an explicit URL: it goes through `ls-remote --get-url`
// (git's own `insteadOf` rewrite, printed without connecting), unless a `pushInsteadOf` rule exists, which that
// command does not apply and this guard does not model, so the destination is unknown.
export function gitRemoteResolver(inherited: Readonly<Record<string, string | undefined>>): RemoteResolver {
  return (cwd, remote) => {
    if (remote !== undefined) {
      const named = git(cwd, ["remote", "get-url", "--push", "--all", "--", remote], inherited)
      if (named !== undefined || !/[/:]/.test(remote)) return named
      if (git(cwd, ["config", "--get-regexp", "^url\\..*\\.pushinsteadof$"], inherited) !== undefined) return undefined
      return git(cwd, ["ls-remote", "--get-url", "--", remote], inherited)
    }
    const branch = git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], inherited)?.[0]
    const configured = (key: string) => git(cwd, ["config", "--get", key], inherited)?.[0]
    const name =
      (branch === undefined ? undefined : configured(`branch.${branch}.pushRemote`)) ??
      configured("remote.pushDefault") ??
      (branch === undefined ? undefined : configured(`branch.${branch}.remote`)) ??
      "origin"
    return git(cwd, ["remote", "get-url", "--push", "--all", "--", name], inherited)
  }
}

// Long options of `git push` that take a value, and long options sharing a prefix with them
// that git would otherwise report as ambiguous.
const VALUED_LONG = ["repo", "push-option", "receive-pack", "exec"]
const OTHER_LONG = ["recurse-submodules"]

function valuedLong(name: string): string | undefined {
  if (VALUED_LONG.includes(name)) return name
  if (name.length < 3) return undefined
  const matches = [...VALUED_LONG, ...OTHER_LONG].filter((long) => long.startsWith(name))
  const only = matches[0]
  return matches.length === 1 && only !== undefined && VALUED_LONG.includes(only) ? only : undefined
}

type PushArgs = { help: boolean; remote: string | undefined }

// git takes a positional repository over `--repo`; `-o`/`--push-option` and the other valued options consume their value.
function pushArgs(args: readonly string[]): PushArgs {
  let help = false
  let repo: string | undefined
  const positional: string[] = []
  let options = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!options || !arg.startsWith("-") || arg === "-") {
      positional.push(arg)
      continue
    }
    if (arg === "--") {
      options = false
      continue
    }
    if (arg === "-h" || arg === "--help") {
      help = true
      continue
    }
    if (arg.startsWith("--")) {
      const [name = "", ...rest] = arg.slice(2).split("=")
      const valued = valuedLong(name)
      if (valued === undefined) continue
      const value = rest.length > 0 ? rest.join("=") : args[++i]
      if (valued === "repo") repo = value
      continue
    }
    // A short cluster (`-vo VALUE`): `o` takes the rest of the cluster, or the next word when it ends it.
    if (/^-[A-Za-z0-9]+$/.test(arg) && arg.endsWith("o") && arg.slice(1).indexOf("o") === arg.length - 2) i++
  }
  return { help, remote: positional[0] ?? repo }
}

const CD_FAMILY: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "chdir"])
// `include.path` and `includeIf.*` pull in whole config files, which can hold any of the others.
const CONFIG_KEY = /^(?:remote|url|branch|include|includeif)\./i

function changesDirectory(command: Command): boolean {
  const [first, second] = command.argv
  if (CD_FAMILY.has(base(first))) return true
  return (first === "builtin" || first === "command") && second !== undefined && CD_FAMILY.has(second)
}

// The one `cd` the caller has already applied to `cwd`: exactly what the shared `leadingCdCwd` accepts.
// Anything it declines (quotes, `~`, `$`, globs) leaves `cwd` unmoved, so the directory is unknown.
function isLeadingCd(command: Command): boolean {
  return (
    command.index === 0 &&
    command.context === "top" &&
    command.argv.length === 2 &&
    leadingCdCwd(command.source, UNMOVED) !== UNMOVED
  )
}
const UNMOVED = "\0unmoved"

// Whether a `cd`, or a wrapper's directory around a nested shell, may have moved the shell before `command` runs.
function directoryUncertain(commands: readonly Command[], command: Command): boolean {
  for (const earlier of commands) {
    if (earlier.index >= command.index) break
    if (changesDirectory(earlier) && !isLeadingCd(earlier)) return true
    if (command.context !== "top" && earlier.directories.length > 0) return true
  }
  return false
}

// Whether a global `-c`/`--config-env` option names a key that can change where the push goes.
function configOverride(argv: readonly string[], end: number): boolean {
  for (let i = 1; i < end; i++) {
    const word = argv[i] as string
    let entry: string | undefined
    if (word === "-c" || word === "--config-env") entry = argv[++i]
    else if (word.startsWith("--config-env=")) entry = word.slice("--config-env=".length)
    else if (word.startsWith("-c") && word.length > 2) entry = word.slice(2)
    if (entry !== undefined && CONFIG_KEY.test(entry)) return true
  }
  return false
}

export type PushRefusal = {
  /** The directory the push would run in, which the hint repeats. */
  dir: string
}

// Variables that select the repository or inject config; git reads them where this guard cannot.
const SELECTOR = /GIT_(?:CONFIG|DIR|WORK_TREE|COMMON_DIR)/
// `HOME` or `XDG_CONFIG_HOME` set in the call moves the global config; reading `$HOME` does not.
const CONFIG_HOME = /(?:^|[\s;&|(])(?:HOME|XDG_CONFIG_HOME)=/

// Commands that never change a remote, a branch or config, so a push after them still goes where it did before.
const READ_ONLY: ReadonlySet<string> = new Set(["echo", "printf", "true", "false", ":", "pwd", "test", "[", "[[", "eval"])
const GIT_LOCAL: ReadonlySet<string> = new Set([
  "add",
  "commit",
  "status",
  "log",
  "diff",
  "show",
  "tag",
  "fetch",
  "rm",
  "mv",
  "restore",
  "reset",
  "stash",
  "blame",
  "rev-parse",
  "ls-files",
])

// Whether `command` could change a remote, a branch or config. Unknown programs, scripts and git aliases could.
function mayChangeGitState(command: Command): boolean {
  const name = base(command.argv[0])
  if (command.argv.length === 0 || READ_ONLY.has(name) || CD_FAMILY.has(name)) return false
  // A shell given `-c` has its script walked as commands of its own; a script file is opaque.
  if (SHELLS.has(name)) return !command.argv.includes("-c")
  const invocation = gitInvocation(command.argv)
  if (invocation !== undefined) return !GIT_LOCAL.has(invocation.subcommand)
  return true
}

// Whether a command that runs before `push` (earlier in the call, or inside a substitution) could change
// where the push goes; the destination is then read from state the call is about to alter.
function stateMayChange(commands: readonly Command[], push: Command): boolean {
  return commands.some(
    (other) =>
      other !== push && (other.index < push.index || other.context === "substitution") && mayChangeGitState(other),
  )
}

const hasDotDot = (path: string) => path.split("/").includes("..")

// Whether the inherited environment selects a repository or injects config (the guard then fails open).
export function repositorySelected(env: Readonly<Record<string, string | undefined>> | undefined): boolean {
  return Object.keys(env ?? {}).some((name) => SELECTOR.test(name))
}

// The first plain `git push` to `config.host`, or `undefined`.
export function pushVia(
  commands: readonly Command[],
  cwd: string,
  config: PushViaConfig,
  resolveRemote: RemoteResolver,
): PushRefusal | undefined {
  if (commands.some((command) => SELECTOR.test(command.source) || CONFIG_HOME.test(command.source))) return undefined
  for (const command of commands) {
    if (base(command.argv[0]) !== "git") continue
    const invocation = gitInvocation(command.argv)
    if (invocation?.subcommand !== "push" || invocation.overridden) continue
    if (configOverride(command.argv, invocation.offset - 1)) continue
    if (directoryUncertain(commands, command) || stateMayChange(commands, command)) continue
    // A `..` after a symlink resolves physically in git but lexically here.
    if ([...command.directories, ...invocation.chdirs].some(hasDotDot)) continue
    const { help, remote } = pushArgs(invocation.args)
    if (help) continue
    const dir = [...command.directories, ...invocation.chdirs].reduce((at, chdir) => resolve(at, chdir), cwd)
    let urls: string[] | undefined
    try {
      urls = resolveRemote(dir, remote)
    } catch {
      continue
    }
    if (urls?.some((url) => hostOf(url) === config.host)) return { dir }
  }
  return undefined
}
