/*
 * The `push-via` guard: on a host where plain `git push` to one forge cannot work, a wrapper
 * command (for example `dgit`) is the only way to push. With `pushVia: { host, command }` set,
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
import { SAFE_GIT_ARGS, untrustedLocalGitEnv } from "@srobroek/opencode-lib/safe-git"
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
  const env = untrustedLocalGitEnv(inherited)
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

// A word with no quote, escape, expansion, glob, brace or tilde in it: its source text is its value.
const LITERAL = /^[A-Za-z0-9_./@:+=,%-]+$/

const literalWords = (command: Command): boolean =>
  command.words !== undefined &&
  command.words.length === command.argv.length &&
  command.argv.every((word, i) => {
    const at = command.words?.[i]
    return at !== undefined && command.source.slice(at.start, at.end) === word && LITERAL.test(word)
  })

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
  const { help, remote } = pushArgs(push.args)
  if (help) return undefined
  let urls: string[] | undefined
  try {
    urls = resolveRemote(push.dir, remote)
  } catch {
    return undefined
  }
  return urls?.some((url) => hostOf(url) === config.host) ? { dir: push.dir } : undefined
}
