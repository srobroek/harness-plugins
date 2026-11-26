/**
 * What each session last said is running, one raw report per session.
 *
 * The idle hook hands delivery the session's `background` list. Delivery keeps it as it came, in one
 * file per session under `<receipts root>/.running/`, and decides nothing at write time: whether a
 * report touches a worktree is judged when a removal asks (`reportBlock`), with the worktree in hand.
 * So a report needs no repository, no clone listing and no session lookup to be recorded.
 *
 * Threat model: the receipts root belongs to one machine, and any OpenCode server on that machine may
 * write it. Reports from another host hold until they expire, measured on the reader's clock against
 * the file's mtime; clocks across hosts are not trusted, so `at` only orders the writes of one session.
 *
 * Only the session that wrote a report clears it (an empty list deletes the file), or its deletion.
 * A write never replaces a report of the same session that has a newer `at`. The compare and the
 * rename are one step only while the caller holds the store's lease (`pending-cleanup.ts` takes it for
 * every write and for a removal's last read through the removal); nothing here takes it.
 *
 * Pure functions over the directory, tested directly in `running-reports.test.ts`.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, sep } from "node:path"
import { readBoundedBytes } from "@srobroek/opencode-lib/bounded-read"
import { HOLD_EXPIRY_MS } from "@srobroek/opencode-lib/worktree-locks"

/** A report is a few hundred bytes per job; anything bigger than this is not read, and not written. */
export const MAX_REPORT_BYTES = 1024 * 1024

/**
 * One entry of the idle hook's `background` list. The host's list gives a shell its `command` and the
 * session that owns it, and nothing about where it runs; `cwd` is kept when a job carries one.
 */
export type ReportJob = { kind: string; sessionID?: string; childSessionID?: string; shellID?: string; command?: string; cwd?: string }

/**
 * A session's last report from one server instance: its jobs, when it was written (`at`, for display and
 * versioning only), by which server (host, pid and instance), and the instance's local generation of the
 * report (`gen`), which orders that instance's own writes. Each instance writes only its own file for a
 * session, so no ordering between instances is needed. A file written before `gen` existed reads as 0.
 */
export type RunningReport = { sessionID: string; jobs: ReportJob[]; at: number; pid: number; host: string; instance: string; gen: number }

/** What a writer hands over: `gen` defaults to 0. */
export type NewReport = Omit<RunningReport, "gen"> & { gen?: number }

/** A report as read: with the file's mtime, which is what expiry is measured against. */
export type StoredReport = RunningReport & { mtimeMs: number }

/** What a job's session lookup found: where it works, that the host does not have it, or that nothing could be learned. */
export type JobLookup = { state: "at"; directory: string | undefined } | { state: "missing" } | { state: "unknown" }

export const runningDirectory = (receiptsRoot: string) => join(receiptsRoot, ".running")

const sessionKey = (sessionID: string) => createHash("sha1").update(sessionID).digest("hex")

/** The file of `sessionID`'s report from `instance`: one per session and instance, so no two writers share one. */
export const reportFile = (receiptsRoot: string, sessionID: string, instance: string) =>
  join(runningDirectory(receiptsRoot), `${sessionKey(sessionID)}.${createHash("sha1").update(instance).digest("hex").slice(0, 16)}.json`)

/** Where a report was kept before the instance joined the name. Still read; removed only by its own writer. */
export const legacyReportFile = (receiptsRoot: string, sessionID: string) => join(runningDirectory(receiptsRoot), `${sessionKey(sessionID)}.json`)

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/**
 * A report from its file's text; undefined when it is not one. This, with the exported
 * {@link RunningReport} type, is the one schema of what delivery persists here: every read goes through
 * it and a type or shape that does not match makes the file unreadable. Pure.
 */
export function parseReport(text: string): RunningReport | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(raw) || typeof raw.sessionID !== "string" || raw.sessionID === "") return undefined
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined
  if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid < 1) return undefined
  if (typeof raw.host !== "string" || raw.host === "" || typeof raw.instance !== "string" || !Array.isArray(raw.jobs)) return undefined
  if (raw.gen !== undefined && (typeof raw.gen !== "number" || !Number.isInteger(raw.gen) || raw.gen < 0)) return undefined
  const jobs: ReportJob[] = []
  for (const job of raw.jobs) {
    if (!isObject(job) || typeof job.kind !== "string") return undefined
    // A field that is present must be text: a report that says something else is not one.
    const fields = [job.sessionID, job.childSessionID, job.shellID, job.command, job.cwd]
    if (fields.some((field) => field !== undefined && typeof field !== "string")) return undefined
    const [sessionID, childSessionID, shellID, command, cwd] = fields.map(optionalString)
    jobs.push({
      kind: job.kind,
      ...(sessionID === undefined ? {} : { sessionID }),
      ...(childSessionID === undefined ? {} : { childSessionID }),
      ...(shellID === undefined ? {} : { shellID }),
      ...(command === undefined ? {} : { command }),
      ...(cwd === undefined ? {} : { cwd }),
    })
  }
  return { sessionID: raw.sessionID, jobs, at: raw.at, pid: raw.pid, host: raw.host, instance: raw.instance, gen: raw.gen ?? 0 }
}

