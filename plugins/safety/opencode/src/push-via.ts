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
import { base, type Command, gitInvocation } from "./shell.ts"

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

// System config is root-owned, so unlike repository config it is trusted: the real push reads it, including
// any `insteadOf`/`pushInsteadOf` rule in it, and the resolver must see the same. `untrustedLocalGitEnv` turns it
// off; this puts it back. Repository config stays hardened by SAFE_GIT_ARGS. `overrides` is a test seam
// (`GIT_CONFIG_SYSTEM` relocates the system file); production passes none.
function childEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const { GIT_CONFIG_NOSYSTEM: _off, ...hardened } = untrustedLocalGitEnv(inherited)
  return { ...hardened, ...overrides }
}

type Environment = Readonly<Record<string, string | undefined>>

function git(cwd: string, args: string[], env: Record<string, string>): string[] | undefined {
  const result = spawnSync("git", [...SAFE_GIT_ARGS, "-C", cwd, ...args], { encoding: "utf8", timeout: 5_000, env })
  if (result.status !== 0) return undefined
  const lines = result.stdout.split("\n").filter((line) => line !== "")
  return lines.length === 0 ? undefined : lines
}

// Reads local config only; never contacts a remote. A remote name goes through
// `remote get-url --push --all` (`pushurl` and `pushInsteadOf` apply, every URL is listed). Only a word that is
// not a configured remote and looks like a URL or path is an explicit URL: it goes through `ls-remote --get-url`
// (git's own `insteadOf` rewrite, printed without connecting), unless a `pushInsteadOf` rule exists, which that
// command does not apply and this guard does not model, so the destination is unknown.
export function gitRemoteResolver(inherited: Environment, overrides: Readonly<Record<string, string>> = {}): RemoteResolver {
  const env = childEnv(inherited, overrides)
  return (cwd, remote) => {
    if (remote !== undefined) {
      const named = git(cwd, ["remote", "get-url", "--push", "--all", "--", remote], env)
      if (named !== undefined || !/[/:]/.test(remote)) return named
      if (git(cwd, ["config", "--get-regexp", "^url\\..*\\.pushinsteadof$"], env) !== undefined) return undefined
      return git(cwd, ["ls-remote", "--get-url", "--", remote], env)
    }
    const branch = git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], env)?.[0]
    const configured = (key: string) => git(cwd, ["config", "--get", key], env)?.[0]
    const name =
      (branch === undefined ? undefined : configured(`branch.${branch}.pushRemote`)) ??
      configured("remote.pushDefault") ??
      (branch === undefined ? undefined : configured(`branch.${branch}.remote`)) ??
      "origin"
    return git(cwd, ["remote", "get-url", "--push", "--all", "--", name], env)
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

// `include.path` and `includeIf.*` pull in whole config files, which can hold any of the others.
const CONFIG_KEY = /^(?:remote|url|branch|include|includeif)\./i

// The one `cd` the caller has already applied to `cwd`: exactly what the shared `leadingCdCwd` accepts.
// Anything it declines (quotes, `~`, `$`, globs) leaves `cwd` unmoved, so the directory is unknown.
const UNMOVED = "\0unmoved"
function isLeadingCd(command: Command): boolean {
  return (
    command.index === 0 &&
    command.context === "top" &&
    command.argv.length === 2 &&
    base(command.argv[0]) === "cd" &&
    leadingCdCwd(command.source, UNMOVED) !== UNMOVED
  )
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
// An `env` option that unsets or clears variables (`-u`, `-i`, `--unset`, `--ignore-environment`, or a cluster holding them).
const ENV_UNSETS = /(?:^|\s)(?:--unset\b|--ignore-environment\b|-[A-Za-z]*[iu])/

// Whether an `env` wrapper in front of `command` may have unset or cleared variables the config lookup relies on.
function envUnsets(command: Command): boolean {
  if (!command.wrappers.includes("env")) return false
  const start = command.words?.[0]?.start
  return start === undefined || ENV_UNSETS.test(command.source.slice(0, start))
}

const hasDotDot = (path: string) => path.split("/").includes("..")

// Whether the inherited environment selects a repository or injects config (the guard then fails open).
export function repositorySelected(env: Readonly<Record<string, string | undefined>> | undefined): boolean {
  return Object.keys(env ?? {}).some((name) => SELECTOR.test(name))
}

// The push to judge: the first command of the call, or the one after a leading `cd DIR &&`. Anything
// that runs before it (a commit's hooks, a redirect into `.git/config`, `fetch --set-upstream`, a
// build) can change where the push goes, so any other position is not judged.
function judgedCommand(commands: readonly Command[]): Command | undefined {
  const [first, second] = commands
  if (first === undefined) return undefined
  const push = isLeadingCd(first) ? second : first
  return push?.context === "top" ? push : undefined
}

// The first command of the call, when it is a plain `git push` to `config.host`; otherwise `undefined`.
// Fails open for every other shape: later commands, nested shells, substitutions, redirects on the push.
export function pushVia(
  commands: readonly Command[],
  cwd: string,
  config: PushViaConfig,
  resolveRemote: RemoteResolver,
): PushRefusal | undefined {
  if (commands.some((command) => SELECTOR.test(command.source) || CONFIG_HOME.test(command.source))) return undefined
  if (commands.some((command) => command.context === "substitution")) return undefined
  const command = judgedCommand(commands)
  if (command === undefined || base(command.argv[0]) !== "git" || command.redirects.length > 0) return undefined
  const invocation = gitInvocation(command.argv)
  if (invocation?.subcommand !== "push" || invocation.overridden) return undefined
  if (configOverride(command.argv, invocation.offset - 1) || envUnsets(command)) return undefined
  // A `..` after a symlink resolves physically in git but lexically here.
  const directories = [...command.directories, ...invocation.chdirs]
  if (directories.some(hasDotDot)) return undefined
  const { help, remote } = pushArgs(invocation.args)
  if (help) return undefined
  const dir = directories.reduce((at, chdir) => resolve(at, chdir), cwd)
  let urls: string[] | undefined
  try {
    urls = resolveRemote(dir, remote)
  } catch {
    return undefined
  }
  return urls?.some((url) => hostOf(url) === config.host) ? { dir } : undefined
}
