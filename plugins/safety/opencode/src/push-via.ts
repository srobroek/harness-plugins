/*
 * The `push-via` guard: on a host where plain `git push` to one forge cannot work, a wrapper
 * command (for example `dgit`) is the only way to push. With `pushVia: { host, command }` set,
 * a plain `git push` whose remote resolves to `host` is refused with a hint to use the wrapper.
 *
 * Fails open: when the remote's host cannot be determined (no repository, unknown remote, git
 * missing, `--git-dir` in use) the push passes, because this is an operator convenience that
 * saves a doomed network call, not a security boundary.
 */

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { SAFE_GIT_ARGS, untrustedLocalGitEnv } from "@srobroek/opencode-lib/safe-git"
import { base, type Command, gitInvocation, positionals } from "./shell.ts"

export type PushViaConfig = { host: string; command: string }

// The URL a push to `remote` (or to the default push remote when `undefined`) would use, run in `cwd`.
export type RemoteResolver = (cwd: string, remote: string | undefined) => string | undefined

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

function git(cwd: string, args: string[], inherited: Readonly<Record<string, string | undefined>>): string | undefined {
  const result = spawnSync("git", [...SAFE_GIT_ARGS, "-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: untrustedLocalGitEnv(inherited),
  })
  if (result.status !== 0) return undefined
  const text = result.stdout.trim()
  return text === "" ? undefined : text
}

// Reads local config only (`remote get-url --push` applies `pushurl` and `insteadOf`); never contacts a remote.
export function gitRemoteResolver(inherited: Readonly<Record<string, string | undefined>>): RemoteResolver {
  return (cwd, remote) => {
    let name = remote
    if (name === undefined) {
      const branch = git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], inherited)
      const configured = (key: string) => git(cwd, ["config", "--get", key], inherited)
      name =
        (branch === undefined ? undefined : configured(`branch.${branch}.pushRemote`)) ??
        configured("remote.pushDefault") ??
        (branch === undefined ? undefined : configured(`branch.${branch}.remote`)) ??
        "origin"
    }
    return git(cwd, ["remote", "get-url", "--push", name], inherited)
  }
}

const PUSH_VALUED: ReadonlySet<string> = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"])

// The remote word of `git push`, if any: `--repo`, else the first positional.
function pushedRemote(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    const arg = args[i] as string
    if (arg.startsWith("--repo=")) return arg.slice("--repo=".length)
    if (arg === "--repo") return args[i + 1]
  }
  return positionals(args, PUSH_VALUED)[0]
}

function quoted(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`
}

// The refusal text for the first plain `git push` to `config.host`, or `undefined`.
export function pushVia(
  commands: readonly Command[],
  cwd: string,
  config: PushViaConfig,
  resolveRemote: RemoteResolver,
): string | undefined {
  for (const command of commands) {
    if (base(command.argv[0]) !== "git") continue
    const invocation = gitInvocation(command.argv)
    if (invocation?.subcommand !== "push") continue
    const remote = pushedRemote(invocation.args)
    const dir = [...command.directories, ...invocation.chdirs].reduce((at, chdir) => resolve(at, chdir), cwd)
    let url: string | undefined
    try {
      if (remote !== undefined && /[/:]/.test(remote)) url = remote
      else if (!invocation.overridden) url = resolveRemote(dir, remote)
    } catch {
      continue
    }
    if (url === undefined || hostOf(url) !== config.host) continue
    return `Blocked by safety (push-via-guard): a plain \`git push\` to ${config.host} cannot work on this host. Push with \`${config.command} -C ${quoted(dir)} push\` instead (same arguments), and push WIP often so commits are not lost.`
  }
  return undefined
}
