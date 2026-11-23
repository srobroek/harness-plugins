/** Run state, the status diff, stop conditions, the stall ladder and the ping line. Pure. */

import type { Grant, RunOptions, Scope } from "./args.ts"
import { type JournalEntry, parkedBeads } from "./journal.ts"
import { holdsLane, type RootIdentity } from "./policy.ts"

export const TICK_EVERY = "4 minutes"
export const TICK_MS = 4 * 60_000
export const STALL_MS = 12 * 60_000
export const MAX_IDLE_TICKS = 6
export const MAX_ATTEMPTS = 3

/** `stopping`: the stop is decided and its artifacts (summary, handoff bead) are being written; see `RunState.stop`. */
export type Phase = "setup" | "running" | "stopping" | "stopped"
export type StallStep = "nudge" | "respawn" | "park"

export type ChildState = {
  /** The last ladder step taken for this child, and when. */
  step?: StallStep
  stepAt?: number
  done?: boolean
}

export type BeadCounts = { open: string[]; ready: string[]; blocked: string[]; inProgress: string[]; closed: string[] }

export type RunState = {
  version: 1
  /** Bumped by every write; a writer whose read is older than the file is stale and is refused. */
  generation: number
  runId: string
  sessionID: string
  directory: string
  phase: Phase
  options: RunOptions & { allow: Grant[]; lanes: number; full: boolean }
  scope: Scope
  /** The beads ledger (`.beads` directory) every `bd` call of the run uses; absent in runs armed before it existed. */
  ledger?: string
  createdAt: number
  armedAt?: number
  deadline?: number
  /** The tick bound to this run: its automation and the token its ticks must carry. A tick with another token is stale. */
  tick: { kind: "none" | "automation" | "fallback"; automationId?: string; token?: string }
  ticks: number
  idleTicks: number
  beads: BeadCounts
  commits: number
  journalLength: number
  finishedChildren: number
  attempts: Record<string, number>
  children: Record<string, ChildState>
  /** Items parked by the plugin itself (attempts, repeated error, stalled lane). */
  parked: string[]
  /** Worktree roots the run's lanes work in, as the host reported them; the permission hook may allow `<root>/*`. */
  worktrees?: RootIdentity[]
  stopRequested?: boolean
  stopReason?: string
  stoppedAt?: number
  /** While stopping: how much of the journal the summary and handoff render, and which of them exist. */
  stop?: { journalLength: number; summary: boolean; handoff?: string }
}

export type Bead = { id: string; status: string; parent?: string | null; issue_type?: string; labels?: string[] | null }
export type Child = { sessionID: string; title?: string; agent?: string; worktree?: RootIdentity; busy: boolean; lastActivity: number }

/** What one look at the world finds. */
export type Snapshot = {
  now: number
  beads: Bead[]
  ready: string[]
  blocked: string[]
  /** Whether every `bd` read succeeded; when not, the bead lists are empty, not facts. */
  beadsRead: boolean
  commits: number
  children: Child[]
  /** Whether `children` is every direct child; a capped or failed listing is not. */
  childrenComplete: boolean
  journal: JournalEntry[]
  leadBusy: boolean
}

export type Action =
  | { kind: "nudge" | "respawn"; sessionID: string; title?: string }
  | { kind: "park"; item: string; reason: string }
  | { kind: "stop"; reason: string }

export type TickResult = {
  state: RunState
  progress: boolean
  newlyUnblocked: string[]
  actions: Action[]
  stop?: string
  ping: string
}

/** Whether a bead is work the run counts: epics are containers and the run's own handoff beads are not work. */
export function isWorkBead(bead: Pick<Bead, "issue_type" | "labels">): boolean {
  return bead.issue_type !== "epic" && !(bead.labels ?? []).includes("autopilot-handoff")
}

/** Whether `bead` is the scope bead or one of its descendants (by `parent` or dotted id). */
export function inScope(bead: Bead, scope: Scope, all: ReadonlyMap<string, Bead>): boolean {
  if (scope.kind !== "bead") return true
  let current: Bead | undefined = bead
  for (let depth = 0; current && depth < 32; depth++) {
    if (current.id === scope.id || current.id.startsWith(`${scope.id}.`)) return true
    current = current.parent ? all.get(current.parent) : undefined
  }
  return false
}

/** The scope's beads, by status; epics count only as containers. */
export function countBeads(snapshot: Pick<Snapshot, "beads" | "ready" | "blocked">, scope: Scope): BeadCounts {
  const all = new Map(snapshot.beads.map((bead) => [bead.id, bead]))
  const work = snapshot.beads.filter((bead) => inScope(bead, scope, all) && isWorkBead(bead))
  const ids = new Set(work.map((bead) => bead.id))
  const sorted = (list: string[]) => [...new Set(list)].sort()
  return {
    open: sorted(work.filter((bead) => bead.status !== "closed").map((bead) => bead.id)),
    ready: sorted(snapshot.ready.filter((id) => ids.has(id))),
    blocked: sorted(snapshot.blocked.filter((id) => ids.has(id))),
    inProgress: sorted(work.filter((bead) => bead.status === "in_progress").map((bead) => bead.id)),
    closed: sorted(work.filter((bead) => bead.status === "closed").map((bead) => bead.id)),
  }
}

