import { randomUUID } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { withEmbeddedWriteLock } from "@srobroek/opencode-lib/bd-embedded-write-lock"
import { hostWarn, type Warn } from "@srobroek/opencode-lib/host-log"
import { withLease } from "@srobroek/opencode-lib/lease-lock"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { classifyScope, deadlineAt, type Invocation, parseInvocation, type RunOptions } from "./args.ts"
import { automationRequest, type TickBinding } from "./automation.ts"
import { Activity, BD_READ_TIMEOUT_MS, childFrom, commitCount, readBeads, type SessionView, sessionBusy } from "./gather.ts"
import { type JournalEntry, LOG_INPUT_SCHEMA, validateEntry } from "./journal.ts"
import {
  DENY_QUESTION,
  EXTERNAL_DIRECTORY,
  endsWithQuestion,
  grantedMergeAsk,
  identifyRoot,
  isAskTool,
  type Lstat,
  MERGE_ACTION,
  MERGE_METHODS,
  mergeOutcome,
  mergeRefusal,
  mergeResource,
  ownWorktreeAsk,
  REPROMPT,
  type RootIdentity,
  recordableLane,
  rootIntact,
} from "./policy.ts"
import { autopilotRoot, findRun, type Run, RunDir, RunFileError, runCommand } from "./rundir.ts"
import { countBeads, newRunState, type RunState, runIdFor, type Snapshot, TICK_MS, tick, tickPrompt } from "./state.ts"
import { HANDOFF_LABEL, handoffDescription, renderSummary } from "./summary.ts"
import { realClock, Ticks } from "./timer.ts"

export * from "./args.ts"
export * from "./automation.ts"
export * from "./gather.ts"
export * from "./journal.ts"
export * from "./policy.ts"
export * from "./rundir.ts"
export * from "./state.ts"
export * from "./state-schema.ts"
export * from "./summary.ts"

export const ID = "srobroek.autopilot"
export const SKILL = "autopilot"
const SKILL_FILE = fileURLToPath(new URL("../skills/autopilot/SKILL.md", import.meta.url))

export const STATUS_DESCRIPTION =
  "Autopilot run state: rebuilds it from beads, git, child sessions and the journal, evaluates stop conditions.\n" +
  'action "status" (default) reports; "arm" ends setup with the answered values and returns the tick automation to create; ' +
  '"tick" is what the automation calls; "fallback" starts the in-process timer when automation_create failed; "stop" ends the run, writes summary.md and the handoff bead.'

export const LOG_DESCRIPTION = "Append one validated entry (decision, blocker, issue, ambiguity, stop, progress, action) to the autopilot journal."

export const MERGE_DESCRIPTION =
  "Merge one PR at one reviewed head, under --allow merge.\n" +
  "Requires an approval for the exact SHA and green checks; merges only if the head is still that SHA."

export const COMMAND_DESCRIPTION = "Run this session unattended: /autopilot [scope] [flags] | resume | review | stop"

const STATUS_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["status", "arm", "tick", "fallback", "stop"] },
    run: { type: "string", description: "run id; default this session's run" },
    setup: {
      type: "object",
      description: "arm: answers from the setup round",
      additionalProperties: false,
      properties: {
        scope: { type: "string" },
        full: { type: "boolean" },
        allow: { type: "array", items: { type: "string", enum: ["merge", "deploy"] } },
        lanes: { type: "integer", minimum: 1 },
        for: { type: "string", description: "duration such as 3h" },
        until_time: { type: "string", description: "HH:MM" },
        until: { type: "string" },
      },
    },
    automation_id: { type: "string", description: "arm: the created automation id" },
    reason: { type: "string", description: "stop: why" },
    token: { type: "string", description: "tick: the automation's binding token" },
    session: { type: "string", description: "tick: the session the automation was created for" },
  },
} as const

const MERGE_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["pr", "sha", "method"],
  properties: {
    pr: { type: ["integer", "string"], description: "PR number" },
    method: { type: "string", enum: [...MERGE_METHODS], description: "the repository's merge method; the repo must allow it" },
    sha: { type: "string", description: "the full 40-digit head commit that was reviewed" },
  },
} as const

type StatusInput = {
  action?: "status" | "arm" | "tick" | "fallback" | "stop"
  run?: string
  setup?: { scope?: string; full?: boolean; allow?: ("merge" | "deploy")[]; lanes?: number; for?: string; until_time?: string; until?: string }
  automation_id?: string
  reason?: string
  token?: string
  session?: string
}

/** The binding a run's ticks must carry. */
export function bindingOf(state: Pick<RunState, "tick" | "sessionID">): TickBinding {
  return { token: state.tick.token ?? "", session: state.sessionID }
}

/** Why a tick is not for the run's current automation, or `undefined` when it is. */
export function staleTick(state: Pick<RunState, "tick" | "sessionID">, input: { token?: string; session?: string }): string | undefined {
  if (state.tick.token === undefined || input.token !== state.tick.token) return "this tick's automation is not the run's current one; it ends here"
  if (input.session !== state.sessionID) return `the run is bound to ${state.sessionID}, not ${input.session ?? "no session"}; this automation ends here`
  return undefined
}

/** The title of a run's handoff bead, which is also how a retried stop finds it. */
export const handoffTitle = (runId: string) => `Autopilot handoff: run ${runId}`

/** The `id` of the JSON object in `bd ... --json` output, or `undefined`. */
export function parseId(stdout: string): string | undefined {
  try {
    const value = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf("{")))) as { id?: unknown }
    return typeof value.id === "string" ? value.id : undefined
  } catch {
    return undefined
  }
}

type Armed = { runId: string; root: string }

/** The permission hook's payload. */
export type PermissionEvaluation = { sessionID: string; action: string; resources: ReadonlyArray<string>; effect: "allow" | "deny" | "ask"; message?: string }

/** How many turns in a row that end in a question get a re-prompt before the plugin waits for the next tick. */
export const MAX_REPROMPTS = 2

/** A bound on child-session pages per tick (100 sessions each). */
const MAX_CHILD_PAGES = 50

export type WriteLock = <T>(cwd: string, owner: string, write: () => Promise<T>) => Promise<{ kind: "done"; value: T } | { kind: "failed"; reason: string }>