type Stored = { kind: "report"; report: StoredReport } | { kind: "absent" } | { kind: "unreadable" }

/** The file at `path`: a report, nothing, or something that is not a small regular file holding one. Never blocks on a FIFO. */
export function readStored(path: string): Stored {
  const read = readBoundedBytes(path, MAX_REPORT_BYTES)
  if (read.kind === "absent") return { kind: "absent" }
  if (read.kind === "unreadable") return { kind: "unreadable" }
  const parsed = parseReport(read.bytes.toString("utf8"))
  if (parsed === undefined) return { kind: "unreadable" }
  try {
    return { kind: "report", report: { ...parsed, mtimeMs: statSync(path).mtimeMs } }
  } catch {
    return { kind: "unreadable" }
  }
}

/**
 * Record `report` as its instance's one report of the session: a temp file and a rename. The caller holds
 * the store's lease and decides, by its own generation, that this write is the session's current one.
 * Throws when it cannot write.
 */
export function writeReport(receiptsRoot: string, report: NewReport): void {
  const full: RunningReport = { ...report, gen: report.gen ?? 0 }
  const text = JSON.stringify(full)
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES) throw new Error(`the report of ${report.sessionID} is larger than ${MAX_REPORT_BYTES} bytes`)
  mkdirSync(runningDirectory(receiptsRoot), { recursive: true })
  const file = reportFile(receiptsRoot, report.sessionID, report.instance)
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, file)
}

/** The instance's clear of its own report: its file is deleted, and no other instance's is touched. Throws when it cannot. */
export function clearReport(receiptsRoot: string, sessionID: string, instance: string): void {
  rmSync(reportFile(receiptsRoot, sessionID, instance), { force: true })
}

/**
 * The instance's removal of its report for a deleted session, unless the file on disk carries a generation
 * above `maxGen` (a newer incarnation of the session wrote it). A file that cannot be read is the
 * instance's own and goes. Throws when it cannot delete.
 */
export function removeReport(receiptsRoot: string, sessionID: string, instance: string, maxGen: number = Number.POSITIVE_INFINITY): "removed" | "kept" {
  const file = reportFile(receiptsRoot, sessionID, instance)
  const stored = readStored(file)
  if (stored.kind === "report" && stored.report.gen > maxGen) return "kept"
  rmSync(file, { force: true })
  return "removed"
}

/** Delete the un-suffixed file of `sessionID` when its pid and instance are the caller's; any other stays. Throws when it cannot delete. */
export function removeLegacyReport(receiptsRoot: string, sessionID: string, instance: string, pid: number): boolean {
  const file = legacyReportFile(receiptsRoot, sessionID)
  const stored = readStored(file)
  if (stored.kind !== "report" || stored.report.instance !== instance || stored.report.pid !== pid) return false
  rmSync(file, { force: true })
  return true
}

/** Every instance's report of every session (and legacy files). `unreadable` when the directory (other than absent) or any entry could not be read safely. */
export function readReports(receiptsRoot: string): { reports: StoredReport[]; unreadable: boolean } {
  const directory = runningDirectory(receiptsRoot)
  let names: string[]
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"))
  } catch (error) {
    return { reports: [], unreadable: (error as NodeJS.ErrnoException).code !== "ENOENT" }
  }
  const reports: StoredReport[] = []
  let unreadable = false
  for (const name of names) {
    const stored = readStored(join(directory, name))
    if (stored.kind === "report") reports.push(stored.report)
    else if (stored.kind === "unreadable") unreadable = true
  }
  return { reports, unreadable }
}

