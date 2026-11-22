import { randomUUID } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { withEmbeddedWriteLock } from "@srobroek/opencode-lib/bd-embedded-write-lock"
import { readBoundedBytes } from "@srobroek/opencode-lib/bounded-read"
import { hostWarn, type Warn } from "@srobroek/opencode-lib/host-log"
import { withLease } from "@srobroek/opencode-lib/lease-lock"
import { SAFE_GIT_ARGS } from "@srobroek/opencode-lib/safe-git"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { classifyScope, deadlineAt, GRANTS, type Grant, type Invocation, parseInvocation, type RunOptions } from "./args.ts"
import { automationRequest, type TickBinding } from "./automation.ts"
import { Activity, BD_READ_TIMEOUT_MS, type BeadView, childFrom, commitCount, readBeads, type SessionView, sessionBusy } from "./gather.ts"
import { type JournalEntry, LOG_INPUT_SCHEMA, validateEntry } from "./journal.ts"
import { foreignBead, fsLedgerHost, type LedgerHost, ledgerEnv, resolveLedger } from "./ledger.ts"
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
  mergeDrift,
  mergeOutcome,
  mergeRefusal,
  mergeResource,
  mergeResponse,
  ownWorktreeAsk,
  REPROMPT,
  type RootIdentity,
  recordableLane,
  reviewExportAsk,
  rootIntact,
  type Witnessed,
} from "./policy.ts"
import { claimNames, releaseClaims, takeClaims } from "./review-claim.ts"
import { type ExportResult, exportDirFor, exportReview, reviewCurrentKey, reviewManifestKey, verifyExport } from "./review-export.ts"
import {
  buildReviewPrompt,
  countNameStatus,
  hashText,
  MAX_REVIEW_DIFF_BYTES,
  REVIEW_AGENT,
  REVIEW_POINTER_ROOT,
  type ReviewPointer,
  type ReviewResolution,
  readPointer,
  resolveReview,
  reviewMetadata,
  reviewPointerKey,
  reviewPointerPrefix,
  reviewSweepKey,
} from "./review-session.ts"
import { autopilotRoot, findRun, type Run, RunDir, RunFileError, runCommand } from "./rundir.ts"
import { countBeads, newRunState, type RunState, runIdFor, type Snapshot, TICK_MS, tick, tickPrompt } from "./state.ts"
import { HANDOFF_LABEL, handoffDescription, renderSummary } from "./summary.ts"
import { realClock, Ticks } from "./timer.ts"

export * from "./args.ts"
export * from "./automation.ts"
export * from "./gather.ts"
export * from "./journal.ts"
export * from "./policy.ts"
export * from "./review-claim.ts"
export * from "./review-export.ts"
export * from "./review-session.ts"
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

export const EXPORT_REVIEW_DESCRIPTION =
  "Export a review round for reviewers that cannot run git while the run is armed.\n" +
  "Writes the base...head diff, a diffstat, the changed files at head and a hash manifest under the run's review directory; give reviewers the returned dir and manifestHash."

export const REVIEW_DESCRIPTION =
  "Start a plugin-run review of one PR head by a code-reviewer session; returns at once.\n" +
  "Under --allow self-review a merge may rest on its APPROVE for that exact head; autopilot_status reports the verdict."

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
        ledger: { type: "string", description: "the beads ledger (.beads directory) this run reads and writes; default: derived from the scope or the session directory" },
        full: { type: "boolean" },
        allow: { type: "array", items: { type: "string", enum: [...GRANTS] } },
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

const REVIEW_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["pr", "sha"],
  properties: {
    pr: { type: ["integer", "string"], description: "PR number" },
    sha: { type: "string", description: "the full 40-digit head commit to review" },
  },
} as const

const EXPORT_REVIEW_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["pr", "base", "head"],
  properties: {
    pr: { type: ["integer", "string"], description: "PR number the round belongs to; keys the stored manifest hash" },
    base: { type: "string", description: "the revision the round is reviewed against, such as main or a SHA" },
    head: { type: "string", description: "the revision under review, such as a branch or a SHA" },
  },
} as const