const embeddedLock: WriteLock = (cwd, owner, write) => withEmbeddedWriteLock(cwd, owner, write)

export type Deps = { run?: Run; now?: () => number; ticks?: Ticks; lock?: WriteLock; warn?: Warn }

/** How long a state transition waits for another instance's hold on the run lock. */
const RUN_LOCK_WAIT_MS = 60_000

/** The storage page size startup asks for; it follows `next` until the scan ends. */
const STORAGE_PAGE = 100

/** A run lock that could not be taken: the transition did not run. */
class RunLockBusy extends Error {}

/** The real path of `path`, or `undefined` when it does not exist. */
const realPath = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** `lstat` without following the last component; `undefined` when the path is gone. dev and ino are strings, since an inode can exceed 2^53. */
const lstatProbe: Lstat = (path) => {
  try {
    const stat = lstatSync(path, { bigint: true })
    return { isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink(), dev: String(stat.dev), ino: String(stat.ino) }
  } catch {
    return undefined
  }
}

/** Whether `directory` carries a linked worktree's `.git` file (the primary checkout has a `.git` directory). */
const hasGitFile = (directory: string): boolean => {
  const marker = lstatProbe(join(directory, ".git"))
  return marker !== undefined && !marker.isDirectory && !marker.isSymbolicLink
}

/** One `gh` call. */
const GH_TIMEOUT_MS = 60_000

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Text of the last assistant message in a session's context, best effort. */
export function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: unknown; type?: unknown; content?: unknown; parts?: unknown; text?: unknown }
    const role = message?.role ?? message?.type
    if (role !== "assistant") continue
    const texts: string[] = []
    const collect = (value: unknown) => {
      if (typeof value === "string") texts.push(value)
      else if (Array.isArray(value)) for (const item of value) collect(item)
      else if (value && typeof value === "object") {
        const part = value as { type?: unknown; text?: unknown }
        if (part.type === "text" && typeof part.text === "string") texts.push(part.text)
      }
    }
    collect(message.content ?? message.parts ?? message.text)
    return texts.join("\n")
  }
  return ""
}

/** Apply setup answers to the options the command line gave. */
export function applySetup(options: RunOptions, setup: StatusInput["setup"]): RunOptions | { error: string } {
  const next: RunOptions = { ...options }
  if (!setup) return next
  if (setup.scope !== undefined) next.scope = setup.scope
  if (setup.full !== undefined) next.full = setup.full
  if (setup.allow !== undefined) next.allow = setup.allow
  if (setup.lanes !== undefined) next.lanes = setup.lanes
  if (setup.until !== undefined && setup.until.trim() !== "") next.until = setup.until
  const flags: string[] = []
  if (setup.for) flags.push("--for", setup.for)
  if (setup.until_time) flags.push("--until-time", setup.until_time)
  if (flags.length) {
    const parsed = parseInvocation(flags.join(" "))
    if (parsed.kind === "error") return { error: parsed.message }
    if (parsed.kind === "start") {
      delete next.forMs
      delete next.untilTime
      if (parsed.options.forMs !== undefined) next.forMs = parsed.options.forMs
      if (parsed.options.untilTime !== undefined) next.untilTime = parsed.options.untilTime
    }
  }
  return next
}

/** The prompt `/autopilot` sends to start the setup round. */
export function setupPrompt(runId: string, invocation: Extract<Invocation, { kind: "start" }>): string {
  const given = JSON.stringify(invocation.options)
  const missing = invocation.missing.length ? invocation.missing.join(", ") : "none"
  return [
    `Autopilot run ${runId} is in setup. Load the ${SKILL} skill and follow it.`,
    `Given on the command line: ${given}. Still to ask: ${missing}.`,
    invocation.missing.length
      ? 'Ask every missing value in ONE parley_ask round (fall back to the question tool), with a recommendation for each; lanes take any whole number, recommend 3. Then call autopilot_status with action "arm" and the answers in setup.'
      : 'Nothing to ask: call autopilot_status with action "arm" now.',
    "After arming, never ask the user anything until the run stops.",
  ].join("\n")
}

export class Autopilot {
  readonly activity: Activity
  readonly armed = new Map<string, Armed>()
  readonly #run: Run
  readonly #now: () => number
  readonly #ticks: Ticks
  readonly #lock: WriteLock
  readonly #warn: Warn
  readonly #reprompts = new Map<string, number>()
  readonly #serial = new Map<string, Promise<unknown>>()
  /** File errors already journaled, so a hook that fires on every call logs each one once. */
  readonly #reported = new Set<string>()

