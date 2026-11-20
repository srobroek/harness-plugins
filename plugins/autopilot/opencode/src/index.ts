import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { classifyScope, deadlineAt, type Invocation, parseInvocation, type RunOptions } from "./args.ts"
import { automationRequest } from "./automation.ts"
import { Activity, commitCount, readBeads } from "./gather.ts"
import { LOG_INPUT_SCHEMA, validateEntry } from "./journal.ts"
import { DENY_QUESTION, decideAsk, endsWithQuestion, isAskTool, REPROMPT } from "./policy.ts"
import { autopilotRoot, findRun, RunDir, type Run, runCommand } from "./rundir.ts"
import { newRunState, type RunState, runIdFor, type Snapshot, TICK_MS, tick, tickPrompt } from "./state.ts"
import { handoffDescription, renderSummary } from "./summary.ts"
import { Ticks } from "./timer.ts"

export * from "./args.ts"
export * from "./automation.ts"
export * from "./journal.ts"
export * from "./policy.ts"
export * from "./state.ts"
export * from "./summary.ts"

export const ID = "srobroek.autopilot"
export const SKILL = "autopilot"
const SKILL_FILE = fileURLToPath(new URL("../skills/autopilot/SKILL.md", import.meta.url))

export const STATUS_DESCRIPTION =
  "Autopilot run state: rebuilds it from beads, git, child sessions and the journal, evaluates stop conditions.\n" +
  'action "status" (default) reports; "arm" ends setup with the answered values and returns the tick automation to create; ' +
  '"tick" is what the automation calls; "fallback" starts the in-process timer when automation_create failed; "stop" ends the run, writes summary.md and the handoff bead.'

export const LOG_DESCRIPTION = "Append one validated entry (decision, blocker, issue, ambiguity, stop, progress, action) to the autopilot journal."

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
  },
} as const

type StatusInput = {
  action?: "status" | "arm" | "tick" | "fallback" | "stop"
  run?: string
  setup?: { scope?: string; full?: boolean; allow?: ("merge" | "deploy")[]; lanes?: number; for?: string; until_time?: string; until?: string }
  automation_id?: string
  reason?: string
}

type Armed = { runId: string; root: string }