type StatusInput = {
  action?: "status" | "arm" | "tick" | "fallback" | "stop"
  run?: string
  setup?: { scope?: string; ledger?: string; full?: boolean; allow?: Grant[]; lanes?: number; for?: string; until_time?: string; until?: string }
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

/** How many reviews a status report shows. */
const MAX_REVIEWS_REPORTED = 20

/** How many pointers beyond the newest one status call resolves, so every deadline is enforced over successive calls. */
const REVIEW_SWEEP = 25

const NO_LEDGER = "the run has no beads ledger to read or write"

/** `env` is the environment of the `bd` run the lock guards, so the lock covers the store that run writes. */
export type WriteLock = <T>(cwd: string, owner: string, write: () => Promise<T>, env: NodeJS.ProcessEnv) => Promise<{ kind: "done"; value: T } | { kind: "failed"; reason: string }>

const embeddedLock: WriteLock = (cwd, owner, write, env) => withEmbeddedWriteLock(cwd, owner, write, env)

export type Deps = { run?: Run; now?: () => number; ticks?: Ticks; lock?: WriteLock; warn?: Warn; ledger?: LedgerHost; readPauseMs?: number }

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
  readonly #readPauseMs: number | undefined
  readonly #ticks: Ticks
  readonly #lock: WriteLock
  readonly #ledgers: LedgerHost
  readonly #warn: Warn
  readonly #reprompts = new Map<string, number>()
  readonly #serial = new Map<string, Promise<unknown>>()
  /** File errors already journaled, so a hook that fires on every call logs each one once. */
  readonly #reported = new Set<string>()
  /** Storage reads that failed, by run and what was read; cleared when the same read works again. Surfaced by status. */
  readonly #storageIssues = new Map<string, Map<string, string>>()

  constructor(
    readonly ctx: Context,
    deps: Deps = {},
  ) {
    this.#run = deps.run ?? runCommand
    this.#now = deps.now ?? Date.now
    this.#readPauseMs = deps.readPauseMs
    this.#warn = deps.warn ?? (() => {})
    this.activity = new Activity(this.#now)
    this.#ticks = deps.ticks ?? new Ticks(realClock, this.#warn)
    this.#lock = deps.lock ?? embeddedLock
    this.#ledgers = deps.ledger ?? fsLedgerHost
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

  /**
   * A plugin-storage operation, with a failure recorded: journaled once as a blocker and kept for
   * the status report until the same operation on the same resource works again. `label` names both
   * (`get:<key>`, `scan:<prefix>`, `set:<key>`, `remove:<key>`). A failure is never an empty result.
   * A caller that works in several steps passes `clear: false` and clears the label itself once it is done.
   */
  async #stored<T>(dir: RunDir | undefined, label: string, read: () => Promise<T>, options: { clear?: boolean } = {}): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    const issues = dir === undefined ? undefined : (this.#storageIssues.get(dir.runId) ?? this.#storageIssues.set(dir.runId, new Map()).get(dir.runId))
    try {
      const value = await read()
      if (options.clear !== false) issues?.delete(label)
      return { ok: true, value }
    } catch (error) {
      const reason = `plugin storage failed (${label}): ${errorText(error)}`
      issues?.set(label, reason)
      if (dir !== undefined && !this.#reported.has(`storage:${reason}`)) {
        this.#reported.add(`storage:${reason}`)
        try {
          dir.append({ ts: new Date(this.#now()).toISOString(), type: "blocker", summary: reason, parked: true })
        } catch (appendError) {
          this.#warn("could not journal a storage failure", { error: errorText(appendError) })
        }
      }
      return { ok: false, reason }
    }
  }

  /** Every entry under `prefix`, following `next` to the end; `undefined` (recorded) when any page cannot be read. Its failure clears only when this same scan completes. */
  async #scanAll(dir: RunDir | undefined, prefix: string): Promise<{ key: string; value: unknown }[] | undefined> {
    const label = `scan:${prefix}`
    const entries: { key: string; value: unknown }[] = []
    let after: string | undefined
    for (;;) {
      const page = await this.#stored(dir, label, () => this.ctx.storage.scan({ prefix, limit: STORAGE_PAGE, ...(after !== undefined ? { after } : {}) }), { clear: false })
      if (!page.ok) return undefined
      entries.push(...page.value.entries)
      if (page.value.next === undefined || page.value.entries.length === 0 || page.value.next === after) {
        if (dir !== undefined) this.#storageIssues.get(dir.runId)?.delete(label)
        return entries
      }
      after = page.value.next
    }
  }

  /** The run directory of an armed lead. */
  #dirOfLead(lead: string): RunDir | undefined {
    const armed = this.armed.get(lead)
    return armed ? new RunDir(armed.root, armed.runId) : undefined
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
      this.#readBeads(state),
      commitCount(state.directory, this.#run),
      this.#children(state.sessionID),
      this.leadBusy(state.sessionID),
    ])
    if (beads.problem !== undefined) this.#journalScopeUnknown(dir, beads.problem)
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

  /** Journal an unconfirmed scope read as a blocker, once while it lasts; the run keeps going and never stops on it. */
  #journalScopeUnknown(dir: RunDir, problem: string): void {
    const summary = `scope read unconfirmed, not treated as finished: ${problem}`
    if (dir.journal().some((entry) => entry.type === "blocker" && entry.summary === summary)) return
    dir.append({ ts: new Date(this.#now()).toISOString(), type: "blocker", summary })
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
    const reviews = await this.#reviews(state.sessionID)
    const storageErrors = [...(this.#storageIssues.get(dir.runId)?.values() ?? [])]
    const out = {
      ping: result.ping,
      progress: result.progress,
      newlyUnblocked: result.newlyUnblocked,
      actions: result.actions,
      beads: result.state.beads,
      parked: result.state.parked,
      idleTicks: action === "tick" ? result.state.idleTicks : state.idleTicks,
      ...(result.stop ? { stop: result.stop } : {}),
      ...(reviews.length ? { reviews } : {}),
      ...(storageErrors.length ? { storageErrors } : {}),
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
    const scope = classifyScope(options.scope)
    const ledger = resolveLedger({ ...(input.setup?.ledger !== undefined ? { explicit: input.setup.ledger } : {}), scope, directory: state.directory }, this.#ledgers)
    if (!ledger.ok) return { error: ledger.error }
    const now = this.#now()
    const deadline = options.forMs !== undefined ? now + options.forMs : options.untilTime !== undefined ? deadlineAt(options.untilTime, now) : undefined
    const next: RunState = {
      ...state,
      phase: "running",
      armedAt: now,
      options: { ...options, allow: options.allow ?? [], lanes: options.lanes ?? 3, full: options.full ?? false },
      scope,
      ledger: ledger.ledger,
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
    const fresh = await this.#readBeads(state)
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
    const ledger = this.#ledgerOf(state)
    if (ledger === undefined) return { ok: false, reason: NO_LEDGER }
    const listed = await this.#run(state.directory, "bd", ["list", "--all", "--label", HANDOFF_LABEL, "--json", "--limit", "0"], BD_READ_TIMEOUT_MS, ledgerEnv(ledger))
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
      if (error.kind === "stale") {
        // Losing a create-exclusive race drops the write; it is an issue, never a parking blocker.
        this.#journalIssue(dir, `a write lost to another writer and was not applied: ${error.message}`)
        return `autopilot_log: state moved on under this call (${error.message}); log the entry again`
      }
      return `autopilot_log: ${this.#report(dir, error)}`
    }
  }

  async #logLocked(dir: RunDir, entry: JournalEntry): Promise<string> {
    const state = dir.readState()
    dir.append(entry)
    if (state?.phase === "stopped" || state?.phase === "stopping")
      return `logged ${entry.type} after the run stopped; it is in journal.jsonl but not in summary.md or the handoff bead`
    if (entry.bead && (entry.type === "blocker" || entry.type === "ambiguity") && state && !state.options.full) {
      const flagged = await this.#bdWrite(state, ["update", entry.bead, "--add-label", "human", "--json"], entry.bead)
      return `logged ${entry.type}${flagged.ok ? `; flagged ${entry.bead} human` : `; could not flag ${entry.bead}: ${flagged.stderr.trim()}`}`
    }
    return `logged ${entry.type}`
  }

  /** The run's ledger; runs armed before the ledger was recorded derive it as arming would, or have none. */
  #ledgerOf(state: RunState): string | undefined {
    if (state.ledger !== undefined) return state.ledger
    const legacy = resolveLedger({ scope: state.scope, directory: state.directory }, this.#ledgers)
    return legacy.ok ? legacy.ledger : undefined
  }

  async #readBeads(state: RunState): Promise<BeadView> {
    const ledger = this.#ledgerOf(state)
    return ledger === undefined ? { beads: [], ready: [], blocked: [], ok: false } : readBeads(state.directory, this.#run, ledger, state.scope.kind === "bead" ? { scopeId: state.scope.id, ...(this.#readPauseMs !== undefined ? { pauseMs: this.#readPauseMs } : {}) } : {})
  }

  /**
   * One `bd` mutation in the run's ledger, as the embedded store's single writer when the store is
   * embedded. It never leaves that ledger: a bead that belongs to another one is refused.
   */
  async #bdWrite(state: RunState, args: string[], bead?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const refuse = (stderr: string) => ({ ok: false, stdout: "", stderr })
    const ledger = this.#ledgerOf(state)
    if (ledger === undefined) return refuse(NO_LEDGER)
    const foreign = bead === undefined ? undefined : foreignBead(ledger, bead, this.#ledgers)
    if (foreign !== undefined) return refuse(`refused: ${foreign}`)
    const env = ledgerEnv(ledger)
    const owner = `autopilot/${state.runId}/${randomUUID()}`
    const held = await this.#lock(state.directory, owner, () => this.#run(state.directory, "bd", args, BD_READ_TIMEOUT_MS, env), { ...process.env, ...env })
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
    if (running.state && (await this.#autoAllowed(event, running.state, running.dir))) {
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
   * The asks a run answers itself: `<root>/*` of a worktree the run recorded and the project
   * still lists, `autopilot_merge` for one PR and SHA under `--allow merge`, and the one review
   * export directory the run made last. That directory is model-writable; its integrity rests on
   * the export's manifest, not on this allow.
   */
  async #autoAllowed(event: PermissionEvaluation, state: RunState, dir: RunDir): Promise<boolean> {
    const asked = { action: event.action, effect: event.effect, resources: event.resources }
    if (grantedMergeAsk({ ...asked, allow: state.options.allow })) return true
    if (event.action === EXTERNAL_DIRECTORY && reviewExportAsk({ ...asked, root: await this.#currentExport(dir), canon: realPath })) return true
    if (event.action !== EXTERNAL_DIRECTORY || !state.worktrees?.length) return false
    const { listed } = await this.#worktrees()
    const roots = state.worktrees.filter((root) => listed.has(root.real) && rootIntact(root, lstatProbe, realPath)).map((root) => root.real)
    return ownWorktreeAsk({ ...asked, roots, canon: realPath })
  }

  /** The real path of the export directory the run made last, when it is still a plain directory. */
  async #currentExport(dir: RunDir): Promise<string | undefined> {
    const read = await this.#stored(dir, `get:${reviewCurrentKey(dir.runId)}`, () => this.ctx.storage.get(reviewCurrentKey(dir.runId)))
    const current = (read.ok ? read.value : undefined) as { head?: unknown; manifestHash?: unknown } | undefined
    if (typeof current?.head !== "string" || typeof current.manifestHash !== "string") return undefined
    const exported = exportDirFor(dir.path, current.head, current.manifestHash)
    return exported === undefined ? undefined : identifyRoot(exported, lstatProbe, realPath)?.real
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
    const running = await this.runningFor(sessionID)
    const granted = running?.state?.options.allow.includes("self-review") === true
    const witness = granted && running ? await this.#resolveReview(running.lead, pr, sha) : undefined
    if (witness?.state === "unreadable") return refuse(`the plugin review record could not be read, so the merge cannot rest on it (${witness.reason})`)
    const witnessed: Witnessed = { granted, approvedSha: witness?.state === "done" && witness.record.verdict === "approve" ? witness.record.sha : undefined }
    const refusal = mergeRefusal({ sha, method, view, reviews, runs, status, protection, rules, repo, witnessed })
    if (refusal !== undefined) return refuse(refusal)
    // Re-read right before merging: a retarget or a push since the reads above voids them.
    const drift = mergeDrift({ view: await this.#gh(cwd, ["pr", "view", pr, "--json", "baseRefName,headRefOid"]), base, sha })
    if (drift !== undefined) return refuse(drift)
    // The synchronous REST merge: GitHub answers merged or refuses, and never defers to auto-merge or a queue.
    const put = mergeResponse(await this.#run(cwd, "gh", ["api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${pr}/merge`, "-f", `sha=${sha}`, "-f", `merge_method=${method}`], GH_TIMEOUT_MS))
    if (!put.ok) return refuse(put.reason)
    const outcome = mergeOutcome(await this.#gh(cwd, ["pr", "view", pr, "--json", "state,headRefOid,mergeCommit,autoMergeRequest"]), sha)
    if (!outcome.ok) return refuse(outcome.reason)
    const note = witness?.state === "done" && witnessed.approvedSha === sha ? `; plugin review ${witness.record.reviewerSession} approved this head` : ""
    await journal({ type: "action", summary: `merged #${pr} at ${sha} (${method}) as ${put.sha}${note}`, evidence: sha })
    return `merged #${pr} at ${sha} with ${method}`
  }

  /**
   * Export a review round into the run directory for reviewers that cannot run git. The manifest
   * hash is kept in plugin storage by PR and head (the trust anchor for `verifyExport`), and the
   * export is recorded as the run's current one, the only directory the permission hook opens.
   */
  async exportReview(sessionID: string, input: { pr?: unknown; base?: unknown; head?: unknown }): Promise<string> {
    const running = await this.runningFor(sessionID)
    if (!running?.state) return "refused: no running autopilot run for this session"
    const pr = String(input.pr ?? "").trim()
    if (!/^\d{1,9}$/.test(pr) || Number(pr) < 1) return "refused: pr must be a positive PR number"
    const result = await this.#publishExport({ dir: running.dir, state: running.state }, pr, input.base, input.head)
    return result.ok ? JSON.stringify(result.exported, null, 2) : `refused: ${result.reason}`
  }

  /** Export a round and record its manifest hash by PR and head, and as the run's current export. */
  async #publishExport(running: { dir: RunDir; state: RunState }, pr: string, base: unknown, head: unknown): Promise<{ ok: true; exported: Extract<ExportResult, { ok: true }> } | { ok: false; reason: string }> {
    const result = await exportReview({ run: this.#run, cwd: running.state.directory, runDir: running.dir.path, base, head })
    if (!result.ok) return result
    try {
      await this.ctx.storage.set(reviewManifestKey(Number(pr), result.head), { manifestHash: result.manifestHash })
      await this.ctx.storage.set(reviewCurrentKey(running.dir.runId), { head: result.head, manifestHash: result.manifestHash })
    } catch (error) {
      return { ok: false, reason: `the export was written but its manifest hash could not be recorded (${errorText(error)}); export again` }
    }
    return { ok: true, exported: result }
  }

  // --- plugin-run review ----------------------------------------------------------------------

  /**
   * Start a review of one PR head by a `code-reviewer` child session the plugin creates, and return
   * at once. The export is verified against its stored manifest hash right before the prompt, and
   * only a pointer to the child is kept; the verdict is derived later by {@link resolveReview}.
   */
  async review(sessionID: string, input: { pr?: unknown; sha?: unknown }): Promise<string> {
    const running = await this.runningFor(sessionID)
    if (!running?.state) return "refused: no running autopilot run for this session"
    const pr = String(input.pr ?? "").trim()
    const sha = String(input.sha ?? "").trim().toLowerCase()
    if (!/^\d{1,9}$/.test(pr) || Number(pr) < 1) return "refused: pr must be a positive PR number"
    if (!/^[0-9a-f]{40}$/.test(sha)) return "refused: sha must be the full 40-digit head commit"
    const { lead, dir, state } = running as typeof running & { state: RunState }
    // Before anything else, and before any reviewer session exists: a head is reviewed at most once.
    const names = claimNames(pr, sha)
    const claim = takeClaims(dir.root, names, `${ID}/${dir.runId}/${randomUUID()}`)
    if (!claim.ok) {
      if ("error" in claim) return `refused: could not take the review claim (${claim.error})`
      const existing = await this.#resolveReview(lead, pr, sha)
      if (existing?.state === "unreadable") return JSON.stringify({ started: false, state: "unreadable", reason: existing.reason })
      const note = "this head already has a review; it is never reviewed twice"
      if (existing?.state === "done") return JSON.stringify({ started: false, state: "done", verdict: existing.record.verdict, reviewer: existing.record.reviewerSession, note })
      if (existing?.state === "void") return JSON.stringify({ started: false, state: "void", reason: existing.reason, note })
      return JSON.stringify({ started: false, state: "pending", note })
    }
    const giveBack = () => {
      try {
        releaseClaims(dir.root, names)
      } catch (error) {
        this.#journalIssue(dir, `could not release the review claim of #${pr} at ${sha}: ${errorText(error)}`)
      }
    }
    // Second line, in plugin storage: any pointer for this head under any PR number or lead, whatever became of it.
    const pointers = await this.#scanAll(dir, REVIEW_POINTER_ROOT)
    if (pointers === undefined) {
      giveBack()
      return "refused: plugin storage could not be read, so it is unknown whether this head was reviewed; the failure is logged as a blocker"
    }
    if (pointers.some((entry) => entry.key.endsWith(`@${sha}`))) {
      giveBack()
      return "refused: plugin storage already holds a review pointer for this head; it is never reviewed twice"
    }
    // The claim is given back only when this start was refused and left no reviewer behind.
    const hold = { keep: false }
    let result: string
    try {
      result = await this.#startReview({ lead, dir, state, sessionID, pr, sha, hold })
    } catch (error) {
      hold.keep = true
      this.#journalIssue(dir, `review of #${pr} at ${sha} failed unexpectedly and its claim was kept: ${errorText(error)}`)
      throw error
    }
    if (result.startsWith("refused:") && !hold.keep) giveBack()
    return result
  }

  async #startReview(input: { lead: string; dir: RunDir; state: RunState; sessionID: string; pr: string; sha: string; hold: { keep: boolean } }): Promise<string> {
    const { lead, dir, state, sessionID, pr, sha, hold } = input
    const agent = await this.ctx.agent.get({ agentID: REVIEW_AGENT } as never).then(
      (output) => {
        const value = output as unknown as { data?: { id?: unknown } } | { id?: unknown } | undefined
        return (value && "data" in value ? value.data : (value as { id?: unknown } | undefined))?.id === REVIEW_AGENT
      },
      () => false,
    )
    if (!agent) return `refused: the ${REVIEW_AGENT} agent is not available`

    // GitHub's own account of the PR: its state, head, and the base commit its diff is against.
    const cwd = await this.#sessionDirectory(sessionID)
    const pull = (await this.#gh(cwd, ["api", `repos/{owner}/{repo}/pulls/${pr}`])) as
      | { state?: unknown; head?: { sha?: unknown }; base?: { sha?: unknown }; changed_files?: unknown }
      | undefined
    if (pull?.state !== "open") return `refused: PR state is ${String(pull?.state ?? "unreadable")}, expected open`
    const headSha = typeof pull.head?.sha === "string" ? pull.head.sha.toLowerCase() : undefined
    if (headSha !== sha) return `refused: PR head is ${headSha ?? "unreadable"}, not ${sha}`
    const baseSha = typeof pull.base?.sha === "string" ? pull.base.sha.toLowerCase() : ""
    if (!/^[0-9a-f]{40}$/.test(baseSha)) return "refused: GitHub did not report the PR's base commit"
    // A fetch that fails is not fatal by itself: the commit may already be here. Presence is what counts.
    await this.#run(state.directory, "git", [...SAFE_GIT_ARGS, "fetch", "--no-tags", "--quiet", "origin", baseSha], GH_TIMEOUT_MS)
    const present = await this.#run(state.directory, "git", [...SAFE_GIT_ARGS, "rev-parse", "--verify", "--quiet", `${baseSha}^{commit}`], GH_TIMEOUT_MS)
    if (!present.ok) return `refused: the base commit ${baseSha} is not present locally and could not be fetched`

    const published = await this.#publishExport({ dir, state }, pr, baseSha, sha)
    if (!published.ok) return `refused: ${published.reason}`
    const { exported } = published
    if (exported.head !== sha) return `refused: ${sha} resolved to ${exported.head}`
    const changedFiles = typeof pull.changed_files === "number" ? pull.changed_files : undefined
    if (changedFiles === undefined) return "refused: GitHub did not report how many files the PR changes"
    // GitHub counts each changed path once and a rename as one file, which is `git diff --name-status -M`.
    const counted = await this.#run(state.directory, "git", [...SAFE_GIT_ARGS, "diff", "--name-status", "-M", "-z", "--no-color", "--no-ext-diff", "--no-textconv", `${baseSha}...${sha}`, "--"], GH_TIMEOUT_MS)
    if (!counted.ok) return "refused: could not count the files the PR changes"
    const ours = countNameStatus(counted.stdout)
    if (ours !== changedFiles) return `refused: the export changes ${ours} files but GitHub reports ${changedFiles}; the base is not the one GitHub diffs against`
    const recorded = await this.#stored(dir, `get:${reviewManifestKey(Number(pr), sha)}`, () => this.ctx.storage.get(reviewManifestKey(Number(pr), sha)))
    if (!recorded.ok) return `refused: ${recorded.reason}`
    const manifestHash = typeof (recorded.value as { manifestHash?: unknown } | undefined)?.manifestHash === "string" ? (recorded.value as { manifestHash: string }).manifestHash : ""
    const checked = verifyExport(exported.dir, manifestHash)
    if (!checked.ok) return `refused: the export does not match its recorded hash (${checked.reason})`
    // What the recorded diff holds is what is reviewed: an empty one is nothing to review. A deletion-only PR has no files at head but a diff.
    if (checked.manifest.diff.bytes === 0) return `refused: the diff is empty, so there is nothing to review (GitHub reports ${changedFiles} changed files)`
    const read = readBoundedBytes(join(exported.dir, "round.diff"), MAX_REVIEW_DIFF_BYTES)
    if (read.kind === "unreadable" && read.reason === "too-large") return `refused: the diff is larger than the ${MAX_REVIEW_DIFF_BYTES} bytes a review prompt carries; narrow the round`
    // The bytes the prompt carries must be the bytes the manifest recorded, not whatever the file holds now.
    if (read.kind !== "bytes" || hashText(read.bytes) !== checked.manifest.diff.sha256) return "refused: the exported diff could not be read as recorded"
    const diff = read.bytes.toString("utf8")
    const delimiter = randomUUID().replaceAll("-", "")
    if (diff.includes(delimiter)) return "refused: the diff contains the prompt delimiter; start again"
    const nonce = randomUUID()
    const prompt = buildReviewPrompt({ pr, sha, dir: exported.dir, manifestHash, nonce, delimiter, diff })

    const key = reviewPointerKey(lead, pr, sha)
    const child = await this.ctx.session
      .create({
        parentID: lead,
        agent: REVIEW_AGENT,
        title: `autopilot review of #${pr}`,
        location: { directory: cwd },
        metadata: reviewMetadata({ pr, sha, nonce }),
        // The agent already denies all but reads; these hold if its rules are looser.
        permissions: ["edit", "shell", "subagent", "autopilot_*"].map((action) => ({ action, resource: "*", effect: "deny" as const })),
      })
      .catch((error: unknown) => errorText(error))
    if (typeof child === "string") return `refused: could not create the reviewer session (${child})`
    const pointer: ReviewPointer = { pr, sha, session: child.id, nonce, promptHash: hashText(prompt), manifestHash, at: this.#now() }
    // A refused start removes the pointer and the session. A removal that fails is journaled and the
    // claim is kept, since a reviewer may still exist.
    const abandon = async (reason: string): Promise<string> => {
      const failures: string[] = []
      await Promise.resolve()
        .then(() => this.ctx.storage.remove(key))
        .catch((error: unknown) => void failures.push(`pointer ${key}: ${errorText(error)}`))
      await Promise.resolve()
        .then(() => this.ctx.session.remove({ sessionID: child.id }))
        .catch((error: unknown) => void failures.push(`session ${child.id}: ${errorText(error)}`))
      if (failures.length > 0) {
        hold.keep = true
        this.#journalIssue(dir, `review of #${pr} at ${sha} was refused (${reason}) but cleanup failed: ${failures.join("; ")}`)
      }
      return `refused: ${reason}`
    }
    try {
      await this.ctx.storage.set(key, pointer)
    } catch (error) {
      return abandon(`could not record the review (${errorText(error)})`)
    }
    // Immediately before the prompt: a change to the export since the check above refuses the review.
    const again = verifyExport(exported.dir, manifestHash)
    if (!again.ok) return abandon(`the export changed before the prompt (${again.reason})`)
    try {
      await this.ctx.session.prompt({ sessionID: child.id, text: prompt, metadata: reviewMetadata(pointer) })
    } catch (error) {
      return abandon(`could not prompt the reviewer (${errorText(error)})`)
    }
    return JSON.stringify({ started: true, session: child.id, pr, sha, manifestHash, note: "returns at once; autopilot_status reports the verdict under reviews" })
  }

  /** The review of one head started by `lead`, as the host's own record of the reviewer says; `undefined` when none was started, `unreadable` when storage could not say. */
  async #resolveReview(lead: string, pr: string, sha: string): Promise<ReviewResolution | { state: "unreadable"; reason: string } | undefined> {
    const stored = await this.#stored(this.#dirOfLead(lead), `get:${reviewPointerKey(lead, pr, sha)}`, () => this.ctx.storage.get(reviewPointerKey(lead, pr, sha)))
    if (!stored.ok) return { state: "unreadable", reason: stored.reason }
    const pointer = readPointer(stored.value, pr, sha)
    return pointer === undefined ? undefined : this.#resolvePointer(lead, pointer)
  }

  /** Re-read the reviewer from the host, never from a file; a reviewer past its deadline is interrupted. */
  async #resolvePointer(lead: string, pointer: ReviewPointer): Promise<ReviewResolution> {
    const [session, messages] = await Promise.all([
      this.ctx.session.get({ sessionID: pointer.session }).catch(() => undefined),
      this.ctx.session.context({ sessionID: pointer.session }).catch(() => undefined),
    ])
    const resolution = resolveReview({ pointer, lead, session, messages, now: this.#now() })
    if (resolution.state !== "expired") return resolution
    await this.ctx.session.interrupt({ sessionID: pointer.session }).catch((error: unknown) => this.#warn("could not interrupt a reviewer past its deadline", { error: errorText(error) }))
    return { state: "void", reason: "the reviewer passed its deadline and was interrupted" }
  }

  /**
   * The state of the newest reviews `lead` started, for the status report. Each call also resolves
   * the next {@link REVIEW_SWEEP} pointers after a cursor kept in plugin storage (wrapping at the
   * end), so every pointer meets its deadline within a few calls however many there are.
   */
  async #reviews(lead: string): Promise<Record<string, unknown>[]> {
    const dir = this.#dirOfLead(lead)
    const prefix = reviewPointerPrefix(lead)
    const scanned = await this.#scanAll(dir, prefix)
    if (scanned === undefined) return []
    const all = scanned.flatMap((entry) => {
      const [pr, sha] = entry.key.slice(prefix.length).split("@")
      const pointer = pr === undefined || sha === undefined ? undefined : readPointer(entry.value, pr, sha)
      return pointer === undefined ? [] : [{ key: entry.key, pointer }]
    })
    const newest = [...all].sort((a, b) => b.pointer.at - a.pointer.at).slice(0, MAX_REVIEWS_REPORTED)
    const byKey = [...all].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const cursorKey = reviewSweepKey(lead)
    // A cursor that cannot be read stops the sweep: no default to the start, and no write over it.
    const cursor = await this.#stored(dir, `get:${cursorKey}`, () => this.ctx.storage.get(cursorKey))
    let slice: typeof byKey = []
    if (cursor.ok) {
      const after = typeof cursor.value === "string" ? cursor.value : undefined
      const from = after === undefined ? 0 : Math.max(0, byKey.findIndex((entry) => entry.key > after))
      slice = byKey.slice(from, from + REVIEW_SWEEP)
      const last = slice.at(-1)
      if (from + slice.length >= byKey.length || last === undefined) await this.#stored(dir, `remove:${cursorKey}`, () => this.ctx.storage.remove(cursorKey))
      else await this.#stored(dir, `set:${cursorKey}`, () => this.ctx.storage.set(cursorKey, last.key))
    }

    const items = new Map<string, Record<string, unknown>>()
    for (const { key, pointer } of [...newest, ...slice]) {
      if (items.has(key)) continue
      const { pr, sha } = pointer
      const resolution = await this.#resolvePointer(lead, pointer)
      items.set(
        key,
        resolution.state === "done"
          ? { pr, sha, state: "done", verdict: resolution.record.verdict, reviewer: resolution.record.reviewerSession }
          : resolution.state === "void"
            ? { pr, sha, state: "void", reason: resolution.reason }
            : { pr, sha, state: "pending" },
      )
    }
    return newest.flatMap((entry) => {
      const item = items.get(entry.key)
      return item === undefined ? [] : [item]
    })
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
      editor.add({
        name: "autopilot_review",
        description: REVIEW_DESCRIPTION,
        input: REVIEW_INPUT,
        execute: async (input, tool) => ({ content: await pilot.review(tool.sessionID, input as { pr?: unknown; sha?: unknown }) }),
      })
      editor.add({
        name: "autopilot_export_review",
        description: EXPORT_REVIEW_DESCRIPTION,
        input: EXPORT_REVIEW_INPUT,
        execute: async (input, tool) => ({ content: await pilot.exportReview(tool.sessionID, input as { pr?: unknown; base?: unknown; head?: unknown }) }),
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