  constructor(
    readonly ctx: Context,
    deps: Deps = {},
  ) {
    this.#run = deps.run ?? runCommand
    this.#now = deps.now ?? Date.now
    this.#warn = deps.warn ?? (() => {})
    this.activity = new Activity(this.#now)
    this.#ticks = deps.ticks ?? new Ticks(realClock, this.#warn)
    this.#lock = deps.lock ?? embeddedLock
  }

  /**
   * Re-arm every run in storage. A storage failure throws: the plugin cannot enforce runs it
   * cannot list. A run whose state cannot be read stays armed, so its hooks keep failing closed.
   */
  async load(): Promise<void> {
    let after: string | undefined
    for (;;) {
      const page = await this.ctx.storage.scan({ prefix: "armed/", limit: STORAGE_PAGE, ...(after !== undefined ? { after } : {}) })
      for (const entry of page.entries) {
        const value = entry.value as Partial<Armed> | null
        if (typeof value?.runId === "string" && typeof value.root === "string") this.armed.set(entry.key.slice("armed/".length), { runId: value.runId, root: value.root })
        else this.#warn("ignored an armed-run record with an unexpected shape", { key: entry.key })
      }
      if (page.next === undefined || page.entries.length === 0) break
      after = page.next
    }
    for (const [sessionID, armed] of this.armed) {
      const dir = new RunDir(armed.root, armed.runId)
      try {
        const state = dir.readState()
        // A stopping run still needs its ticks: they retry the stop artifacts that did not land.
        if ((state?.phase === "running" || state?.phase === "stopping") && state.tick.kind === "fallback") this.#startFallback(sessionID, state.tick.token)
      } catch (error) {
        this.#report(dir, error)
      }
    }
  }

  /** Journal a run file failure as a blocker once, and warn when even that fails. */
  #report(dir: RunDir, error: unknown): string {
    const message = errorText(error)
    if (this.#reported.has(message)) return message
    this.#reported.add(message)
    this.#warn("run file error", { run: dir.runId, error: message })
    try {
      dir.append({ ts: new Date(this.#now()).toISOString(), type: "blocker", summary: `autopilot could not use its run files: ${message}`, parked: true })
    } catch (appendError) {
      this.#warn("could not journal a run file error", { run: dir.runId, error: errorText(appendError) })
    }
    return message
  }

  dispose(): void {
    this.#ticks.dispose()
  }

  async #arm(sessionID: string, armed: Armed): Promise<void> {
    this.armed.set(sessionID, armed)
    await this.ctx.storage.set(`armed/${sessionID}`, armed)
  }

  async #disarm(sessionID: string): Promise<void> {
    this.armed.delete(sessionID)
    this.#ticks.stop(sessionID)
    await this.ctx.storage.remove(`armed/${sessionID}`)
  }

  /** The armed lead session `sessionID` belongs to (itself or an ancestor), if any. */
  async leadFor(sessionID: string): Promise<string | undefined> {
    let id: string | undefined = sessionID
    for (let depth = 0; id && depth < 12; depth++) {
      if (this.armed.has(id)) return id
      let parent = this.activity.cachedParent(id)
      if (parent === undefined) {
        const info: { parentID?: string } | undefined = await this.ctx.session.get({ sessionID: id }).catch(() => undefined)
        parent = typeof info?.parentID === "string" && info.parentID !== "" ? info.parentID : null
        this.activity.rememberParent(id, parent ?? undefined)
      }
      id = parent ?? undefined
    }
    return undefined
  }

  /**
   * The run whose rules apply to `sessionID`, when it is running. A run whose state cannot be
   * read counts as running with `unreadable` set, so the hooks fail closed.
   */
  async runningFor(sessionID: string): Promise<{ lead: string; dir: RunDir; state?: RunState; unreadable?: string } | undefined> {
    const lead = await this.leadFor(sessionID)
    if (lead === undefined) return undefined
    const armed = this.armed.get(lead) as Armed
    const dir = new RunDir(armed.root, armed.runId)
    let state: RunState | undefined
    try {
      state = dir.readState()
    } catch (error) {
      return { lead, dir, unreadable: this.#report(dir, error) }
    }
    // A stopping run still enforces its rules: its artifacts are not written yet.
    return state?.phase === "running" || state?.phase === "stopping" ? { lead, dir, state } : undefined
  }

  #dirFor(sessionID: string, runId: string | undefined): RunDir | undefined {
    if (runId !== undefined) {
      for (const armed of this.armed.values()) if (armed.runId === runId) return new RunDir(armed.root, armed.runId)
    }
    const armed = this.armed.get(sessionID)
    return armed ? new RunDir(armed.root, armed.runId) : undefined
  }

  async snapshot(state: RunState, dir: RunDir): Promise<Snapshot> {
    const now = this.#now()
    const armedAt = state.armedAt ?? now
    const [beads, commits, kids, leadBusy] = await Promise.all([
      readBeads(state.directory, this.#run),
      commitCount(state.directory, this.#run),
      this.#children(state.sessionID),
      this.leadBusy(state.sessionID),
    ])
    const places = await this.#worktrees()
    const children = kids.sessions
      .filter((kid): kid is SessionView & { id: string } => typeof kid?.id === "string")
      .map((kid) => childFrom(kid, this.activity.lastSeen(kid.id), armedAt, this.#laneRoot(kid, places)))
    return {
      now,
      beads: beads.beads,
      ready: beads.ready,
      blocked: beads.blocked,
      beadsRead: beads.ok,
      commits,
      children,
      childrenComplete: kids.complete,
      journal: dir.journal(),
      leadBusy,
    }
  }

  /** Every direct child of `sessionID`, page by page, and whether the listing reached its end. */
  async #children(sessionID: string): Promise<{ sessions: SessionView[]; complete: boolean }> {
    const sessions: SessionView[] = []
    let page = await this.ctx.session.list({ parentID: sessionID, limit: 100 }).catch(() => undefined)
    for (let pages = 0; page && pages < MAX_CHILD_PAGES; pages++) {
      sessions.push(...(page.data as SessionView[]))
      const next = page.cursor?.next
      if (!next) return { sessions, complete: true }
      page = await this.ctx.session.list({ cursor: next, limit: 100 }).catch(() => undefined)
    }
    return { sessions, complete: false }
  }

  /** Whether the lead session is executing, from the host's own record so it holds across restarts. */
  async leadBusy(sessionID: string): Promise<boolean> {
    const info = await this.ctx.session.get({ sessionID }).catch(() => undefined)
    return sessionBusy(info as SessionView | undefined)
  }

  // --- commands -------------------------------------------------------------------------------

  async command(sessionID: string, text: string): Promise<string> {
    try {
      return await this.#command(sessionID, text)
    } catch (error) {
      if (error instanceof RunFileError || error instanceof RunLockBusy) return `autopilot: could not read or update the run: ${errorText(error)}`
      throw error
    }
  }

  async #command(sessionID: string, text: string): Promise<string> {
    const invocation = parseInvocation(text)
    const directory = await this.#sessionDirectory(sessionID)
    const root = await autopilotRoot(directory, this.#run)
    if (invocation.kind === "error") return `autopilot: ${invocation.message}`
    if (root === undefined) return "autopilot: not a git repository; the run directory lives under the git common dir."
    switch (invocation.kind) {
      case "start": {
        if (this.armed.has(sessionID)) return "autopilot: this session already has a run; use /autopilot stop first."
        const now = this.#now()
        const runId = runIdFor(now)
        const dir = new RunDir(root, runId)
        dir.create()
        await dir.writeState(undefined, newRunState({ runId, sessionID, directory, options: invocation.options, scope: classifyScope(invocation.options.scope), now }))
        await this.#arm(sessionID, { runId, root })
        return setupPrompt(runId, invocation)
      }
      case "stop": {
        const dir = this.#dirFor(sessionID, undefined)
        if (!dir) return "autopilot: no run in this session."
        const runId = await this.#exclusive(dir, async () => {
          const state = dir.readState()
          if (!state) return undefined
          if (state.phase === "running" || state.phase === "setup") await dir.writeState(state, { ...state, stopRequested: true })
          return state.runId
        })
        if (runId === undefined) return "autopilot: no run in this session."
        return `Autopilot stop requested for run ${runId}. Call autopilot_status with action "stop", delete the tick automation with tools.opencode.automation_delete if one exists, then print the summary and end.`
      }
      case "resume": {
        const dir = findRun(root, invocation.runId)
        if (!dir) return `autopilot: no run ${invocation.runId ?? "latest"} under ${root}.`
        // Validate and rebind inside the run's critical section, so a stop in flight wins. The new
        // token makes every tick of the old automation stale, and the old automation is named for deletion.
        const bound = await this.#exclusive(dir, async (): Promise<{ ok: false; message: string } | { ok: true; state: RunState; previous?: string }> => {
          const state = dir.readState()
          if (!state) return { ok: false, message: `autopilot: no run ${invocation.runId ?? "latest"} under ${root}.` }
          if (state.phase === "stopped" || state.phase === "stopping")
            return { ok: false, message: `autopilot: run ${state.runId} already stopped (${state.stopReason}); start a new one.` }
          for (const [other, armed] of this.armed) if (armed.runId === state.runId && other !== sessionID) await this.#disarm(other)
          const resumed = await dir.writeState(state, { ...state, sessionID, phase: "running", tick: { kind: "none", token: randomUUID() } })
          await this.#arm(sessionID, { runId: state.runId, root })
          return { ok: true, state: resumed, ...(state.tick.automationId ? { previous: state.tick.automationId } : {}) }
        })
        if (!bound.ok) return bound.message
        const state = bound.state
        const status = await this.status(sessionID, { action: "status", run: state.runId })
        return [
          `Autopilot run ${state.runId} resumed in this session. Load the ${SKILL} skill and follow it; no questions.`,
          ...(bound.previous
            ? [`Delete the previous tick automation first: tools.opencode.automation_delete({ id: "${bound.previous}" }). Its ticks no longer count either way.`]
            : []),
          `Create the tick automation with tools.opencode.automation_create(${JSON.stringify(automationRequest(state.runId, state.deadline, bindingOf(state)))}), then call autopilot_status with action "arm" and its automation_id; on failure call autopilot_status with action "fallback".`,
          `Status: ${JSON.stringify(status)}`,
        ].join("\n")
      }
      case "review": {
        const dir = findRun(root, invocation.runId)
        let summary: string | undefined
        try {
          summary = dir?.summary()
        } catch (error) {
          return `autopilot: could not read the summary of run ${dir?.runId}: ${errorText(error)}`
        }
        if (!dir || summary === undefined) return `autopilot: no summary for run ${invocation.runId ?? "latest"}.`
        return [
          `Review autopilot run ${dir.runId}. Summary from ${dir.summaryPath}:`,
          summary,
          'Open ONE parley_ask round with one question per "Needs input" item (recommend an answer for each), then apply the answers: update beads, unpark items, and close the handoff bead when nothing is left.',
        ].join("\n\n")
      }
    }
  }

  async #sessionDirectory(sessionID: string): Promise<string> {
    const info = await this.ctx.session.get({ sessionID }).catch(() => undefined)
    return info?.location?.directory ?? this.ctx.location.directory
  }

