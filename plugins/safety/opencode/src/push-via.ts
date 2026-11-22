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
// `remote get-url --push --all` (`pushurl` and `pushInsteadOf` apply, every URL is listed); a URL
// or path goes through `ls-remote --get-url`, git's own `insteadOf` rewrite, which prints without connecting.
export function gitRemoteResolver(inherited: Readonly<Record<string, string | undefined>>): RemoteResolver {
  return (cwd, remote) => {
    if (remote !== undefined && /[/:]/.test(remote)) return git(cwd, ["ls-remote", "--get-url", "--", remote], inherited)
    let name = remote
    if (name === undefined) {
      const branch = git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], inherited)?.[0]
      const configured = (key: string) => git(cwd, ["config", "--get", key], inherited)?.[0]
      name =
        (branch === undefined ? undefined : configured(`branch.${branch}.pushRemote`)) ??
        configured("remote.pushDefault") ??
        (branch === undefined ? undefined : configured(`branch.${branch}.remote`)) ??
        "origin"
    }
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
    if (arg.startsWith("-o") && arg.length === 2) i++
  }
  return { help, remote: positional[0] ?? repo }
}

const CD_FAMILY: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "chdir"])
const CONFIG_KEY = /^(?:remote|url|branch)\./i

function changesDirectory(command: Command): boolean {
  const [first, second] = command.argv
  if (CD_FAMILY.has(base(first))) return true
  return (first === "builtin" || first === "command") && second !== undefined && CD_FAMILY.has(second)
}

// The one `cd` the caller has already applied to `cwd` (`leadingCdCwd`): `cd DIR && …` at the start of the call.
function isLeadingCd(command: Command): boolean {
  return (
    command.index === 0 &&
    command.context === "top" &&
    command.argv.length === 2 &&
    /^\s*cd\s+[^\s;&|]+\s*&&/.test(command.source)
  )
}

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

// The first plain `git push` to `config.host`, or `undefined`.
export function pushVia(
  commands: readonly Command[],
  cwd: string,
  config: PushViaConfig,
  resolveRemote: RemoteResolver,
): PushRefusal | undefined {
  if (commands.some((command) => command.source.includes("GIT_CONFIG"))) return undefined
  for (const command of commands) {
    if (base(command.argv[0]) !== "git") continue
    const invocation = gitInvocation(command.argv)
    if (invocation?.subcommand !== "push" || invocation.overridden) continue
    if (configOverride(command.argv, invocation.offset - 1)) continue
    if (directoryUncertain(commands, command)) continue
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