/** The next stall step for a child, or `undefined` while it is active or waiting out the last step. */
export function stallStep(child: Child, previous: ChildState | undefined, now: number): StallStep | undefined {
  if (now - child.lastActivity < STALL_MS) return undefined
  const since = previous?.stepAt ?? 0
  if (previous?.step === undefined) return "nudge"
  if (now - since < STALL_MS) return undefined
  if (previous.step === "nudge") return "respawn"
  if (previous.step === "respawn") return "park"
  return undefined
}

/** The repeated error signature when the last two error entries match. */
export function repeatedError(journal: readonly JournalEntry[]): string | undefined {
  const errors = journal.filter((entry) => entry.error !== undefined)
  const last = errors.at(-1)
  const before = errors.at(-2)
  return last && before && last.error === before.error ? last.error : undefined
}

/**
 * The reason to stop now, or `undefined`. Order: requested, logged, deadline, scope done, stuck, idle.
 * `newEntries` are the journal entries since the previous tick. A goal scope has no beads of its own,
 * so the bead-based conditions apply to bead and queue scopes only, and only after a complete `bd` read.
 */
export function stopReason(
  state: RunState,
  snapshot: Pick<Snapshot, "now" | "children" | "childrenComplete" | "beadsRead">,
  newEntries: readonly JournalEntry[],
  parked: ReadonlySet<string>,
): string | undefined {
  if (state.stopRequested) return "stop requested"
  const logged = newEntries.find((entry) => entry.type === "stop")
  if (logged) return `logged: ${logged.summary}`
  if (state.deadline !== undefined && snapshot.now >= state.deadline) return "budget or deadline reached"
  const { open, ready, inProgress } = state.beads
  const beadScope = state.scope.kind !== "goal" && snapshot.beadsRead
  if (beadScope && open.length === 0) return "scope finished"
  const busyChildren = !snapshot.childrenComplete || snapshot.children.some((child) => child.busy)
  if (beadScope && open.length > 0 && !busyChildren && inProgress.every((id) => parked.has(id)) && ready.every((id) => parked.has(id)))
    return "everything left is blocked or parked"
  if (state.idleTicks >= MAX_IDLE_TICKS) return `${MAX_IDLE_TICKS} ticks without progress`
  return undefined
}

/** One tick: diff `snapshot` against `previous`, evaluate stalls and stops, render the ping. */
export function tick(previous: RunState, snapshot: Snapshot): TickResult {
  const beads = snapshot.beadsRead ? countBeads(snapshot, previous.scope) : previous.beads
  const newlyUnblocked = snapshot.beadsRead ? beads.ready.filter((id) => previous.beads.blocked.includes(id)) : []
  const newEntries = snapshot.journal.slice(previous.journalLength)
  const finishedChildren = Object.values(previous.children).filter((child) => child.done).length
  const children: Record<string, ChildState> = {}
  const actions: Action[] = []
  let childResults = 0
  for (const child of snapshot.children) {
    const before = previous.children[child.sessionID]
    const state: ChildState = { ...before }
    if (!child.busy) {
      if (!state.done) childResults += 1
      state.done = true
      delete state.step
      delete state.stepAt
    } else {
      state.done = false
      if (snapshot.now - child.lastActivity < STALL_MS) {
        delete state.step
        delete state.stepAt
      }
      const step = stallStep(child, state, snapshot.now)
      if (step !== undefined) {
        state.step = step
        state.stepAt = snapshot.now
        actions.push(
          step === "park"
            ? { kind: "park", item: child.title ?? child.sessionID, reason: `lane ${child.sessionID} stalled after nudge and respawn` }
            : { kind: step, sessionID: child.sessionID, ...(child.title ? { title: child.title } : {}) },
        )
      }
    }
    children[child.sessionID] = state
  }
  const progress =
    beads.closed.length > previous.beads.closed.length ||
    snapshot.commits > previous.commits ||
    newEntries.some((entry) => entry.type === "progress") ||
    childResults > 0
  const attempts = { ...previous.attempts }
  const parked = new Set([...previous.parked, ...parkedBeads(snapshot.journal)])
  for (const id of beads.inProgress) {
    if (previous.beads.inProgress.includes(id)) continue
    attempts[id] = (attempts[id] ?? 0) + 1
  }
  for (const [id, count] of Object.entries(attempts)) {
    if (count >= MAX_ATTEMPTS && !beads.closed.includes(id) && !parked.has(id)) {
      parked.add(id)
      actions.push({ kind: "park", item: id, reason: `attempted ${count} times without closing` })
    }
  }
  const repeated = repeatedError(newEntries.length ? snapshot.journal : [])
  if (repeated !== undefined) {
    const item = [...newEntries].reverse().find((entry) => entry.error === repeated)?.bead ?? repeated
    if (!parked.has(item)) {
      parked.add(item)
      actions.push({ kind: "park", item, reason: `same error twice: ${repeated}` })
    }
  }
  const state: RunState = {
    ...previous,
    ticks: previous.ticks + 1,
    idleTicks: progress ? 0 : previous.idleTicks + 1,
    beads,
    commits: snapshot.commits,
    journalLength: snapshot.journal.length,
    finishedChildren: finishedChildren + childResults,
    attempts,
    children,
    parked: [...parked].sort(),
    worktrees: recordWorktrees(previous, snapshot.children),
  }
  const stop = stopReason(state, snapshot, newEntries, parked)
  if (stop !== undefined) actions.push({ kind: "stop", reason: stop })
  const busyLanes = snapshot.children.filter((child) => child.busy && holdsLane(child.agent)).length
  const actedLine = actions.length ? actions.map(describeAction).join("; ") : undefined
  return {
    state,
    progress,
    newlyUnblocked,
    actions,
    ...(stop !== undefined ? { stop } : {}),
    ping:
      renderPing({ now: snapshot.now, busyLanes, lanes: state.options.lanes, beads, newlyUnblocked: newlyUnblocked.length, parked: state.parked.length, deadline: state.deadline }) +
      (snapshot.beadsRead ? "" : " · beads unread") +
      (actedLine ? `\n↳ ${actedLine}` : ""),
  }
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case "nudge":
      return `nudge ${action.title ?? action.sessionID}`
    case "respawn":
      return `abort and respawn ${action.title ?? action.sessionID} once with journal context`
    case "park":
      return `park ${action.item} (${action.reason})`
    case "stop":
      return `stop: ${action.reason}`
  }
}