  // --- tools ----------------------------------------------------------------------------------

  /**
   * Every read-modify-write of one run's state, in order. In this process a promise chain keeps
   * them first-come first-served; across processes and plugin instances the lease file in the run
   * directory does. Inside, each transition reads the state again and writes it fenced by its
   * generation, so a tick that started before a stop never writes its running state over it.
   */
  async #exclusive<T>(dir: RunDir, work: () => Promise<T>): Promise<T> {
    const locked = async (): Promise<T> => {
      // A fresh owner per hold: a write checks that the run lease still names it before it renames.
      const owner = `${ID}/${process.pid}/${dir.runId}/${randomUUID()}`
      const held = await withLease(dir.lockPath, { owner, waitMs: RUN_LOCK_WAIT_MS }, async () => {
        dir.leaseOwner = owner
        try {
          return await work()
        } finally {
          dir.leaseOwner = undefined
        }
      })
      if (held.kind === "failed") throw new RunLockBusy(held.reason)
      return held.value
    }
    const before = this.#serial.get(dir.runId) ?? Promise.resolve()
    const turn = before.then(locked, locked)
    const settled = turn.then(
      () => undefined,
      () => undefined,
    )
    this.#serial.set(dir.runId, settled)
    try {
      return await turn
    } finally {
      if (this.#serial.get(dir.runId) === settled) this.#serial.delete(dir.runId)
    }
  }

  async status(sessionID: string, input: StatusInput): Promise<Record<string, unknown>> {
    const dir = this.#dirFor(sessionID, input.run)
    // A tick for a run this instance no longer arms (stopped, or resumed elsewhere) ends its automation.
    if (!dir && input.action === "tick") return { done: true, stale: `run ${input.run ?? "?"} is not armed; this automation ends here` }
    if (!dir) return { error: "no autopilot run for this session; start one with /autopilot" }
    try {
      return await this.#exclusive(dir, () => this.#statusLocked(dir, input))
    } catch (error) {
      if (error instanceof RunLockBusy) return { error: `run lock busy: ${error.message}; try again on the next tick` }
      if (!(error instanceof RunFileError)) throw error
      if (error.kind === "stale") {
        // Another writer created this generation first. Nothing was overwritten; the transition is
        // dropped and the next tick or call starts again from the latest state.
        this.#journalIssue(dir, `a state write lost to another writer and was not applied: ${error.message}`)
        return { error: `state moved on under this call (${error.message}); call again to act on the latest state`, stale: true }
      }
      const message = this.#report(dir, error)
      return {
        error: message,
        prompt: `Autopilot cannot use its run files: ${message}. It logged this as a blocker. Do not treat the run as finished; fix or report the file, then continue.`,
      }
    }
  }

