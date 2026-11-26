import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearReport,
  type JobLookup,
  MAX_REPORT_BYTES,
  neededLookups,
  parseReport,
  type ReportClock,
  type ReportJob,
  type RunningReport,
  readReports,
  removeReport,
  reportBlock,
  reportFile,
  reportLive,
  reportsWritable,
  reportVersion,
  runningDirectory,
  type StoredReport,
  writeReport,
} from "./running-reports.ts"

let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "running-reports-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const report = (sessionID: string, at: number, jobs: ReportJob[] = [{ kind: "shell", shellID: "sh1", command: "make" }]): RunningReport => ({
  sessionID,
  jobs,
  at,
  pid: 4242,
  host: "box",
  instance: "box:4242:a",
})
const stored = (sessionID: string, jobs: ReportJob[] = [{ kind: "shell", shellID: "sh1", command: "make" }], over: Partial<StoredReport> = {}): StoredReport => ({
  ...report(sessionID, 1, jobs),
  mtimeMs: 1_000,
  ...over,
})
const alive = () => true
const clock = (now = 1_500, over: Partial<ReportClock> = {}): ReportClock => ({ now, host: "box", instance: "box:4242:a", alive, ...over })
const identity = (path: string) => path

describe("writing and clearing", () => {
  test("a written report reads back as it was given, whole, with the file's mtime", () => {
    const written = report("ses_a", 10, [{ kind: "subagent", sessionID: "ses_x", childSessionID: "ses_y", shellID: "sh1", command: "tail -f /w/log", cwd: "/w" }])
    expect(writeReport(root, written)).toBe("written")
    const read = readReports(root)
    expect(read.unreadable).toBe(false)
    expect(read.reports).toHaveLength(1)
    expect(read.reports[0]).toMatchObject(written)
    expect(Math.abs((read.reports[0]?.mtimeMs ?? 0) - Date.now())).toBeLessThan(60_000)
  })

  test("a write does not replace the session's report on disk that has a newer `at`, and replaces one that is as new or older", () => {
    writeReport(root, report("ses_a", 20, [{ kind: "shell", command: "newer" }]))
    expect(writeReport(root, report("ses_a", 10, [{ kind: "shell", command: "older" }]))).toBe("superseded")
    expect(readReports(root).reports[0]?.jobs[0]?.command).toBe("newer")
    expect(writeReport(root, report("ses_a", 20, [{ kind: "shell", command: "same" }]))).toBe("written")
    expect(readReports(root).reports[0]?.jobs[0]?.command).toBe("same")
  })

  test("a clear deletes the session's report unless the report on disk is newer", () => {
    writeReport(root, report("ses_a", 20))
    writeReport(root, report("ses_b", 20))
    expect(clearReport(root, "ses_a", 10)).toBe("superseded")
    expect(readReports(root).reports.map((r) => r.sessionID).sort()).toEqual(["ses_a", "ses_b"])
    expect(clearReport(root, "ses_a", 20)).toBe("cleared")
    expect(readReports(root).reports.map((r) => r.sessionID)).toEqual(["ses_b"])
  })

  test("a file at the session's path that is not that session's report is replaced by a write, whatever its `at`", () => {
    mkdirSync(runningDirectory(root), { recursive: true })
    writeFileSync(reportFile(root, "ses_a"), JSON.stringify({ ...report("ses_other", 999) }))
    expect(writeReport(root, report("ses_a", 1))).toBe("written")
    expect(readReports(root).reports.map((r) => r.sessionID)).toEqual(["ses_a"])
  })

  test("one session's clear and removal touch no other session's report", () => {
    writeReport(root, report("ses_a", 1))
    writeReport(root, report("ses_b", 1))
    removeReport(root, "ses_a")
    expect(readReports(root).reports.map((r) => r.sessionID)).toEqual(["ses_b"])
    removeReport(root, "ses_a") // already gone: not an error
  })

  test("a write leaves no temporary file behind", () => {
    writeReport(root, report("ses_a", 1))
    expect(readdirSync(runningDirectory(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("a report larger than the bound is not written", () => {
    expect(() => writeReport(root, report("ses_a", 1, [{ kind: "shell", command: "x".repeat(MAX_REPORT_BYTES) }]))).toThrow("larger than")
  })
})

describe("reading", () => {
  test("no directory is no reports, and not an unreadable store", () => {
    expect(readReports(root)).toEqual({ reports: [], unreadable: false })
  })

  test("a report file that is not a report makes the store unreadable, whatever else is in it", () => {
    writeReport(root, report("ses_a", 1))
    writeFileSync(join(runningDirectory(root), "garbage.json"), "{not json")
    const read = readReports(root)
    expect(read.unreadable).toBe(true)
    expect(read.reports.map((r) => r.sessionID)).toEqual(["ses_a"])
  })

  test("a FIFO named like a report is unreadable at once, never waited on", () => {
    mkdirSync(runningDirectory(root), { recursive: true })
    execFileSync("mkfifo", [join(runningDirectory(root), "stuck.json")])
    expect(readReports(root).unreadable).toBe(true)
  })

  test("a FIFO at a session's own report path does not stop a write or a clear: the report replaces it", () => {
    mkdirSync(runningDirectory(root), { recursive: true })
    execFileSync("mkfifo", [reportFile(root, "ses_a")])
    expect(writeReport(root, report("ses_a", 1))).toBe("written")
    expect(readReports(root)).toMatchObject({ unreadable: false, reports: [{ sessionID: "ses_a" }] })
    rmSync(reportFile(root, "ses_a"))
    execFileSync("mkfifo", [reportFile(root, "ses_a")])
    expect(clearReport(root, "ses_a", 1)).toBe("cleared")
  })

  test.each([
    ["no session id", { jobs: [], at: 1, pid: 1, host: "h", instance: "i" }],
    ["a job without a kind", { sessionID: "s", jobs: [{}], at: 1, pid: 1, host: "h", instance: "i" }],
    ["a non-numeric time", { sessionID: "s", jobs: [], at: "now", pid: 1, host: "h", instance: "i" }],
    ["no server instance", { sessionID: "s", jobs: [], at: 1, pid: 1, host: "h" }],
    ["a pid that is not a positive integer", { sessionID: "s", jobs: [], at: 1, pid: 0, host: "h", instance: "i" }],
    ["a fractional pid", { sessionID: "s", jobs: [], at: 1, pid: 1.5, host: "h", instance: "i" }],
    ["an empty host", { sessionID: "s", jobs: [], at: 1, pid: 1, host: "", instance: "i" }],
    ["jobs that are not a list", { sessionID: "s", jobs: {}, at: 1, pid: 1, host: "h", instance: "i" }],
    ["a job whose command is not text", { sessionID: "s", jobs: [{ kind: "shell", command: 5 }], at: 1, pid: 1, host: "h", instance: "i" }],
    ["a job whose cwd is not text", { sessionID: "s", jobs: [{ kind: "shell", cwd: [] }], at: 1, pid: 1, host: "h", instance: "i" }],
    ["a job that is not an object", { sessionID: "s", jobs: ["shell"], at: 1, pid: 1, host: "h", instance: "i" }],
  ])("a report with %s does not parse", (_name, raw) => {
    expect(parseReport(JSON.stringify(raw))).toBeUndefined()
  })

  test("the store is writable when its directory can be created, and not when a file stands in its place", () => {
    expect(reportsWritable(root)).toBe(true)
    rmSync(runningDirectory(root), { recursive: true, force: true })
    writeFileSync(runningDirectory(root), "")
    expect(reportsWritable(root)).toBe(false)
  })

  test("a report's version changes when its time or its jobs do", () => {
    expect(reportVersion(report("ses_a", 1))).not.toBe(reportVersion(report("ses_a", 2)))
    expect(reportVersion(report("ses_a", 1))).not.toBe(reportVersion(report("ses_a", 1, [{ kind: "shell", command: "other" }])))
    expect(reportVersion(report("ses_a", 1))).toBe(reportVersion(report("ses_a", 1)))
  })
})

describe("which reports count", () => {
  const DAY = 24 * 3_600_000
  test.each([
    ["this server, fresh", { instance: "box:4242:a" }, 1_000 + 10, true, true],
    ["this server, file older than the expiry: its own process is alive, so it holds", { instance: "box:4242:a" }, 1_000 + DAY, true, true],
    ["this server's old `at` is not its age", { instance: "box:4242:a", at: 0 }, 1_000 + 10, true, true],
    ["another server on this host, file older than the expiry, its pid alive: pid decides, so it holds", { instance: "box:99:b" }, 1_000 + DAY, true, true],
    ["another server on this host, file older than the expiry, its pid gone", { instance: "box:99:b" }, 1_000 + DAY, false, false],
    ["another server on this host, its pid alive", { instance: "box:99:b" }, 1_000 + 10, true, true],
    ["another server on this host, its pid gone", { instance: "box:99:b" }, 1_000 + 10, false, false],
    ["another host, whatever its pid says", { instance: "far:1:c", host: "far" }, 1_000 + 10, false, true],
    ["another host, file older than the expiry", { instance: "far:1:c", host: "far" }, 1_000 + DAY, false, false],
  ] as const)("%s", (_name, over, now, processAlive, counts) => {
    expect(reportLive(stored("ses_a", undefined, over), clock(now, { alive: () => processAlive }))).toBe(counts)
  })
})

describe("what a removal needs, and what a report blocks", () => {
  const forms = ["/w/linked", "/real/w/linked"]
  const at = (directory: string | undefined): JobLookup => ({ state: "at", directory })
  const lookups = (entries: Record<string, JobLookup>) => (id: string) => entries[id]

  test("a shell whose command names the worktree, by either form, blocks without any lookup of its job", () => {
    for (const command of ["cd /w/linked && make", "tail -f /real/w/linked/log"]) {
      const reports = [stored("ses_a", [{ kind: "shell", sessionID: "ses_x", command }])]
      expect(neededLookups(reports, forms, clock())).toEqual(["ses_a"])
      expect(reportBlock(reports, forms, () => undefined, clock(), identity)).toContain("names the worktree")
    }
  })

  test("a job's sessions, and only this server's reporters, are what a removal looks up", () => {
    const reports = [
      stored("ses_a", [{ kind: "subagent", sessionID: "ses_x", childSessionID: "ses_y" }]),
      stored("ses_far", [{ kind: "shell", sessionID: "ses_z" }], { instance: "far:1:c", host: "far" }),
    ]
    expect(neededLookups(reports, forms, clock()).sort()).toEqual(["ses_a", "ses_x", "ses_y", "ses_z"])
    expect(neededLookups([stored("ses_gone")], forms, clock(1_500, { alive: () => false }))).toEqual(["ses_gone"])
    expect(neededLookups([stored("ses_gone", undefined, { instance: "box:99:b" })], forms, clock(1_500, { alive: () => false }))).toEqual([])
  })

  test("a job that records its cwd is judged by it alone: no lookup, and it holds only inside the worktree", () => {
    const inside = [stored("ses_a", [{ kind: "shell", sessionID: "ses_x", cwd: "/real/w/linked/sub" }])]
    const outside = [stored("ses_a", [{ kind: "shell", sessionID: "ses_x", cwd: "/elsewhere" }])]
    expect(neededLookups(inside, forms, clock())).toEqual(["ses_a"])
    expect(reportBlock(inside, forms, () => undefined, clock(), identity)).toContain("running in the worktree")
    expect(reportBlock(outside, forms, () => undefined, clock(), identity)).toBeUndefined()
  })

  test("a job with no recorded cwd runs where its owning session works, inside the worktree or below it", () => {
    const reports = [stored("ses_a", [{ kind: "subagent", sessionID: "ses_x", childSessionID: "ses_y" }])]
    const found = lookups({ ses_a: at("/e"), ses_x: at("/elsewhere"), ses_y: at("/real/w/linked/deep/er") })
    expect(reportBlock(reports, forms, found, clock(), identity)).toContain("runs in the worktree")
    const sibling = lookups({ ses_a: at("/e"), ses_x: at("/elsewhere"), ses_y: at("/real/w/linked-other") })
    expect(reportBlock(reports, forms, sibling, clock(), identity)).toBeUndefined()
  })

  test.each([
    ["a job with no recorded cwd and no owning session", [{ kind: "codemode" }], {} as Record<string, JobLookup>],
    ["a session the host gave no directory", [{ kind: "shell", sessionID: "ses_x" }], { ses_x: at(undefined) }],
    ["a lookup that failed", [{ kind: "shell", sessionID: "ses_x" }], { ses_x: { state: "unknown" } as JobLookup }],
    ["a session that was not looked up", [{ kind: "shell", sessionID: "ses_x" }], {}],
  ])("%s: the cwd cannot be established, so the job holds", (_name, jobs, answers) => {
    expect(reportBlock([stored("ses_a", jobs)], forms, lookups({ ses_a: at("/e"), ...answers }), clock(), identity)).toBeDefined()
  })

  test("a session this server does not have is skipped, and so is a report whose own session it does not have", () => {
    const skipped = [stored("ses_a", [{ kind: "subagent", sessionID: "ses_gone" }])]
    expect(reportBlock(skipped, forms, lookups({ ses_a: at("/e"), ses_gone: { state: "missing" } }), clock(), identity)).toBeUndefined()
    const orphan = [stored("ses_orphan", [{ kind: "shell", sessionID: "ses_orphan", command: "cd /w/linked && make" }])]
    expect(reportBlock(orphan, forms, lookups({ ses_orphan: { state: "missing" } }), clock(), identity)).toBeUndefined()
  })

  test("another server's report is never judged dead because this host does not have its sessions", () => {
    const far = (jobs: ReportJob[]) => [stored("ses_a", jobs, { instance: "box:99:b" })]
    // The reporter itself is not found here: that says nothing about a report of another server.
    const cmd = far([{ kind: "shell", sessionID: "ses_a", command: "cd /w/linked && make" }])
    expect(reportBlock(cmd, forms, lookups({ ses_a: { state: "missing" } }), clock(), identity)).toContain("names the worktree")
    // Nor is a job session it cannot place.
    const job = far([{ kind: "shell", sessionID: "ses_x" }])
    expect(reportBlock(job, forms, lookups({ ses_x: { state: "missing" } }), clock(), identity)).toContain("another server")
  })

  test("a report of another host that has expired on the reader's clock blocks nothing", () => {
    const old = [stored("ses_a", [{ kind: "shell", command: "cd /w/linked && make" }], { mtimeMs: 0, host: "far", instance: "far:1:c" })]
    expect(reportBlock(old, forms, () => undefined, clock(24 * 3_600_000), identity)).toBeUndefined()
  })

  test("a location is compared by its canonical path", () => {
    const reports = [stored("ses_a", [{ kind: "subagent", sessionID: "ses_x" }])]
    const found = lookups({ ses_a: at("/e"), ses_x: at("/link/to/w") })
    const canonical = (path: string) => (path === "/link/to/w" ? "/real/w/linked" : path)
    expect(reportBlock(reports, forms, found, clock(), canonical)).toContain("runs in the worktree")
  })

  test("a file's mtime is what expiry reads for another host: a fresh file with an old `at` counts, an old file does not", () => {
    writeReport(root, { ...report("ses_a", 0, [{ kind: "shell", command: "cd /w/linked && make" }]), host: "far", instance: "far:1:c" })
    const file = reportFile(root, "ses_a")
    const fresh = readReports(root).reports
    expect(reportBlock(fresh, forms, () => undefined, clock(Date.now()), identity)).toContain("names the worktree")
    utimesSync(file, new Date(0), new Date(0))
    const aged = readReports(root).reports
    expect(reportBlock(aged, forms, () => undefined, clock(Date.now()), identity)).toBeUndefined()
  })
})
