/**
 * The beads plugin on pi: the same shell gates the OpenCode plugin runs on `shell` and the
 * Claude Code hook runs on Bash, plus pi-only gates (`shared/claim-gate.ts`) and the
 * `beads_preflight` tool. `bd prime` context is left to pi-beads-companion.
 *
 * Every bash call gets this session's store pin and actor as a fixed command prefix: pi has
 * no hook into a shell child's environment, and a foreground subagent shares the parent's
 * process environment, so the prefix is the only per-session place for them.
 */

import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { isMutatingBdCommand } from "@srobroek/opencode-lib/bd-actor-gate"
import { embeddedWriteRunner, resolveBdTargets } from "@srobroek/opencode-lib/bd-embedded-write-lock"
import { sessionPinFor } from "@srobroek/opencode-lib/beads-store"
import { readSessionHeader, type SessionHeaderView } from "@srobroek/opencode-lib/pi-session-header"
import { readGitWrappers } from "@srobroek/opencode-lib/git-wrappers"
import { loadPiOptionsFile } from "@srobroek/opencode-lib/pi-options"
import { Type } from "typebox"
import { contentionAdvisory } from "../opencode/src/claims.ts"
import { type BdRun, bdStoreDir, GateAdmitter, lifecycleBdEnvironment, runBdResult } from "../opencode/src/gate-admission.ts"
import { actorEnvironment, decideShell, type ShellGateDeps, TOOL_CALL_BUDGET_MS } from "../opencode/src/shell-gates.ts"
import { pinnedEnvironment, selectionExports, selectStore, withoutInheritedPin } from "../opencode/src/store-pin.ts"
import {
  decideBeadWork,
  existingDirectory,
  heldClaimArgs,
  holdsClaim,
  type WorkRefusal,
  writeClaimRefusal,
} from "../shared/claim-gate.ts"
import { isSubagentChild, piActor, sessionLineage } from "../shared/pi-session.ts"
import { APPLY_NOTE, optionsError, type PreflightDeps, runPreflight, systemDeps } from "../shared/preflight.ts"

/** How long a store pin lookup (a `git rev-parse`) is reused. */
const PIN_CACHE_MS = 5_000

/**
 * The directory this bundle sits in, where the build puts `bd-embedded-write-runner.js`. pi
 * loads an extension through jiti, which keeps `import.meta.url` on the file but evaluates the
 * module from a `data:` URL, so Bun's own `import.meta.dir` does not name the directory.
 */
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url))

/** How long a child's confirmed claim lets its file writes through without asking bd again. */
export const HELD_CACHE_MS = 30_000

/** The options file in pi's agent directory: `{ "gitWrappers": [...] }`, the only beads option pi reads. */
export const OPTIONS_FILE = "beads.json"

/** Most call ids remembered across plugin instances before the oldest are forgotten. */
const MAX_CLAIMED_CALLS = 1_000

/**
 * Call ids some instance of this extension already gated, shared by every instance in the
 * process. A detached pi-subagents runner can load the extension twice (ambient discovery and
 * `defaultSubagentOnlyExtensions`); only the first instance gates and prefixes a call.
 */
function claimedCalls(): Set<string> {
  const key = Symbol.for("com.srobroek.beads.pi.gated-calls.v1")
  const existing = Reflect.get(globalThis, key)
  if (existing instanceof Set) return existing as Set<string>
  const created = new Set<string>()
  Reflect.set(globalThis, key, created)
  return created
}

/** Claim a call for this instance; `false` when another instance already gates it. */
function claimCall(calls: Set<string>, key: string): boolean {
  if (calls.has(key)) return false
  calls.add(key)
  if (calls.size > MAX_CLAIMED_CALLS) {
    const oldest = calls.values().next().value
    if (oldest !== undefined) calls.delete(oldest)
  }
  return true
}

/**
 * Run `task` with the process held open. The gates' `bd` reads are unreferenced so a slow one
 * cannot hold an OpenCode server open, but `pi -p` exits as soon as nothing referenced is
 * left, which would end the run in the middle of a gate.
 */
export async function keptAlive<T>(task: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {}, 1_000)
  try {
    return await task()
  } finally {
    clearInterval(timer)
  }
}

/** One refusal as the reason pi shows the model, worded as the Claude Code hook words it. */
export function refusalText(refusal: WorkRefusal): string {
  return `${refusal.cause}; ${refusal.resolution}. (beads gate ${refusal.gate})`
}

