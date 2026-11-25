/**
 * What each session last said is running, one raw report per session.
 *
 * The idle hook hands delivery the session's `background` list. Delivery keeps it as it came, in one
 * file per session under `<receipts root>/.running/`, and decides nothing at write time: whether a
 * report touches a worktree is judged when a removal asks (`reportBlock`), with the worktree in hand.
 * So a report needs no repository, no clone listing and no session lookup to be recorded, and one
 * synchronous write is all the idle hook does before it awaits anything.
 *
 * Only the session that wrote a report clears it (an empty list deletes the file), or its deletion.
 * A write never replaces a file whose `at` is newer, so a report that is delayed on its way to disk
 * cannot undo a later one, in this process or another.
 *
 * Pure functions over the directory, tested directly in `running-reports.test.ts`.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HOLD_EXPIRY_MS } from "@srobroek/opencode-lib/worktree-locks"

/** One entry of the idle hook's `background` list. */
export type ReportJob = { kind: string; sessionID?: string; childSessionID?: string; shellID?: string; command?: string }

/** A session's last report: its jobs, when it was written, and by which process. */
export type RunningReport = { sessionID: string; jobs: ReportJob[]; at: number; pid: number; host: string }

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
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || typeof raw.pid !== "number" || typeof raw.host !== "string") return undefined
  if (!Array.isArray(raw.jobs)) return undefined
  const jobs: ReportJob[] = []
  for (const job of raw.jobs) {
    if (!isObject(job) || typeof job.kind !== "string") return undefined
    const sessionID = optionalString(job.sessionID)
    const childSessionID = optionalString(job.childSessionID)
    const shellID = optionalString(job.shellID)
    const command = optionalString(job.command)
    jobs.push({
      kind: job.kind,
      ...(sessionID === undefined ? {} : { sessionID }),
      ...(childSessionID === undefined ? {} : { childSessionID }),
      ...(shellID === undefined ? {} : { shellID }),
      ...(command === undefined ? {} : { command }),
    })
  }
  return { sessionID: raw.sessionID, jobs, at: raw.at, pid: raw.pid, host: raw.host }
}

/** `at` of the report on disk for `sessionID`: a number, `undefined` when there is none or it is unreadable. */
function storedAt(file: string): number | undefined {
  try {
    return parseReport(readFileSync(file, "utf8"))?.at
  } catch {
    return undefined
  }
}

/**
 * Record `report` as its session's one report: synchronous, a temp file and a rename. Returns
 * `"superseded"` and writes nothing when the file on disk is newer. Throws when it cannot write.
 */
export function writeReport(receiptsRoot: string, report: RunningReport): "written" | "superseded" {
  const file = reportFile(receiptsRoot, report.sessionID)
  const stored = storedAt(file)
  if (stored !== undefined && stored > report.at) return "superseded"
  mkdirSync(runningDirectory(receiptsRoot), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(report))
  renameSync(temp, file)
  return "written"
}

/** Delete `sessionID`'s report unless the file on disk is newer than `at`. Throws when it cannot. */
export function clearReport(receiptsRoot: string, sessionID: string, at: number): "cleared" | "superseded" {
  const file = reportFile(receiptsRoot, sessionID)
  const stored = storedAt(file)
  if (stored !== undefined && stored > at) return "superseded"
  rmSync(file, { force: true })
  return "cleared"
}

/** Delete `sessionID`'s report whatever its age: the session itself is gone. Throws when it cannot. */
export function removeReport(receiptsRoot: string, sessionID: string): void {
  rmSync(reportFile(receiptsRoot, sessionID), { force: true })
}

/** Every session's report. `unreadable` when the directory (other than absent) or any entry could not be read. */
export function readReports(receiptsRoot: string): { reports: RunningReport[]; unreadable: boolean } {
  const directory = runningDirectory(receiptsRoot)
  let names: string[]
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"))
  } catch (error) {
    return { reports: [], unreadable: (error as NodeJS.ErrnoException).code !== "ENOENT" }
  }
  const reports: RunningReport[] = []
  let unreadable = false
  for (const name of names) {
    try {
      const report = parseReport(readFileSync(join(directory, name), "utf8"))
      if (report === undefined) unreadable = true
      else reports.push(report)
    } catch {
      unreadable = true
    }
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

/** What decides whether a report still counts: the clock, who is asking, and whether a process is alive. */
export type ReportClock = { now: number; host: string; alive: (pid: number) => boolean; expiryMs?: number }

/** A report counts unless it expired, or its reporter ran on this host and that process is gone. Pure. */
export function reportLive(report: RunningReport, clock: ReportClock): boolean {
  if (clock.now - report.at >= (clock.expiryMs ?? HOLD_EXPIRY_MS)) return false
  return !(report.host === clock.host && !clock.alive(report.pid))
}

const namesWorktree = (command: string | undefined, forms: readonly string[]): boolean =>
  command !== undefined && forms.some((form) => command.includes(form))

/** The sessions a job names. */
const jobSessions = (job: ReportJob): string[] =>
  [job.sessionID, job.childSessionID].filter((id): id is string => typeof id === "string")

/**
 * The session ids whose location a removal has to look up before {@link reportBlock} can decide: each
 * live report's own session, and the sessions of its jobs that no command already ties to the worktree. Pure.
 */
export function neededLookups(reports: readonly RunningReport[], forms: readonly string[], clock: ReportClock): string[] {
  const ids = new Set<string>()
  for (const report of reports) {
    if (!reportLive(report, clock) || report.jobs.length === 0) continue
    ids.add(report.sessionID)
    for (const job of report.jobs) {
      if (namesWorktree(job.command, forms)) continue
      for (const id of jobSessions(job)) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * Why a live report keeps the worktree whose path is `forms` (the raw and the canonical path), or
 * undefined. A job holds when its command names the worktree, or when a session it names is there, or
 * cannot be located (the lookup failed or timed out), or is not in `lookup` at all (a report that came
 * in after the lookups). A session the host does not have is skipped, and a report whose own session
 * the host does not have is skipped whole: nothing of it can still run. `canonical` maps a location to
 * its canonical path. Pure.
 */
export function reportBlock(
  reports: readonly RunningReport[],
  forms: readonly string[],
  lookup: (sessionID: string) => JobLookup | undefined,
  clock: ReportClock,
  canonical: (path: string) => string,
): string | undefined {
  for (const report of reports) {
    if (!reportLive(report, clock) || report.jobs.length === 0) continue
    if (lookup(report.sessionID)?.state === "missing") continue
    for (const job of report.jobs) {
      if (namesWorktree(job.command, forms)) return `session ${report.sessionID} has a ${job.kind} running that names the worktree`
      for (const id of jobSessions(job)) {
        const found = lookup(id)
        if (found === undefined) return `session ${report.sessionID} reported work in session ${id}, which has not been looked up`
        if (found.state === "unknown") return `session ${report.sessionID} reported work in session ${id}, whose location could not be read`
        if (found.state === "at" && found.directory !== undefined && forms.includes(canonical(found.directory))) {
          return `session ${report.sessionID} has work in session ${id}, which runs in the worktree`
        }
      }
    }
  }
  return undefined
}
