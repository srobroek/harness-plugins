import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearReport,
  type JobLookup,
  neededLookups,
  parseReport,
  type ReportClock,
  type RunningReport,
  readReports,
  removeReport,
  reportBlock,
  reportFile,
  reportLive,
  reportsWritable,
  runningDirectory,
  writeReport,
} from "./running-reports.ts"

let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "running-reports-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const report = (sessionID: string, at: number, jobs: RunningReport["jobs"] = [{ kind: "shell", shellID: "sh1", command: "make" }]): RunningReport => ({
  sessionID,
  jobs,
  at,
  pid: 4242,
  host: "box",
})
const alive = () => true
const clock = (now = 1_000, overrides: Partial<ReportClock> = {}): ReportClock => ({ now, host: "box", alive, ...overrides })
const identity = (path: string) => path

describe("writing and clearing", () => {
  test("a written report reads back as it was given, whole", () => {
    const written = report("ses_a", 10, [{ kind: "subagent", sessionID: "ses_x", childSessionID: "ses_y", shellID: "sh1", command: "tail -f /w/log" }])
    expect(writeReport(root, written)).toBe("written")
    expect(readReports(root)).toEqual({ reports: [written], unreadable: false })
  })

  test("a write does not replace a report on disk that has a newer `at`, and replaces one that is as new or older", () => {
    writeReport(root, report("ses_a", 20, [{ kind: "shell", command: "newer" }]))
    expect(writeReport(root, report("ses_a", 10, [{ kind: "shell", command: "older" }]))).toBe("superseded")
    expect(readReports(root).reports[0]?.jobs[0]?.command).toBe("newer")
    expect(writeReport(root, report("ses_a", 20, [{ kind: "shell", command: "same" }]))).toBe("written")
    expect(readReports(root).reports[0]?.jobs[0]?.command).toBe("same")
  })

  test("a clear deletes the session's report unless the file on disk is newer", () => {
    writeReport(root, report("ses_a", 20))
    writeReport(root, report("ses_b", 20))
    expect(clearReport(root, "ses_a", 10)).toBe("superseded")
    expect(readReports(root).reports.map((r) => r.sessionID).sort()).toEqual(["ses_a", "ses_b"])
    expect(clearReport(root, "ses_a", 20)).toBe("cleared")
    expect(readReports(root).reports.map((r) => r.sessionID)).toEqual(["ses_b"])
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

  test.each([
    ["no session id", { jobs: [], at: 1, pid: 1, host: "h" }],
    ["a job without a kind", { sessionID: "s", jobs: [{}], at: 1, pid: 1, host: "h" }],
    ["a non-numeric time", { sessionID: "s", jobs: [], at: "now", pid: 1, host: "h" }],
  ])("a report with %s does not parse", (_name, raw) => {
    expect(parseReport(JSON.stringify(raw))).toBeUndefined()
  })

  test("the store is writable when its directory can be created, and not when a file stands in its place", () => {
    expect(reportsWritable(root)).toBe(true)
    rmSync(runningDirectory(root), { recursive: true, force: true })
    writeFileSync(runningDirectory(root), "")
    expect(reportsWritable(root)).toBe(false)
  })

  test("a report's file name is derived from its session id alone", () => {
    expect(reportFile(root, "ses_a")).toBe(reportFile(root, "ses_a"))
    expect(reportFile(root, "ses_a")).not.toBe(reportFile(root, "ses_b"))
    mkdirSync(runningDirectory(root), { recursive: true })
  })
})

describe("which reports count", () => {
  test.each([
    ["fresh, reporter alive", 1_000, "box", true, true],
    ["expired", 1_000 + 24 * 3_600_000, "box", true, false],
    ["reporter on this host is gone", 1_000, "box", false, false],
    ["reporter on another host is not judged by this host's processes", 1_000, "elsewhere", false, true],
  ])("%s", (_name, now, host, processAlive, counts) => {
    expect(reportLive({ ...report("ses_a", 0), host }, clock(now, { alive: () => processAlive }))).toBe(counts)
  })
})

describe("what a removal needs, and what a report blocks", () => {
  const forms = ["/w/linked", "/real/w/linked"]
  const at = (directory: string | undefined): JobLookup => ({ state: "at", directory })
  const lookups = (entries: Record<string, JobLookup>) => (id: string) => entries[id]

  test("a shell whose command names the worktree, by either form, blocks without any lookup", () => {
    for (const command of ["cd /w/linked && make", "tail -f /real/w/linked/log"]) {
      const reports = [report("ses_a", 1, [{ kind: "shell", command }])]
      expect(neededLookups(reports, forms, clock())).toEqual(["ses_a"])
      expect(reportBlock(reports, forms, () => undefined, clock(), identity)).toContain("names the worktree")
    }
  })

  test("a job's sessions and the reporter are what a removal looks up", () => {
    const reports = [report("ses_a", 1, [{ kind: "subagent", sessionID: "ses_x", childSessionID: "ses_y" }]), report("ses_dead", 1)]
    expect(neededLookups(reports, forms, clock(1_000, { alive: () => true })).sort()).toEqual(["ses_a", "ses_dead", "ses_x", "ses_y"])
    const gone = neededLookups(reports, forms, clock(1_000, { alive: (pid) => pid !== 4242 }))
    expect(gone).toEqual([])
  })

  test("a job whose session works in the worktree blocks, whichever of its two ids names it", () => {
    const reports = [report("ses_a", 1, [{ kind: "subagent", sessionID: "ses_x", childSessionID: "ses_y" }])]
    const found = lookups({ ses_a: at("/elsewhere"), ses_x: at("/elsewhere"), ses_y: at("/real/w/linked") })
    expect(reportBlock(reports, forms, found, clock(), identity)).toContain("runs in the worktree")
  })

  test("a job whose sessions work elsewhere, or nowhere known, blocks nothing", () => {
    const reports = [report("ses_a", 1, [{ kind: "subagent", sessionID: "ses_x" }, { kind: "subagent", sessionID: "ses_n" }])]
    const found = lookups({ ses_a: at("/e"), ses_x: at("/elsewhere"), ses_n: at(undefined) })
    expect(reportBlock(reports, forms, found, clock(), identity)).toBeUndefined()
  })

  test.each([
    ["a lookup that failed", { state: "unknown" } as JobLookup],
    ["a session that was not looked up", undefined],
  ])("%s blocks", (_name, outcome) => {
    const reports = [report("ses_a", 1, [{ kind: "subagent", sessionID: "ses_x" }])]
    const found = (id: string) => (id === "ses_x" ? outcome : at("/e"))
    expect(reportBlock(reports, forms, found, clock(), identity)).toBeDefined()
  })

  test("a session the host does not have is skipped, and so is a report whose own session it does not have", () => {
    const skipped = [report("ses_a", 1, [{ kind: "subagent", sessionID: "ses_gone" }])]
    expect(reportBlock(skipped, forms, lookups({ ses_a: at("/e"), ses_gone: { state: "missing" } }), clock(), identity)).toBeUndefined()
    const orphan = [report("ses_orphan", 1, [{ kind: "shell", command: "cd /w/linked && make" }])]
    expect(reportBlock(orphan, forms, lookups({ ses_orphan: { state: "missing" } }), clock(), identity)).toBeUndefined()
  })

  test("an expired report, or one whose reporter process is gone, blocks nothing", () => {
    const stale = [report("ses_a", 0, [{ kind: "shell", command: "cd /w/linked && make" }])]
    expect(reportBlock(stale, forms, () => undefined, clock(24 * 3_600_000), identity)).toBeUndefined()
    expect(reportBlock(stale, forms, () => undefined, clock(1_000, { alive: () => false }), identity)).toBeUndefined()
  })

  test("a location is compared by its canonical path", () => {
    const reports = [report("ses_a", 1, [{ kind: "subagent", sessionID: "ses_x" }])]
    const found = lookups({ ses_a: at("/e"), ses_x: at("/link/to/w") })
    const canonical = (path: string) => (path === "/link/to/w" ? "/real/w/linked" : path)
    expect(reportBlock(reports, forms, found, clock(), canonical)).toContain("runs in the worktree")
  })
})