/** "1h12m", "45m", "0m". */
export function formatRemaining(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`
}

export type PingInput = { now: number; busyLanes: number; lanes: number; beads: BeadCounts; newlyUnblocked: number; parked: number; deadline?: number | undefined }

/** `♥ 14:32 · 2/4 lanes · ready 4 · blocked 2 (+1 unblocked) · parked 1 · 1h12m left` */
export function renderPing(input: PingInput): string {
  const time = new Date(input.now)
  const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`
  const parts = [
    `♥ ${clock}`,
    `${input.busyLanes}/${input.lanes} lanes`,
    `ready ${input.beads.ready.length}`,
    `blocked ${input.beads.blocked.length}${input.newlyUnblocked ? ` (+${input.newlyUnblocked} unblocked)` : ""}`,
    `parked ${input.parked}`,
  ]
  if (input.deadline !== undefined) parts.push(`${formatRemaining(input.deadline - input.now)} left`)
  return parts.join(" · ")
}

/** The prompt a tick sends the lead session. */
export function tickPrompt(result: Pick<TickResult, "ping" | "actions">): string {
  const due = result.actions.length ? ` Actions due: ${result.actions.map(describeAction).join("; ")}.` : " No actions due; keep working."
  return `Autopilot tick. Post this ping verbatim, then continue:\n${result.ping}\n${due.trim()}`
}

/** A fresh state for a run being set up. */
export function newRunState(input: { runId: string; sessionID: string; directory: string; options: RunOptions; scope: Scope; now: number }): RunState {
  return {
    version: 1,
    generation: 0,
    runId: input.runId,
    sessionID: input.sessionID,
    directory: input.directory,
    phase: "setup",
    options: { ...input.options, allow: input.options.allow ?? [], lanes: input.options.lanes ?? 3, full: input.options.full ?? false },
    scope: input.scope,
    createdAt: input.now,
    tick: { kind: "none" },
    ticks: 0,
    idleTicks: 0,
    beads: { open: [], ready: [], blocked: [], inProgress: [], closed: [] },
    commits: 0,
    journalLength: 0,
    finishedChildren: 0,
    attempts: {},
    children: {},
    parked: [],
  }
}

/** A run id: `YYYYMMDD-HHMM-<4 hex>`. */
export function runIdFor(now: number, random: () => number = Math.random): string {
  const date = new Date(now)
  const pad = (value: number) => String(value).padStart(2, "0")
  const suffix = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}-${suffix}`
}

/** The run's recorded worktrees plus those of children not recorded yet. The first identity recorded for a real path stays: a replacement is not the same directory. */
export function recordWorktrees(state: Pick<RunState, "worktrees">, children: readonly Pick<Child, "worktree">[]): RootIdentity[] {
  const roots = new Map((state.worktrees ?? []).map((root) => [root.real, root]))
  for (const child of children) if (child.worktree !== undefined && !roots.has(child.worktree.real)) roots.set(child.worktree.real, child.worktree)
  return [...roots.values()].sort((a, b) => a.real.localeCompare(b.real))
}