/** Who a session is: the actor its `bd` calls write under, and whether pi-subagents started it. */
export type SessionIdentity = { actor: string; child: boolean }

/** A tool path as pi's file tools resolve it: an `@` prefix dropped, `~` expanded, relative to `cwd`. */
export function toolPath(path: string, cwd: string): string {
  const plain = path.startsWith("@") ? path.slice(1) : path
  const expanded = plain === "~" ? homedir() : plain.startsWith("~/") ? `${homedir()}${plain.slice(1)}` : plain
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

/** Seams for tests; production passes none. */
export type BeadsPiDeps = {
  env?: NodeJS.ProcessEnv
  run?: BdRun
  admitter?: GateAdmitter
  pinFor?: (cwd: string) => string | undefined
  readHeader?: (file: string) => SessionHeaderView | undefined
  runnerLookup?: ShellGateDeps["runnerLookup"]
  repositoryControl?: ShellGateDeps["repositoryControl"]
  preflight?: (env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal) => PreflightDeps
  now?: () => number
  /** Replaces `<agentDir>/beads.json`. */
  optionsPath?: string
}

type Pending = { command: string; advisories: string[] }

export function setupBeadsPi(pi: ExtensionAPI, deps: BeadsPiDeps = {}): void {
  const run = deps.run ?? runBdResult
  const admitter = deps.admitter ?? new GateAdmitter(deps.run)
  const now = deps.now ?? Date.now
  const pinFor = deps.pinFor ?? sessionPinFor
  const readHeader = deps.readHeader ?? readSessionHeader
  // A pi started from a shell this plugin pinned inherits that pin; each session resolves its own.
  const baseEnv = (): NodeJS.ProcessEnv => withoutInheritedPin(deps.env ?? process.env)
  const loaded = loadPiOptionsFile(
    deps.optionsPath ?? join(getAgentDir(), OPTIONS_FILE),
    "beads",
    "close evidence counts only `git` as git",
  )
  const gitWrappers = readGitWrappers(loaded.options)
  const calls = claimedCalls()
  const pins = new Map<string, { at: number; pin: string | undefined }>()
  const identities = new Map<string, SessionIdentity>()
  const pending = new Map<string, Pending>()
  const held = new Map<string, number>()

  const cachedPinFor = (cwd: string): string | undefined => {
    const hit = pins.get(cwd)
    if (hit !== undefined && now() - hit.at < PIN_CACHE_MS) return hit.pin
    const pin = pinFor(cwd)
    pins.set(cwd, { at: now(), pin })
    return pin
  }

  const identityOf = (ctx: ExtensionContext): SessionIdentity => {
    const manager = ctx.sessionManager
    const id = manager.getSessionId()
    const known = identities.get(id)
    if (known !== undefined) return known
    const parentSession = manager.getHeader()?.parentSession
    const header = parentSession === undefined || parentSession === "" ? { id } : { id, parentSession }
    const identity = {
      actor: piActor(sessionLineage(header, readHeader)),
      child: isSubagentChild({ env: deps.env ?? process.env, parentSession, sessionFile: manager.getSessionFile() }),
    }
    identities.set(id, identity)
    return identity
  }

  const gateBash = async (input: { command?: unknown }, callID: string, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
    const command = input.command
    if (typeof command !== "string" || command.trim() === "") return undefined
    const { actor } = identityOf(ctx)
    const cwd = ctx.cwd
    const selection = selectStore(cwd, baseEnv(), cachedPinFor)
    const deadline = now() + TOOL_CALL_BUDGET_MS
    const decision = await decideShell(command, cwd, {
      options: undefined,
      actor,
      env: selection.env,
      admitter,
      callID,
      deadline,
      runnerLookup: deps.runnerLookup ?? (() => embeddedWriteRunner(EXTENSION_DIR)),
      repositoryControl: deps.repositoryControl,
    })
    if (decision.kind === "block") return { block: true, reason: refusalText(decision) }
    const work = await decideBeadWork(command, cwd, {
      actor,
      env: selection.env,
      deadline,
      run,
      targets: resolveBdTargets(command, cwd, selection.env),
      gitWrappers,
    })
    if (work !== undefined) return { block: true, reason: refusalText(work) }
    input.command = [...selectionExports(selection), decision.command].join("\n")
    pending.set(callID, { command, advisories: decision.advisories })
    return undefined
  }

  const gateWrite = async (input: { path?: unknown }, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
    const { actor, child } = identityOf(ctx)
    if (!child || typeof input.path !== "string" || input.path === "") return undefined
    const target = toolPath(input.path, ctx.cwd)
    const dir = existingDirectory(target)
    const store = cachedPinFor(dir)
    if (store === undefined) return undefined
    const key = `${store}\0${actor}`
    const verified = held.get(key)
    if (verified !== undefined && now() - verified < HELD_CACHE_MS) return undefined
    const env = lifecycleBdEnvironment(dir, { ...pinnedEnvironment(dir, baseEnv(), cachedPinFor), BEADS_DIR: store })
    const answer = await run(dir, heldClaimArgs(actor), now() + TOOL_CALL_BUDGET_MS, env)
    const holds = "failure" in answer ? undefined : holdsClaim(answer.output)
    if (holds === true) {
      held.set(key, now())
      return undefined
    }
    const failure = "failure" in answer ? answer.failure : holds === undefined ? "bd list printed no issue list" : undefined
    return { block: true, reason: refusalText(writeClaimRefusal(target, store, actor, failure)) }
  }

  pi.on("session_start", (_event, ctx) => {
    if (loaded.warning !== undefined && ctx.hasUI) ctx.ui.notify(loaded.warning, "warning")
    // Start the store's gate verification now, so the first mutation rarely waits for it.
    if (identityOf(ctx).child) return
    const env = lifecycleBdEnvironment(ctx.cwd, pinnedEnvironment(ctx.cwd, baseEnv(), cachedPinFor))
    if (bdStoreDir(ctx.cwd, env) !== undefined) admitter.verify(ctx.cwd, env)
  })

  pi.on("tool_call", async (event, ctx) => {
    const isBash = event.toolName === "bash"
    const isWrite = event.toolName === "edit" || event.toolName === "write"
    if (!isBash && !isWrite) return undefined
    if (!claimCall(calls, `${ctx.sessionManager.getSessionId()}\0${event.toolCallId}`)) return undefined
    // Both gates read the input defensively; `bash` and the file tools share no input shape.
    const input = event.input as { command?: unknown; path?: unknown }
    return keptAlive(() => (isBash ? gateBash(input, event.toolCallId, ctx) : gateWrite(input, ctx)))
  })

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return undefined
    const call = pending.get(event.toolCallId)
    if (call === undefined) return undefined
    pending.delete(event.toolCallId)
    // A claim, release or close changes what a child holds; ask bd again before its next write.
    if (isMutatingBdCommand(call.command)) held.clear()
    const output = event.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    const contention = contentionAdvisory(output)
    const advisories = contention === undefined ? call.advisories : [...call.advisories, contention]
    if (advisories.length === 0) return undefined
    return { content: [...event.content, { type: "text" as const, text: advisories.join("\n\n") }] }
  })

  pi.registerTool({
    name: "beads_preflight",
    label: "Beads preflight",
    description:
      "Run the read-only Beads readiness checks of the beads-preflight skill and return its JSON report ({ok, summary, checks}).",
    promptSnippet: "Run the read-only Beads readiness checks (beads-preflight)",
    parameters: Type.Object({
      only: Type.Optional(Type.Array(Type.String(), { description: "Check ids to run, in order (preflight.py --only)" })),
      include_slow: Type.Optional(Type.Boolean({ description: "Also run the open-bead lease scan (--include-slow)" })),
      timeout: Type.Optional(Type.Number({ description: "Per-command timeout in seconds, default 60 (--timeout)" })),
      apply: Type.Optional(Type.Boolean({ description: "Report that no check has a safe automatic fix (--apply)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const options = { only: params.only, includeSlow: params.include_slow, timeoutSeconds: params.timeout }
      const invalid = optionsError(options)
      if (invalid !== undefined) throw new Error(invalid)
      // The checks see what this session's bash calls see: its store pin and its actor.
      const env = actorEnvironment(pinnedEnvironment(ctx.cwd, baseEnv(), cachedPinFor), identityOf(ctx).actor)
      const report = await runPreflight(options, (deps.preflight ?? systemDeps)(env, ctx.cwd, signal))
      const content = [{ type: "text" as const, text: JSON.stringify(report) }]
      if (params.apply === true) content.push({ type: "text", text: APPLY_NOTE })
      return { content, details: report }
    },
  })
}

export default function (pi: ExtensionAPI): void {
  setupBeadsPi(pi)
}
