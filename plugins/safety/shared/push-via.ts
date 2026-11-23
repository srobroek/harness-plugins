/*
 * The `push-via` guard: on a host where plain `git push` to one forge cannot work, a wrapper
 * command (for example a host-specific git wrapper) is the only way to push. With `pushVia: { host, command }` set,
 * a literal `git push` whose remote resolves to `host` is refused with a hint to use the wrapper.
 *
 * Scope, by the user's decision: only a call whose first command is a literal `git push`, or
 * `git -C <literal dir> push`, is judged. Command wrappers, inline assignments, expansions,
 * substitutions, quoting, redirects, nested shells and any earlier command pass unchecked.
 * Chasing git's config and environment through those shapes never converged, so the guard stays
 * a convenience that saves a doomed network call and is not a security boundary. It also fails
 * open when the remote cannot be resolved.
 */

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { hardenedGitEnv, SAFE_GIT_ARGS } from "@srobroek/opencode-lib/safe-git"
import type { Command } from "./shell.ts"

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
export function gitRemoteResolver(inherited: Environment): RemoteResolver {
  const env = hardenedGitEnv(inherited)
  return (cwd, remote) => {
    if (remote !== undefined) {
      const named = git(cwd, ["remote", "get-url", "--push", "--all", "--", remote], env)
      if (named !== undefined || !/[/:]/.test(remote)) return named
      if (git(cwd, ["config", "--get-regexp", "^url\\..*\\.pushinsteadof$"], env) !== undefined) return undefined
      return git(cwd, ["ls-remote", "--get-url", "--", remote], env)
    }
    const branch = git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], env)?.[0]
    const configured = (key: string) => git(cwd, ["config", "--get", key], env)?.[0]
    // git's order (remote.c: remotes_pushremote_for_branch, remotes_remote_for_branch): the branch's pushRemote,
    // `remote.pushDefault`, the branch's remote, the only configured remote when there is exactly one, else `origin`.
    const remotes = git(cwd, ["remote"], env)
    if (remotes === undefined) return undefined
    const name =
      (branch === undefined ? undefined : configured(`branch.${branch}.pushRemote`)) ??
      configured("remote.pushDefault") ??
      (branch === undefined ? undefined : configured(`branch.${branch}.remote`)) ??
      (remotes.length === 1 ? remotes[0] : undefined) ??
      "origin"
    return git(cwd, ["remote", "get-url", "--push", "--all", "--", name], env)
  }
}

// Every long option of `git push` (git-push(1)); git accepts any unique prefix, and `--no-` forms of the boolean ones.
const VALUED_LONG = ["repo", "push-option", "receive-pack", "exec", "recurse-submodules"]
const BOOLEAN_LONG = [
  "all", "branches", "prune", "mirror", "delete", "tags", "follow-tags", "atomic", "dry-run", "porcelain", "force",
  "force-if-includes", "thin", "progress", "verbose", "quiet", "set-upstream", "verify", "ipv4", "ipv6", "help",
]
const OTHER_LONG = ["force-with-lease", "signed", "no-push-option"]
const LONG_OPTIONS = [...VALUED_LONG, ...OTHER_LONG, ...BOOLEAN_LONG, ...BOOLEAN_LONG.map((name) => `no-${name}`)]

type LongOption = { name: string; valued: boolean }

// The option a `--name` stands for: an exact match, else the only option it prefixes; `undefined` when it is
// unknown or ambiguous (git would refuse the call or pick differently, so the destination is not judged).
function longOption(name: string): LongOption | undefined {
  const matches = LONG_OPTIONS.includes(name) ? [name] : LONG_OPTIONS.filter((long) => name !== "" && long.startsWith(name))
  const only = matches[0]
  return matches.length === 1 && only !== undefined ? { name: only, valued: VALUED_LONG.includes(only) } : undefined
}

type PushArgs = { help: boolean; unknown: boolean; remote: string | undefined }

// git takes a positional repository over `--repo`; `-o`/`--push-option` and the other valued options consume their value.
function pushArgs(args: readonly string[]): PushArgs {
  let help = false
  let unknown = false
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
      const option = longOption(name)
      if (option === undefined) {
        unknown = true
        continue
      }
      if (option.name === "help") help = true
      if (!option.valued) continue
      const value = rest.length > 0 ? rest.join("=") : args[++i]
      if (option.name === "repo") repo = value
      continue
    }
    // A short cluster (`-vo VALUE`): `o` takes the rest of the cluster, or the next word when it ends it.
    if (/^-[A-Za-z0-9]+$/.test(arg) && arg.endsWith("o") && arg.slice(1).indexOf("o") === arg.length - 2) i++
  }
  return { help, unknown, remote: positional[0] ?? repo }
}

export type PushRefusal = {
  /** The directory the push would run in, which the hint repeats. */
  dir: string
}

// Variables that select the repository or inject config in the session; git reads them where this guard cannot.
const SELECTOR = /GIT_(?:CONFIG|DIR|WORK_TREE|COMMON_DIR)/

// Whether the inherited environment selects a repository or injects config (the guard then fails open).
export function repositorySelected(env: Environment | undefined): boolean {
  return Object.keys(env ?? {}).some((name) => SELECTOR.test(name))
}

// A word the shell passes on as written: unquoted, nothing to expand (no parameter, substitution, tilde, glob or brace).
const literalWords = (command: Command): boolean =>
  command.words !== undefined &&
  command.words.length === command.argv.length &&
  command.words.every((word, i) => !word.quoted && !word.expands && command.source.slice(word.start, word.end) === command.argv[i])

// The directory of a literal `git [-C DIR]... push ARGS`, with the push arguments; `undefined` for any other shape.
function literalPush(command: Command | undefined, cwd: string): { dir: string; args: string[] } | undefined {
  if (command === undefined || command.context !== "top" || command.argv[0] !== "git") return undefined
  if (command.wrappers.length > 0 || command.assignments.length > 0 || command.redirects.length > 0) return undefined
  const first = command.words?.[0]
  if (first === undefined || command.source.slice(0, first.start).trim() !== "") return undefined
  if (!literalWords(command)) return undefined
  let dir = cwd
  let i = 1
  while (command.argv[i] === "-C") {
    const chdir = command.argv[i + 1]
    // A `..` after a symlink resolves physically in git but lexically here.
    if (chdir === undefined || chdir.split("/").includes("..")) return undefined
    dir = resolve(dir, chdir)
    i += 2
  }
  return command.argv[i] === "push" ? { dir, args: command.argv.slice(i + 1) } : undefined
}

// The first command of the call, when it is a literal `git push` to `config.host`; otherwise `undefined`.
export function pushVia(
  commands: readonly Command[],
  cwd: string,
  config: PushViaConfig,
  resolveRemote: RemoteResolver,
): PushRefusal | undefined {
  const push = literalPush(commands[0], cwd)
  if (push === undefined) return undefined
  const { help, unknown, remote } = pushArgs(push.args)
  if (help || unknown) return undefined
  let urls: string[] | undefined
  try {
    urls = resolveRemote(push.dir, remote)
  } catch {
    return undefined
  }
  return urls?.some((url) => hostOf(url) === config.host) ? { dir: push.dir } : undefined
}