/** Whether a report can be written right now: a real probe write in the directory reports go to. Any error is unsafe. */
export function reportsWritable(receiptsRoot: string): boolean {
  const directory = runningDirectory(receiptsRoot)
  try {
    mkdirSync(directory, { recursive: true })
    const probe = join(directory, `.probe.${randomUUID()}`)
    writeFileSync(probe, "")
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/** What a report's version is: it changes when the session writes it again. */
export const reportVersion = (report: RunningReport): string => `${report.sessionID}:${report.at}:${report.instance}:${report.gen}:${JSON.stringify(report.jobs)}`

/**
 * What decides whether a report still counts: the reader's clock (against the file's mtime), who the
 * reader is (host and server instance) and whether a process is alive.
 */
export type ReportClock = { now: number; host: string; instance: string; alive: (pid: number) => boolean; expiryMs?: number }

/**
 * Whether a report still counts. On this host the reporter's process decides, and its age does not: a
 * report of this server counts (its process is this one), and one of another server on this host counts
 * while its pid is alive, however old its file is. A report from another host cannot be judged by pid, so
 * it counts until its file is older than the expiry on the reader's clock. Pure.
 */
export function reportLive(report: StoredReport, clock: ReportClock): boolean {
  if (report.instance === clock.instance) return true
  if (report.host === clock.host) return clock.alive(report.pid)
  return clock.now - report.mtimeMs < (clock.expiryMs ?? HOLD_EXPIRY_MS)
}

const sameServer = (report: RunningReport, clock: ReportClock): boolean => report.instance === clock.instance

const namesWorktree = (command: string | undefined, forms: readonly string[]): boolean =>
  command !== undefined && forms.some((form) => command.includes(form))

/** The sessions whose location says where a job runs, when the job itself does not say. */
const jobSessions = (job: ReportJob): string[] => [job.sessionID, job.childSessionID].filter((id): id is string => typeof id === "string")

/** Whether `directory` is the worktree or inside it. */
const within = (directory: string, forms: readonly string[]): boolean =>
  forms.some((form) => directory === form || directory.startsWith(form.endsWith(sep) ? form : `${form}${sep}`))

/**
 * The session ids whose location a removal has to look up before {@link reportBlock} can decide: each
 * live report's own session (only this server's reports: another server's sessions say nothing about
 * them), and the sessions of its jobs that a command or a recorded cwd does not already settle. Pure.
 */
export function neededLookups(reports: readonly StoredReport[], forms: readonly string[], clock: ReportClock): string[] {
  const ids = new Set<string>()
  for (const report of reports) {
    if (!reportLive(report, clock) || report.jobs.length === 0) continue
    if (sameServer(report, clock)) ids.add(report.sessionID)
    for (const job of report.jobs) {
      if (namesWorktree(job.command, forms) || job.cwd !== undefined) continue
      for (const id of jobSessions(job)) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * Why a live report keeps the worktree whose path is `forms` (the raw and the canonical path), or
 * undefined. A job holds when its command names the worktree, or its recorded cwd is inside it. A job
 * with no recorded cwd runs where its owning sessions work: it holds when one of them works inside the
 * worktree, cannot be located (the lookup failed or timed out, or the host gave no directory), or was
 * not looked up at all (a report that came in after the lookups); a job with no owning session has no
 * cwd to establish, so it holds. A session the host does not have is skipped, and so is a report whose
 * own session it does not have, but only for a report of this server: another server's reports are
 * judged by its pid, never by what this host's sessions say. `canonical` maps a path to its canonical
 * form. Pure.
 */
export function reportBlock(
  reports: readonly StoredReport[],
  forms: readonly string[],
  lookup: (sessionID: string) => JobLookup | undefined,
  clock: ReportClock,
  canonical: (path: string) => string,
): string | undefined {
  for (const report of reports) {
    if (!reportLive(report, clock) || report.jobs.length === 0) continue
    const ours = sameServer(report, clock)
    if (ours && lookup(report.sessionID)?.state === "missing") continue
    for (const job of report.jobs) {
      if (namesWorktree(job.command, forms)) return `session ${report.sessionID} has a ${job.kind} running that names the worktree`
      if (job.cwd !== undefined) {
        if (within(canonical(job.cwd), forms)) return `session ${report.sessionID} has a ${job.kind} running in the worktree`
        continue
      }
      const owners = jobSessions(job)
      if (owners.length === 0) return `session ${report.sessionID} has a ${job.kind} whose working directory is unknown`
      for (const id of owners) {
        const found = lookup(id)
        if (found === undefined) return `session ${report.sessionID} reported work in session ${id}, which has not been looked up`
        if (found.state === "unknown") return `session ${report.sessionID} reported work in session ${id}, whose location could not be read`
        if (found.state === "missing") {
          if (ours) continue
          return `session ${report.sessionID} (another server) reported work in session ${id}, which this server cannot place`
        }
        if (found.directory === undefined) return `session ${report.sessionID} reported work in session ${id}, which has no working directory`
        if (within(canonical(found.directory), forms)) return `session ${report.sessionID} has work in session ${id}, which runs in the worktree`
      }
    }
  }
  return undefined
}

/** The store's lease file: every writer of a report, and every remover from its last read to its end, holds it. */
export const runningLeaseFile = (receiptsRoot: string) => join(receiptsRoot, ".running.lock")

/**
 * Why the reports hold a removal of `forms` for a remover with no session lookup (pi, OMP): nothing
 * about where a job's session works can be learned, so a job that records no cwd and does not name the
 * worktree in its command holds. A store that cannot be read or written holds too. Liveness is by pid
 * on this host and by expiry otherwise. Read under the store's lease. Pure apart from reading the store.
 */
export function blockWithoutSessionLookup(
  receiptsRoot: string,
  forms: readonly string[],
  clock: Pick<ReportClock, "now" | "host" | "alive">,
  canonical: (path: string) => string,
): string | undefined {
  if (!reportsWritable(receiptsRoot)) return "the running-work store is not writable, so running work cannot be ruled out"
  const read = readReports(receiptsRoot)
  if (read.unreadable) return "the running-work reports cannot be read, so running work cannot be ruled out"
  // No instance of a server matches this one, so no report is judged dead by what a session lookup says.
  return reportBlock(read.reports, forms, () => ({ state: "unknown" }), { ...clock, instance: "" }, canonical)
}