export type Deps = { run?: Run; now?: () => number; ticks?: Ticks }

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
      ? 'Ask every missing value in ONE parley_ask round (fall back to the question tool), with recommendations (lanes: 3). Then call autopilot_status with action "arm" and the answers in setup.'
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

  constructor(
    readonly ctx: Context,
    deps: Deps = {},
  ) {
    this.#run = deps.run ?? runCommand
    this.#now = deps.now ?? Date.now
    this.activity = new Activity(this.#now)
    this.#ticks = deps.ticks ?? new Ticks()
  }

  async load(): Promise<void> {
    const page = await this.ctx.storage.scan({ prefix: "armed/" }).catch(() => ({ entries: [] as { key: string; value: unknown }[] }))
    for (const entry of page.entries) {
      const value = entry.value as Partial<Armed> | null
      if (typeof value?.runId === "string" && typeof value.root === "string") this.armed.set(entry.key.slice("armed/".length), { runId: value.runId, root: value.root })
    }
    for (const [sessionID, armed] of this.armed) {
      const state = new RunDir(armed.root, armed.runId).readState()
      if (state?.phase === "running" && state.tick.kind === "fallback") this.#startFallback(sessionID)
    }
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
        const info = (await this.ctx.session.get({ sessionID: id } as never).catch(() => undefined)) as { parentID?: string | null } | undefined
        parent = typeof info?.parentID === "string" && info.parentID !== "" ? info.parentID : null
        this.activity.rememberParent(id, parent ?? undefined)
      }
      id = parent ?? undefined
    }
    return undefined
  }

  /** The running (not setup) run whose rules apply to `sessionID`. */
  async runningFor(sessionID: string): Promise<{ lead: string; dir: RunDir; state: RunState } | undefined> {
    const lead = await this.leadFor(sessionID)
    if (lead === undefined) return undefined
    const armed = this.armed.get(lead) as Armed
    const dir = new RunDir(armed.root, armed.runId)
    const state = dir.readState()
    return state?.phase === "running" ? { lead, dir, state } : undefined
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
    const [beads, commits, kids] = await Promise.all([
      readBeads(state.directory, this.#run),
      commitCount(state.directory, this.#run),
      this.ctx.session.list({ parentID: state.sessionID, limit: 100 } as never).catch(() => undefined) as Promise<{ data?: { id?: string; title?: string }[] } | undefined>,
    ])
    const children = (kids?.data ?? [])
      .filter((kid): kid is { id: string; title?: string } => typeof kid?.id === "string")
      .map((kid) => this.activity.child(kid.id, kid.title, state.armedAt ?? now))
    return { now, beads: beads.beads, ready: beads.ready, blocked: beads.blocked, commits, children, journal: dir.journal(), leadBusy: this.activity.busy(state.sessionID) }
  }

  // --- commands -------------------------------------------------------------------------------

  async command(sessionID: string, text: string): Promise<string> {
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
        dir.writeState(newRunState({ runId, sessionID, directory, options: invocation.options, scope: classifyScope(invocation.options.scope), now }))
        await this.#arm(sessionID, { runId, root })
        return setupPrompt(runId, invocation)
      }
      case "stop": {
        const dir = this.#dirFor(sessionID, undefined)
        const state = dir?.readState()
        if (!dir || !state) return "autopilot: no run in this session."
        dir.writeState({ ...state, stopRequested: true })
        return `Autopilot stop requested for run ${state.runId}. Call autopilot_status with action "stop", delete the tick automation with tools.opencode.automation_delete if one exists, then print the summary and end.`
      }
      case "resume": {
        const dir = findRun(root, invocation.runId)
        const state = dir?.readState()
        if (!dir || !state) return `autopilot: no run ${invocation.runId ?? "latest"} under ${root}.`
        if (state.phase === "stopped") return `autopilot: run ${state.runId} already stopped (${state.stopReason}); start a new one.`
        for (const [other, armed] of this.armed) if (armed.runId === state.runId && other !== sessionID) await this.#disarm(other)
        dir.writeState({ ...state, sessionID, phase: "running", tick: { kind: "none" } })
        await this.#arm(sessionID, { runId: state.runId, root })
        const status = await this.status(sessionID, { action: "status", run: state.runId })
        return [
          `Autopilot run ${state.runId} resumed in this session. Load the ${SKILL} skill and follow it; no questions.`,
          `Create the tick automation with tools.opencode.automation_create(${JSON.stringify(automationRequest(state.runId, state.deadline))}); on failure call autopilot_status with action "fallback".`,
          `Status: ${JSON.stringify(status)}`,
        ].join("\n")
      }
      case "review": {
        const dir = findRun(root, invocation.runId)
        const summary = dir?.summary()
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
    const info = (await this.ctx.session.get({ sessionID } as never).catch(() => undefined)) as { location?: { directory?: string }; directory?: string } | undefined
    return info?.location?.directory ?? info?.directory ?? (this.ctx.location.directory as string)
  }

  // --- tools ----------------------------------------------------------------------------------

  async status(sessionID: string, input: StatusInput): Promise<Record<string, unknown>> {
    const dir = this.#dirFor(sessionID, input.run)
    const state = dir?.readState()
    if (!dir || !state) return { error: "no autopilot run for this session; start one with /autopilot" }
    const action = input.action ?? "status"
    if (action === "arm") return this.#armRun(dir, state, input)
    if (state.phase === "stopped") return { done: true, stopped: state.stopReason, summary: dir.summaryPath }
    if (action === "stop") return this.stop(dir, state, input.reason ?? "stop requested")
    if (action === "fallback") {
      dir.writeState({ ...state, tick: { kind: "fallback" } })
      this.#startFallback(state.sessionID)
      return { ok: true, tick: "fallback", every: TICK_MS }
    }
    if (state.phase !== "running") return { phase: state.phase, note: 'run is in setup: finish the setup round and call action "arm"' }
    if (action === "tick" && this.activity.busy(state.sessionID)) return { skip: "lead session busy" }
    const result = tick(state, await this.snapshot(state, dir))
    const kept = action === "tick" ? result.state : { ...result.state, ticks: state.ticks, idleTicks: state.idleTicks }
    dir.writeState(kept)
    for (const action of result.actions)
      if (action.kind === "park") dir.append({ ts: new Date(this.#now()).toISOString(), type: "blocker", summary: action.reason, bead: action.item, parked: true })
    const out = {
      ping: result.ping,
      progress: result.progress,
      newlyUnblocked: result.newlyUnblocked,
      actions: result.actions,
      beads: result.state.beads,
      parked: result.state.parked,
      idleTicks: kept.idleTicks,
      ...(result.stop ? { stop: result.stop } : {}),
    }
    if (result.stop !== undefined && action === "tick")
      return { ...out, done: true, prompt: `Autopilot is stopping: ${result.stop}. Call autopilot_status with action "stop" and reason "${result.stop}", then print the summary and end.` }
    return { ...out, prompt: tickPrompt(result) }
  }

  async #armRun(dir: RunDir, state: RunState, input: StatusInput): Promise<Record<string, unknown>> {
    if (state.phase === "running") {
      if (input.automation_id) dir.writeState({ ...state, tick: { kind: "automation", automationId: input.automation_id } })
      return { ok: true, phase: "running", automation: automationRequest(state.runId, state.deadline) }
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
      ...(deadline !== undefined ? { deadline } : {}),
    }
    const first = tick(next, await this.snapshot(next, dir))
    dir.writeState({ ...first.state, ticks: 0, idleTicks: 0 })
    dir.append({ ts: new Date(now).toISOString(), type: "action", summary: `armed: ${JSON.stringify(next.options)}` })
    return {
      ok: true,
      phase: "running",
      ping: first.ping,
      automation: automationRequest(state.runId, deadline),
      next: 'Create the automation with tools.opencode.automation_create(automation), then call autopilot_status with action "arm" and automation_id. If creation fails, call action "fallback". No questions from now on.',
    }
  }

  async stop(dir: RunDir, state: RunState, reason: string): Promise<Record<string, unknown>> {
    const now = this.#now()
    const journal = dir.journal()
    const stopped: RunState = { ...state, phase: "stopped", stopReason: state.stopReason ?? reason, stoppedAt: now }
    dir.append({ ts: new Date(now).toISOString(), type: "stop", summary: stopped.stopReason as string })
    dir.writeState(stopped)
    const summary = renderSummary(stopped, dir.journal(), dir.path)
    dir.writeSummary(summary)
    const created = await this.#run(state.directory, "bd", [
      "create",
      `Autopilot handoff: run ${state.runId}`,
      "--labels",
      "autopilot-handoff",
      "-d",
      handoffDescription(stopped, journal, dir.path),
      "--json",
    ])
    let handoff: string | undefined
    try {
      handoff = (JSON.parse(created.stdout.slice(created.stdout.indexOf("{"))) as { id?: string }).id
    } catch {
      handoff = undefined
    }
    await this.#disarm(state.sessionID)
    return {
      done: true,
      stopped: stopped.stopReason,
      summaryPath: dir.summaryPath,
      handoff: handoff ?? `not created: ${created.stderr.trim() || "bd create failed"}`,
      automationId: state.tick.automationId,
      next: state.tick.automationId ? `Delete the automation: tools.opencode.automation_delete({ id: "${state.tick.automationId}" }). Then print the summary and end.` : "Print the summary and end.",
      summary,
    }
  }

  async log(sessionID: string, input: unknown): Promise<string> {
    const running = await this.runningFor(sessionID)
    const dir = running?.dir ?? this.#dirFor(sessionID, undefined)
    if (!dir) return "autopilot_log: no autopilot run for this session"
    const entry = validateEntry(input, new Date(this.#now()))
    if ("error" in entry) return `autopilot_log: ${entry.error}`
    dir.append(entry)
    const state = running?.state ?? dir.readState()
    if (entry.bead && (entry.type === "blocker" || entry.type === "ambiguity") && state && !state.options.full) {
      const flagged = await this.#run(state.directory, "bd", ["update", entry.bead, "--add-label", "human", "--json"])
      return `logged ${entry.type}${flagged.ok ? `; flagged ${entry.bead} human` : `; could not flag ${entry.bead}: ${flagged.stderr.trim()}`}`
    }
    return `logged ${entry.type}`
  }

  // --- fallback timer -------------------------------------------------------------------------

  #startFallback(sessionID: string): void {
    this.#ticks.start(sessionID, TICK_MS, async () => {
      if (this.activity.busy(sessionID)) return
      const result = await this.status(sessionID, { action: "tick" })
      const prompt = typeof result.prompt === "string" ? result.prompt : undefined
      if (result.done) this.#ticks.stop(sessionID)
      if (prompt) await this.ctx.session.prompt({ sessionID, text: prompt } as never)
    })
  }

  // --- hooks ----------------------------------------------------------------------------------

  /** Throws to deny an ask-the-user tool while a run is armed. */
  async beforeTool(tool: string, sessionID: string): Promise<void> {
    if (!isAskTool(tool)) return
    if (await this.runningFor(sessionID)) throw new Error(DENY_QUESTION)
  }

  async evaluate(event: { sessionID: string; action: string; resources: ReadonlyArray<string>; effect: string; message?: string }): Promise<void> {
    if (event.effect !== "ask") return
    const running = await this.runningFor(event.sessionID)
    if (!running) return
    const decision = decideAsk(event.action, event.resources, running.state.options.allow)
    event.effect = decision.effect
    if (decision.effect === "deny") {
      event.message = decision.reason
      running.dir.append({ ts: new Date(this.#now()).toISOString(), type: "blocker", summary: `${event.action} denied: ${decision.reason}`, evidence: event.resources.join(" ").slice(0, 300) })
    }
  }

  async idle(sessionID: string): Promise<void> {
    if (!this.armed.has(sessionID)) return
    const running = await this.runningFor(sessionID)
    if (!running) return
    const messages = await this.ctx.session.context({ sessionID } as never).catch(() => [])
    if (!endsWithQuestion(lastAssistantText(messages))) return
    await this.ctx.session.synthetic({ sessionID, text: REPROMPT, delivery: "steer", metadata: { source: ID, kind: "reprompt" } } as never)
  }

  async compacted(sessionID: string): Promise<void> {
    if (!this.armed.has(sessionID)) return
    const running = await this.runningFor(sessionID)
    if (!running) return
    const status = await this.status(sessionID, { action: "status" })
    await this.ctx.session.synthetic({
      sessionID,
      text: `Autopilot run ${running.state.runId} is still armed after compaction. Reload the ${SKILL} skill; never ask the user. Status: ${JSON.stringify(status)}`,
      delivery: "queue",
      metadata: { source: ID, kind: "compaction" },
    } as never)
  }
}

export async function setupAutopilot(ctx: Context, deps: Deps = {}): Promise<() => Promise<void>> {
  const pilot = new Autopilot(ctx, deps)
  await pilot.load()
  const registrations: { dispose: () => Promise<void> }[] = []
  const report = (what: string) => (error: unknown) => console.error(`${ID}: ${what} failed`, error)
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
      } as never)
      editor.add({
        name: "autopilot_log",
        description: LOG_DESCRIPTION,
        input: LOG_INPUT_SCHEMA,
        execute: async (input, tool) => ({ content: await pilot.log(tool.sessionID, input) }),
      } as never)
    }),
  )
  registrations.push(
    await ctx.command.transform((editor) => {
      editor.add({
        name: "autopilot",
        description: 'Run this session unattended: /autopilot [scope] [--full] [--allow merge,deploy] [--lanes N] [--for 3h|--until-time HH:MM] [--until "…"] | resume | review | stop',
        execute: async (input: { sessionID: string; prompt: { text?: string }; delivery?: unknown }) => {
          const text = await pilot.command(input.sessionID, input.prompt.text ?? "")
          await ctx.session.prompt({ ...input.prompt, sessionID: input.sessionID, text, delivery: input.delivery } as never)
        },
      } as never)
    }),
  )
  registrations.push(await ctx.tool.hook("execute.before", (event) => pilot.beforeTool(event.tool, event.sessionID)))
  registrations.push(await ctx.permission.hook("evaluate", (event) => pilot.evaluate(event as never).catch(report("permission hook"))))
  registrations.push(
    await ctx.session.hook("experimental.idle" as never, (event: { sessionID: string }) => {
      void pilot.idle(event.sessionID).catch(report("idle hook"))
    }),
  )
  registrations.push(await registerSkills(ctx.skill, [SKILL_FILE]))
  const abort = new AbortController()
  const iterator = ctx.event.subscribe({ signal: abort.signal } as never)[Symbol.asyncIterator]()
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
