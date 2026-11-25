// The `git_read` tool: read-only git history and branch inspection for a reviewer subagent that has no
// shell. `git-read-policy.ts` decides the argv; this file runs it with the hardening of lib/src/safe-git.ts,
// every configured filter driver disabled, a timeout and an output cap.

import path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { FILTER_DRIVER_LISTING, filterDriverOverrides, gitVersionProblem, hardenedGitEnv } from "@srobroek/opencode-lib/safe-git"
import { killChild, supervise } from "@srobroek/opencode-lib/subprocess"
import { Type } from "typebox"
import { GIT_READ_SUBCOMMANDS, gitReadArgs } from "./git-read-policy.ts"

export const GIT_READ = "git_read"
/** Bound on one read; a larger log or diff should be narrowed by range, path or `-n`. */
export const GIT_READ_TIMEOUT_MS = 30_000
/** Pi's built-in tool output limit: stdout past it is cut and git is stopped. */
export const GIT_READ_MAX_BYTES = 50 * 1024
const MAX_STDERR_BYTES = 8 * 1024
/** A config listing larger than this fails closed rather than leave a filter driver enabled. */
const MAX_CONFIG_LISTING_BYTES = 1024 * 1024

type GitRun = { exitCode: number | undefined; stdout: string; stderr: string; truncated: boolean; ended?: "timeout" | "aborted" | "lost" }

/** Forward at most `max` bytes of `source`; on the first byte past it, call `onFull` and end the stream. */
function capped(source: unknown, max: number, onFull: () => void): unknown {
  if (!(source instanceof ReadableStream)) return source
  const reader = (source as ReadableStream<Uint8Array>).getReader()
  let room = max
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (chunk.done) return controller.close()
      if (chunk.value.byteLength > room) {
        controller.enqueue(chunk.value.subarray(0, room))
        room = 0
        onFull()
        void reader.cancel().catch(() => undefined)
        return controller.close()
      }
      room -= chunk.value.byteLength
      controller.enqueue(chunk.value)
    },
    cancel: () => reader.cancel().catch(() => undefined),
  })
}

/** Run `git <args>` hardened, in its own process group, so a timeout or the output cap ends git and its children. */
async function runGit(args: readonly string[], cwd: string, signal: AbortSignal | undefined, maxBytes: number): Promise<GitRun> {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: hardenedGitEnv(Bun.env), detached: true })
  let truncated = false
  const guarded = {
    pid: child.pid,
    exited: child.exited,
    get signalCode() {
      return child.signalCode
    },
    kill: (code?: number | NodeJS.Signals) => child.kill(code),
    stdout: capped(child.stdout, maxBytes, () => {
      truncated = true
      killChild(child, true)
    }),
    stderr: capped(child.stderr, MAX_STDERR_BYTES, () => undefined),
  }
  const run = await supervise(guarded, { timeoutMs: GIT_READ_TIMEOUT_MS, signal, group: true })
  if (run.kind === "exited") return { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, truncated }
  return { exitCode: undefined, stdout: run.stdout, stderr: run.stderr, truncated, ended: run.kind }
}

let supported: Promise<boolean> | undefined

/** Whether the installed git honours the hardening (2.45+); read once per process, and an unreadable version fails closed. */
function gitSupported(): Promise<boolean> {
  supported ??= runGit(["--version"], process.cwd(), undefined, 1024).then(
    (run) => run.exitCode === 0 && gitVersionProblem(run.stdout) === undefined,
    () => false,
  )
  return supported
}

/** `-c` options that disable every filter driver configured for `cwd`, or undefined when they cannot be listed. */
async function filterOverrides(cwd: string, signal: AbortSignal | undefined): Promise<string[] | undefined> {
  const listing = await runGit(FILTER_DRIVER_LISTING, cwd, signal, MAX_CONFIG_LISTING_BYTES)
  if (listing.truncated) return undefined
  if (listing.exitCode === 1 && listing.stdout === "") return []
  return listing.exitCode === 0 ? filterDriverOverrides(listing.stdout) : undefined
}

export type GitReadParams = { subcommand: string; args?: string[]; path?: string }
export type GitReadResult = { text: string; isError: boolean; details: { args: string[]; exitCode: number | null; truncated: boolean } | { refused: string } }

function refused(reason: string): GitReadResult {
  return { text: `git_read refused: ${reason}. Nothing ran.`, isError: true, details: { refused: reason } }
}

/** One `git_read` call: the policy decision, then the hardened run, as the text and details the model sees. */
export async function gitRead(params: GitReadParams, cwd: string, signal?: AbortSignal): Promise<GitReadResult> {
  const decision = gitReadArgs(params.subcommand, params.args ?? [])
  if (!decision.allowed) return refused(decision.reason)
  if (!(await gitSupported())) return refused("git 2.45 or newer is required for hardened reads")
  const directory = params.path === undefined ? cwd : path.resolve(cwd, params.path)
  const overrides = await filterOverrides(directory, signal)
  if (overrides === undefined) return refused("the configured filter drivers could not be listed or disabled")
  const { args } = decision
  const run = await runGit([...overrides, ...args], directory, signal, GIT_READ_MAX_BYTES)
  if (run.truncated) {
    const note = `[git_read: output cut at ${GIT_READ_MAX_BYTES / 1024} KB and git stopped; narrow the range, add paths, or use --stat or -n]`
    return { text: `${run.stdout}\n${note}`, isError: false, details: { args, exitCode: null, truncated: true } }
  }
  if (run.exitCode === undefined) {
    const why = run.ended === "timeout" ? `timed out after ${GIT_READ_TIMEOUT_MS / 1_000}s` : "ended without an exit status"
    return { text: `git ${args.join(" ")} ${why}.\n${run.stderr}`.trim(), isError: true, details: { args, exitCode: null, truncated: false } }
  }
  const stderr = run.stderr.trim()
  const parts = [run.stdout, stderr === "" ? "" : `[stderr]\n${stderr}`, run.exitCode === 0 ? "" : `[exit ${run.exitCode}]`]
  const text = parts.filter((part) => part !== "").join("\n") || "(no output)"
  return { text, isError: run.exitCode !== 0, details: { args, exitCode: run.exitCode, truncated: false } }
}

const parameters = Type.Object(
  {
    subcommand: Type.Union(
      GIT_READ_SUBCOMMANDS.map((name) => Type.Literal(name)),
      { description: "The git subcommand" },
    ),
    args: Type.Optional(
      Type.Array(Type.String(), { description: 'Its arguments, one per element, never a shell string: ["--oneline", "main..feature"]' }),
    ),
    path: Type.Optional(Type.String({ description: "Directory to run in; defaults to the session directory" })),
  },
  { additionalProperties: false },
)

export default function registerGitRead(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool({
    name: GIT_READ,
    label: "Git Read",
    description:
      "Read-only git: log, show, diff, branch --list, rev-parse, merge-base, ls-files, cat-file -p/-t, ls-tree, for-each-ref. " +
      "Takes the subcommand and an argument array, no shell. Refuses every other subcommand and any option that writes a file or runs a program " +
      `(--output, --ext-diff, --textconv, --show-signature, --no-index, -o); spell options in full. Output is capped at ${GIT_READ_MAX_BYTES / 1024} KB.`,
    parameters,
    // Inactive until a child's tools list (`--tools`) or the defaultTools setting names it, so a main session keeps its own tool set.
    defaultActive: false,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await gitRead(params, ctx.cwd, signal)
      return { content: [{ type: "text", text: result.text }], details: result.details, isError: result.isError }
    },
  })
}