  #journalIssue(dir: RunDir, summary: string): void {
    try {
      dir.append({ ts: new Date(this.#now()).toISOString(), type: "issue", summary })
    } catch (error) {
      this.#warn("could not journal an issue", { run: dir.runId, error: errorText(error) })
    }
  }

  async #statusLocked(dir: RunDir, input: StatusInput): Promise<Record<string, unknown>> {
    const state = dir.readState()
    if (!state) return { error: "no autopilot run for this session; start one with /autopilot" }
    const action = input.action ?? "status"
    if (action === "tick") {
      const stale = staleTick(state, input)
      if (stale !== undefined) return { done: true, stale }
    }
    if (action === "arm") return this.#armRun(dir, state, input)
    if (state.phase === "stopped") return { done: true, stopped: state.stopReason, summary: dir.summaryPath }
    if (state.phase === "stopping") return this.#finishStop(dir, state)
    if (action === "stop") return this.#beginStop(dir, state, input.reason ?? "stop requested")
    if (action === "fallback") {
      const token = state.tick.token ?? randomUUID()
      await dir.writeState(state, { ...state, tick: { ...state.tick, kind: "fallback", token } })
      this.#startFallback(state.sessionID, token)
      return { ok: true, tick: "fallback", every: TICK_MS }
    }
    if (state.phase !== "running") return { phase: state.phase, note: 'run is in setup: finish the setup round and call action "arm"' }
    if (action === "tick" && (await this.leadBusy(state.sessionID))) return { skip: "lead session busy" }
    const result = tick(state, await this.snapshot(state, dir))
    // Only a tick advances the run; a status read reports and leaves every signal for the next tick.
    if (action === "tick") {
      await dir.writeState(state, result.state)
      for (const due of result.actions)
        if (due.kind === "park") dir.append({ ts: new Date(this.#now()).toISOString(), type: "blocker", summary: due.reason, bead: due.item, parked: true })
    }
    const out = {
      ping: result.ping,
      progress: result.progress,
      newlyUnblocked: result.newlyUnblocked,
      actions: result.actions,
      beads: result.state.beads,
      parked: result.state.parked,
      idleTicks: action === "tick" ? result.state.idleTicks : state.idleTicks,
      ...(result.stop ? { stop: result.stop } : {}),
    }
    if (result.stop !== undefined && action === "tick")
      return { ...out, done: true, prompt: `Autopilot is stopping: ${result.stop}. Call autopilot_status with action "stop" and reason "${result.stop}", then print the summary and end.` }
    return { ...out, prompt: tickPrompt(result) }
  }

  async #armRun(dir: RunDir, state: RunState, input: StatusInput): Promise<Record<string, unknown>> {
    if (state.phase === "running") {
      let current = state
      if (input.automation_id || state.tick.token === undefined)
        current = await dir.writeState(state, {
          ...state,
          tick: { ...state.tick, token: state.tick.token ?? randomUUID(), ...(input.automation_id ? { kind: "automation" as const, automationId: input.automation_id } : {}) },
        })
      return { ok: true, phase: "running", automation: automationRequest(current.runId, current.deadline, bindingOf(current)) }
    }
    if (state.phase !== "setup") return { error: `run is ${state.phase}` }
    const options = applySetup(state.options, input.setup)
    if ("error" in options) return options
    const now = this.#now()
    const deadline = options.forMs !== undefined ? now + options.forMs : options.untilTime !== undefined ? deadlineAt(options.untilTime, now) : undefined
    const next: RunState = {
      ...state,
      phase: "running",
      armedAt: now,
      options: { ...options, allow: options.allow ?? [], lanes: options.lanes ?? 3, full: options.full ?? false },
      scope: classifyScope(options.scope),
      tick: { kind: "none", token: randomUUID() },
      ...(deadline !== undefined ? { deadline } : {}),
    }
    const first = tick(next, await this.snapshot(next, dir))
    const armed = await dir.writeState(state, { ...first.state, ticks: 0, idleTicks: 0 })
    dir.append({ ts: new Date(now).toISOString(), type: "action", summary: `armed: ${JSON.stringify(next.options)}` })
    return {
      ok: true,
      phase: "running",
      ping: first.ping,
      automation: automationRequest(armed.runId, deadline, bindingOf(armed)),
      next: 'Create the automation with tools.opencode.automation_create(automation), then call autopilot_status with action "arm" and automation_id. If creation fails, call action "fallback". No questions from now on.',
    }
  }

  /**
   * Decide the stop: move to `stopping` with the stop entry journaled and the journal length the
   * artifacts will render, then write them. Callers hold the run lock, and `autopilot_log` takes
   * the same lock, so an entry is either in that snapshot or written after the stop was decided.
   */
  async #beginStop(dir: RunDir, state: RunState, reason: string): Promise<Record<string, unknown>> {
    const now = this.#now()
    const fresh = await readBeads(state.directory, this.#run)
    const beads = fresh.ok ? countBeads(fresh, state.scope) : state.beads
    const stopReason = state.stopReason ?? reason
    dir.append({ ts: new Date(now).toISOString(), type: "stop", summary: stopReason })
    const journalLength = dir.journal().length
    const stopping = await dir.writeState(state, { ...state, beads, phase: "stopping", stopReason, stoppedAt: now, stop: { journalLength, summary: false } })
    return this.#finishStop(dir, stopping)
  }

  /**
   * Write whichever stop artifacts are missing, recording each in the state as it lands, and move
   * to `stopped` only when `summary.md` and the handoff bead both exist. A failure leaves the run
   * `stopping`; the next tick, status or stop call resumes here. The handoff bead is looked up by
   * its title before it is created, so a create whose state write failed is never repeated.
   */
  async #finishStop(dir: RunDir, stopping: RunState): Promise<Record<string, unknown>> {
    let state = stopping
    const progress = state.stop ?? { journalLength: dir.journal().length, summary: false }
    const journal = dir.journal().slice(0, progress.journalLength)
    const pending = (error: string) => ({
      phase: "stopping",
      error,
      prompt: `Autopilot is stopping but could not finish: ${error}. It retries on the next tick; call autopilot_status with action "stop" to retry now.`,
    })
    const summary = renderSummary(state, journal, dir.path)
    if (!progress.summary) {
      try {
        dir.writeSummary(summary)
      } catch (error) {
        return pending(this.#report(dir, error))
      }
      state = await dir.writeState(state, { ...state, stop: { ...progress, summary: true } })
    }
    let handoff = state.stop?.handoff
    if (handoff === undefined) {
      const title = handoffTitle(state.runId)
      const lookup = await this.#findHandoff(state, title)
      // A failed lookup cannot rule out a bead an earlier attempt created, so nothing is created.
      if (!lookup.ok) return pending(`could not look up an existing handoff bead (${lookup.reason}); nothing was created`)
      handoff = lookup.id
      if (handoff === undefined) {
        const created = await this.#bdWrite(state, ["create", title, "--labels", HANDOFF_LABEL, "-d", handoffDescription(state, journal, dir.path), "--json"])
        handoff = created.ok ? parseId(created.stdout) : undefined
        if (handoff === undefined) return pending(`the handoff bead was not created: ${created.stderr.trim() || "bd create failed"}`)
      }
      state = await dir.writeState(state, { ...state, stop: { ...(state.stop ?? progress), summary: true, handoff } })
    }
    const stopped = await dir.writeState(state, { ...state, phase: "stopped" })
    await this.#disarm(stopped.sessionID)
    return {
      done: true,
      stopped: stopped.stopReason,
      summaryPath: dir.summaryPath,
      handoff,
      automationId: stopped.tick.automationId,
      next: stopped.tick.automationId ? `Delete the automation: tools.opencode.automation_delete({ id: "${stopped.tick.automationId}" }). Then print the summary and end.` : "Print the summary and end.",
      summary,
    }
  }

  /**
   * The id of an existing handoff bead for this run (`undefined` when there is none), so a retried
   * stop never creates a second. A lookup that fails or answers something unreadable is `ok: false`.
   */
  async #findHandoff(state: RunState, title: string): Promise<{ ok: true; id: string | undefined } | { ok: false; reason: string }> {
    const listed = await this.#run(state.directory, "bd", ["list", "--all", "--label", HANDOFF_LABEL, "--json", "--limit", "0"], BD_READ_TIMEOUT_MS)
    if (!listed.ok) return { ok: false, reason: listed.stderr.trim() || "bd list failed" }
    let items: unknown
    try {
      items = JSON.parse(listed.stdout.slice(Math.max(0, listed.stdout.indexOf("["))))
    } catch (error) {
      return { ok: false, reason: `bd list answered something that is not JSON (${errorText(error)})` }
    }
    if (!Array.isArray(items)) return { ok: false, reason: "bd list did not answer a list" }
    const found = (items as { id?: unknown; title?: unknown; labels?: unknown }[]).find(
      (item) => item?.title === title && Array.isArray(item.labels) && item.labels.includes(HANDOFF_LABEL),
    )
    return { ok: true, id: typeof found?.id === "string" ? found.id : undefined }
  }

  async log(sessionID: string, input: unknown): Promise<string> {
    const validated = validateEntry(input, new Date(this.#now()))
    if (!validated.ok) return `autopilot_log: ${validated.reason}`
    const lead = await this.leadFor(sessionID)
    const armed = lead === undefined ? undefined : this.armed.get(lead)
    const dir = armed ? new RunDir(armed.root, armed.runId) : this.#dirFor(sessionID, undefined)
    if (!dir) return "autopilot_log: no autopilot run for this session"
    try {
      return await this.#exclusive(dir, () => this.#logLocked(dir, validated.entry))
    } catch (error) {
      if (error instanceof RunLockBusy) return `autopilot_log: run lock busy (${error.message}); log the entry again`
      if (!(error instanceof RunFileError)) throw error
      return `autopilot_log: ${this.#report(dir, error)}`
    }
  }

  async #logLocked(dir: RunDir, entry: JournalEntry): Promise<string> {
    const state = dir.readState()
    dir.append(entry)
    if (state?.phase === "stopped" || state?.phase === "stopping")
      return `logged ${entry.type} after the run stopped; it is in journal.jsonl but not in summary.md or the handoff bead`
    if (entry.bead && (entry.type === "blocker" || entry.type === "ambiguity") && state && !state.options.full) {
      const flagged = await this.#bdWrite(state, ["update", entry.bead, "--add-label", "human", "--json"])
      return `logged ${entry.type}${flagged.ok ? `; flagged ${entry.bead} human` : `; could not flag ${entry.bead}: ${flagged.stderr.trim()}`}`
    }
    return `logged ${entry.type}`
  }

  /** One `bd` mutation, as the embedded store's single writer when the store is embedded. */
  async #bdWrite(state: RunState, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const owner = `autopilot/${state.runId}/${randomUUID()}`
    const held = await this.#lock(state.directory, owner, () => this.#run(state.directory, "bd", args, BD_READ_TIMEOUT_MS))
    return held.kind === "done" ? held.value : { ok: false, stdout: "", stderr: held.reason }
  }

  // --- fallback timer -------------------------------------------------------------------------

  /** The in-process tick, bound like an automation: a resume elsewhere makes its token stale and it stops. */
  #startFallback(sessionID: string, token: string | undefined): void {
    this.#ticks.start(sessionID, TICK_MS, async () => {
      const result = await this.status(sessionID, { action: "tick", ...(token !== undefined ? { token } : {}), session: sessionID })
      const prompt = typeof result.prompt === "string" ? result.prompt : undefined
      if (result.done) this.#ticks.stop(sessionID)
      if (prompt) await this.ctx.session.prompt({ sessionID, text: prompt })
    })
  }

  // --- hooks ----------------------------------------------------------------------------------

  /** Throws to deny an ask-the-user tool while a run is armed. */
  async beforeTool(tool: string, sessionID: string): Promise<void> {
    if (!isAskTool(tool)) return
    if (await this.runningFor(sessionID)) throw new Error(DENY_QUESTION)
  }

  /**
   * While a run is armed, every permission `ask` is denied and journaled as a blocker. The user's
   * own permission rules already allow what they trust; an `ask` is what they wanted to be asked
   * about, and nobody is there to answer. Effects the rules already decided are left alone.
   */
  async evaluate(event: PermissionEvaluation): Promise<void> {
    if (event.effect !== "ask") return
    const running = await this.runningFor(event.sessionID)
    if (!running) return
    if (running.state && (await this.#autoAllowed(event, running.state))) {
      event.effect = "allow"
      return
    }
    const asked = event.resources.join(" ").slice(0, 300)
    event.effect = "deny"
    event.message = running.state
      ? `autopilot never approves a permission ask while the run is unattended; logged as a blocker for the user (${event.action}: ${asked})`
      : `autopilot never approves a permission ask, and it cannot read its run state (${running.unreadable}); logged as a blocker`
    try {
      running.dir.append({ ts: new Date(this.#now()).toISOString(), type: "blocker", summary: `permission ask denied: ${event.action}`, evidence: asked })
    } catch (error) {
      this.#warn("could not journal a denied permission", { run: running.dir.runId, error: errorText(error) })
    }
  }

  /**
   * The two asks a run answers itself: `<root>/*` of a worktree the run recorded and the project
   * still lists, and `autopilot_merge` for one PR and SHA under `--allow merge`.
   */
  async #autoAllowed(event: PermissionEvaluation, state: RunState): Promise<boolean> {
    const asked = { action: event.action, effect: event.effect, resources: event.resources }
    if (grantedMergeAsk({ ...asked, allow: state.options.allow })) return true
    if (event.action !== EXTERNAL_DIRECTORY || !state.worktrees?.length) return false
    const { listed } = await this.#worktrees()
    const roots = state.worktrees.filter((root) => listed.has(root.real) && rootIntact(root, lstatProbe, realPath)).map((root) => root.real)
    return ownWorktreeAsk({ ...asked, roots, canon: realPath })
  }

  /** The real paths `worktree.list` shows for this project, and the project's primary checkout. */
  async #worktrees(): Promise<{ listed: Set<string>; primary: Set<string> }> {
    const project = this.ctx.location.project as { id?: string; directory?: string; canonical?: string } | undefined
    const entries = project?.id === undefined ? [] : await this.ctx.worktree.list({ projectID: project.id } as never).catch(() => [])
    const real = (paths: (string | undefined)[]) => new Set(paths.flatMap((path) => (path === undefined ? [] : (realPath(path) ?? []))))
    return { listed: real(entries.map((entry) => entry.directory)), primary: real([project?.directory, project?.canonical]) }
  }

  /** The identity to record for a child's directory, when it is a linked worktree of a writer lane. */
  #laneRoot(kid: SessionView, places: { listed: Set<string>; primary: Set<string> }): RootIdentity | undefined {
    const directory = kid.location?.directory
    if (typeof directory !== "string" || directory === "") return undefined
    const agent = typeof kid.agent === "string" ? kid.agent : undefined
    if (!recordableLane({ agent, directory, ...places, canon: realPath, linked: hasGitFile })) return undefined
    return identifyRoot(directory, lstatProbe, realPath)
  }

  /** `gh` JSON output, or `undefined` when the command failed or printed something else. */
  async #gh(cwd: string, args: string[]): Promise<unknown> {
    const result = await this.#run(cwd, "gh", args, GH_TIMEOUT_MS)
    if (!result.ok) return undefined
    try {
      return JSON.parse(result.stdout)
    } catch {
      return undefined
    }
  }

  /** Required-status-checks protection of `base`. An unprotected branch reads as empty; any other failure is `undefined`, which refuses. */
  async #protection(cwd: string, base: string): Promise<unknown> {
    const result = await this.#run(cwd, "gh", ["api", `repos/{owner}/{repo}/branches/${base}/protection/required_status_checks`], GH_TIMEOUT_MS)
    if (!result.ok) return /Branch not protected/i.test(result.stderr) ? {} : undefined
    try {
      return JSON.parse(result.stdout)
    } catch {
      return undefined
    }
  }

  /**
   * Merge one PR at one reviewed head. The host's permission check comes first (the hook allows it
   * only under `--allow merge`), then the approval and checks are read from the forge, and `gh`
   * merges only if the head is still `sha`.
   */
  async merge(sessionID: string, input: { pr?: unknown; sha?: unknown; method?: unknown }): Promise<string> {
    const pr = String(input.pr ?? "").trim()
    const sha = String(input.sha ?? "").trim().toLowerCase()
    const method = String(input.method ?? "")
    const journal = async (entry: Omit<JournalEntry, "ts">) => {
      const running = await this.runningFor(sessionID)
      try {
        running?.dir.append({ ts: new Date(this.#now()).toISOString(), ...entry })
      } catch (error) {
        this.#warn("could not journal a merge", { error: errorText(error) })
      }
    }
    const refuse = async (reason: string) => {
      await journal({ type: "issue", summary: `merge of #${pr || "?"} refused: ${reason}`, evidence: sha })
      return `refused: ${reason}`
    }
    if (!/^\d+$/.test(pr)) return refuse("pr must be a PR number")
    if (!/^[0-9a-f]{40}$/.test(sha)) return refuse("sha must be the full 40-digit head commit")
    if (!(MERGE_METHODS as readonly string[]).includes(method)) return refuse(`method must be one of ${MERGE_METHODS.join(", ")}`)
    await this.ctx.permission.assert({ sessionID, action: MERGE_ACTION, resources: [mergeResource(pr, sha)] } as never)
    const cwd = await this.#sessionDirectory(sessionID)
    const api = (path: string) => this.#gh(cwd, ["api", `repos/{owner}/{repo}/${path}`, "--paginate", "--slurp"])
    const view = await this.#gh(cwd, ["pr", "view", pr, "--json", "state,headRefOid,baseRefName,author"])
    const base = typeof (view as { baseRefName?: unknown } | undefined)?.baseRefName === "string" ? (view as { baseRefName: string }).baseRefName : ""
    if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.includes("..")) return refuse("the PR's base branch is unreadable or unusual")
    const [reviews, runs, status, protection, rules, repo] = await Promise.all([
      api(`pulls/${pr}/reviews`),
      api(`commits/${sha}/check-runs`),
      api(`commits/${sha}/status`),
      this.#protection(cwd, base),
      api(`rules/branches/${base}`),
      this.#gh(cwd, ["repo", "view", "--json", "squashMergeAllowed,rebaseMergeAllowed,mergeCommitAllowed"]),
    ])
    const refusal = mergeRefusal({ sha, method, view, reviews, runs, status, protection, rules, repo })
    if (refusal !== undefined) return refuse(refusal)
    const flag = `--${method}`
    const merged = await this.#run(cwd, "gh", ["pr", "merge", pr, "--match-head-commit", sha, flag], GH_TIMEOUT_MS)
    if (!merged.ok) return refuse(`gh pr merge failed: ${merged.stderr.trim().slice(0, 300)}`)
    // gh pr merge can succeed by queueing the merge for later; only the PR itself says what happened.
    const outcome = mergeOutcome(await this.#gh(cwd, ["pr", "view", pr, "--json", "state,headRefOid,mergeCommit,autoMergeRequest"]), sha)
    if (!outcome.ok) {
      if (outcome.disableAuto) await this.#run(cwd, "gh", ["pr", "merge", pr, "--disable-auto"], GH_TIMEOUT_MS)
      return refuse(outcome.reason)
    }
    await journal({ type: "action", summary: `merged #${pr} at ${sha} (${method})`, evidence: sha })
    return `merged #${pr} at ${sha} with ${flag}`
  }

  /** Re-prompts a lead whose turn ended in a question, at most {@link MAX_REPROMPTS} times in a row. */
  async idle(sessionID: string): Promise<void> {
    if (!this.armed.has(sessionID)) return
    const running = await this.runningFor(sessionID)
    if (!running?.state) return
    const messages = await this.ctx.session.context({ sessionID }).catch(() => [])
    if (!endsWithQuestion(lastAssistantText(messages))) {
      this.#reprompts.delete(sessionID)
      return
    }
    const count = (this.#reprompts.get(sessionID) ?? 0) + 1
    if (count > MAX_REPROMPTS) {
      running.dir.append({ ts: new Date(this.#now()).toISOString(), type: "issue", summary: `the lead ended ${count} turns in a row with a question; left idle until the next tick` })
      this.#reprompts.delete(sessionID)
      return
    }
    this.#reprompts.set(sessionID, count)
    await this.ctx.session.synthetic({ sessionID, text: REPROMPT, delivery: "steer", metadata: { source: ID, kind: "reprompt" } })
  }

  async compacted(sessionID: string): Promise<void> {
    if (!this.armed.has(sessionID)) return
    const running = await this.runningFor(sessionID)
    if (!running) return
    const status = await this.status(sessionID, { action: "status" })
    await this.ctx.session.synthetic({
      sessionID,
      text: `Autopilot run ${running.dir.runId} is still armed after compaction. Reload the ${SKILL} skill; never ask the user. Status: ${JSON.stringify(status)}`,
      delivery: "queue",
      metadata: { source: ID, kind: "compaction" },
    })
  }
}

export async function setupAutopilot(ctx: Context, deps: Deps = {}): Promise<() => Promise<void>> {
  // The host logger is bound to the fiber that runs setup, so take it before the first await.
  const warn = deps.warn ?? hostWarn(ID)
  const pilot = new Autopilot(ctx, { ...deps, warn })
  await pilot.load()
  const registrations: { dispose: () => Promise<void> }[] = []
  const report = (what: string) => (error: unknown) => warn(`${what} failed`, { error: errorText(error) })
  registrations.push(
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "autopilot_status",
        description: STATUS_DESCRIPTION,
        input: STATUS_INPUT,
        output: { type: "object" },
        options: { codemode: true },
        execute: async (input, tool) => {
          const output = await pilot.status(tool.sessionID, input as StatusInput)
          return { output, content: JSON.stringify(output, null, 2) }
        },
      })
      editor.add({
        name: "autopilot_log",
        description: LOG_DESCRIPTION,
        input: LOG_INPUT_SCHEMA,
        execute: async (input, tool) => ({ content: await pilot.log(tool.sessionID, input) }),
      })
      editor.add({
        name: "autopilot_merge",
        description: MERGE_DESCRIPTION,
        input: MERGE_INPUT,
        execute: async (input, tool) => ({ content: await pilot.merge(tool.sessionID, input as { pr?: unknown; sha?: unknown; method?: unknown }) }),
      })
    }),
  )
  registrations.push(
    await ctx.command.transform((editor) => {
      editor.add({
        name: "autopilot",
        description: COMMAND_DESCRIPTION,
        execute: async (input) => {
          const text = await pilot.command(input.sessionID, input.prompt.text ?? "")
          await ctx.session.prompt({ ...input.prompt, sessionID: input.sessionID, text, delivery: input.delivery })
        },
      })
    }),
  )
  registrations.push(await ctx.tool.hook("execute.before", (event) => pilot.beforeTool(event.tool, event.sessionID)))
  registrations.push(await ctx.permission.hook("evaluate", (event) => pilot.evaluate(event).catch(report("permission hook"))))
  registrations.push(await ctx.session.hook("experimental.idle", (event) => pilot.idle(event.sessionID).catch(report("idle hook"))))
  registrations.push(await registerSkills(ctx.skill, [SKILL_FILE]))
  const abort = new AbortController()
  const iterator = ctx.event.subscribe({ signal: abort.signal })[Symbol.asyncIterator]()
  void (async () => {
    for (;;) {
      const next = await iterator.next().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) return
      pilot.activity.observe(next.value)
      const event = next.value as { type?: string; data?: { sessionID?: string } }
      if (event.type === "session.compaction.ended" && typeof event.data?.sessionID === "string") void pilot.compacted(event.data.sessionID).catch(report("compaction recovery"))
    }
  })()
  return async () => {
    abort.abort()
    await iterator.return?.()
    pilot.dispose()
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}

export default Plugin.define({ id: ID, setup: (ctx) => setupAutopilot(ctx) })
