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

/** A session's last report: its jobs, when it was written, and by which server (host, pid and instance). */
export type RunningReport = { sessionID: string; jobs: ReportJob[]; at: number; pid: number; host: string; instance: string }

/** A report as read: with the file's mtime, which is what expiry is measured against. */
export type StoredReport = RunningReport & { mtimeMs: number }

/** What a job's session lookup found: where it works, that the host does not have it, or that nothing could be learned. */
export type JobLookup = { state: "at"; directory: string | undefined } | { state: "missing" } | { state: "unknown" }

export const runningDirectory = (receiptsRoot: string) => join(receiptsRoot, ".running")

export const reportFile = (receiptsRoot: string, sessionID: string) =>
  join(runningDirectory(receiptsRoot), `${createHash("sha1").update(sessionID).digest("hex")}.json`)

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/** A report from its file's text, or undefined when it is not one. Pure. */
export function parseReport(text: string): RunningReport | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(raw) || typeof raw.sessionID !== "string" || raw.sessionID === "") return undefined
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || typeof raw.pid !== "number") return undefined
  if (typeof raw.host !== "string" || typeof raw.instance !== "string" || !Array.isArray(raw.jobs)) return undefined
  const jobs: ReportJob[] = []
  for (const job of raw.jobs) {
    if (!isObject(job) || typeof job.kind !== "string") return undefined
    const sessionID = optionalString(job.sessionID)
    const childSessionID = optionalString(job.childSessionID)
    const shellID = optionalString(job.shellID)
    const command = optionalString(job.command)
    const cwd = optionalString(job.cwd)
    jobs.push({
      kind: job.kind,
      ...(sessionID === undefined ? {} : { sessionID }),
      ...(childSessionID === undefined ? {} : { childSessionID }),
      ...(shellID === undefined ? {} : { shellID }),
      ...(command === undefined ? {} : { command }),
      ...(cwd === undefined ? {} : { cwd }),
    })
  }
  return { sessionID: raw.sessionID, jobs, at: raw.at, pid: raw.pid, host: raw.host, instance: raw.instance }
}

/** The file at `path`: a report, nothing, or something that is not a small regular file holding one. Never blocks on a FIFO. */
export function readStored(path: string): { kind: "report"; report: StoredReport } | { kind: "absent" } | { kind: "unreadable" } {
  const read = readBoundedBytes(path, MAX_REPORT_BYTES)
  if (read.kind === "absent") return { kind: "absent" }
  if (read.kind === "unreadable") return { kind: "unreadable" }
  const report = parseReport(read.bytes.toString("utf8"))
  if (report === undefined) return { kind: "unreadable" }
  try {
    return { kind: "report", report: { ...report, mtimeMs: statSync(path).mtimeMs } }
  } catch {
    return { kind: "unreadable" }
  }
}

/** Whether `sessionID`'s report on disk is newer than `at`; only a readable report of that session counts. */
function supersededOnDisk(file: string, sessionID: string, at: number): boolean {
  const stored = readStored(file)
  return stored.kind === "report" && stored.report.sessionID === sessionID && stored.report.at > at
}

/**
 * Record `report` as its session's one report: a temp file and a rename. Returns `"superseded"` and
 * writes nothing when the session's report on disk is newer. Throws when it cannot write. Not atomic
 * with the compare: the caller holds the store's lease.
 */
export function writeReport(receiptsRoot: string, report: RunningReport): "written" | "superseded" {
  const file = reportFile(receiptsRoot, report.sessionID)
  if (supersededOnDisk(file, report.sessionID, report.at)) return "superseded"
  const text = JSON.stringify(report)
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES) throw new Error(`the report of ${report.sessionID} is larger than ${MAX_REPORT_BYTES} bytes`)
  mkdirSync(runningDirectory(receiptsRoot), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, file)
  return "written"
}

/** Delete `sessionID`'s report unless the session's report on disk is newer than `at`. Throws when it cannot. */
export function clearReport(receiptsRoot: string, sessionID: string, at: number): "cleared" | "superseded" {
  const file = reportFile(receiptsRoot, sessionID)
  if (supersededOnDisk(file, sessionID, at)) return "superseded"
  rmSync(file, { force: true })
  return "cleared"
}

/** Delete `sessionID`'s report whatever its age: the session itself is gone. Throws when it cannot. */
export function removeReport(receiptsRoot: string, sessionID: string): void {
  rmSync(reportFile(receiptsRoot, sessionID), { force: true })
}

/** Every session's report. `unreadable` when the directory (other than absent) or any entry could not be read safely. */
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
export const reportVersion = (report: RunningReport): string => `${report.at}:${report.instance}:${JSON.stringify(report.jobs)}`

/**
 * What decides whether a report still counts: the reader's clock (against the file's mtime), who the
 * reader is (host and server instance) and whether a process is alive.
 */
export type ReportClock = { now: number; host: string; instance: string; alive: (pid: number) => boolean; expiryMs?: number }

/**
 * A report counts until its file is older than the expiry on the reader's clock. One from another host
 * counts until then, whatever its pid says. One from this host's other server counts while its pid is
 * alive; from this server, always (its session lookups below can say more). Pure.
 */
export function reportLive(report: StoredReport, clock: ReportClock): boolean {
  if (clock.now - report.mtimeMs >= (clock.expiryMs ?? HOLD_EXPIRY_MS)) return false
  if (report.instance === clock.instance) return true
  if (report.host === clock.host) return clock.alive(report.pid)
  return true
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
