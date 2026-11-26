import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearReport,
  type JobLookup,
  legacyReportFile,
  MAX_REPORT_BYTES,
  neededLookups,
  parseReport,
  type ReportClock,
  type ReportJob,
  type RunningReport,
  readReports,
  removeLegacyReport,
  removeReport,
  removeReportsWhere,
  reportBlock,
  reportFile,
  reportLive,
  reportsWritable,
  reportVersion,
  runningDirectory,
  type StoredReport,
  writeReport,
} from "./running-reports.ts"
import { readReports as v1ReadReports, reportBlock as v1ReportBlock } from "./testdata/running-reports-v1.ts"

let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "running-reports-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const report = (sessionID: string, at: number, jobs: ReportJob[] = [{ kind: "shell", shellID: "sh1", command: "make" }]): RunningReport => ({
  sessionID,
  jobs,
  at,
  gen: 0,
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

const INSTANCE_A = "box:4242:a"
const INSTANCE_B = "box:99:b"
const by = (instance: string, sessionID: string, at: number, jobs?: ReportJob[], gen = 0): RunningReport => ({ ...report(sessionID, at, jobs), instance, gen })
const files = () => readdirSync(runningDirectory(root)).filter((name) => name.endsWith(".json")).sort()

describe("writing and clearing: one file per session and instance", () => {
  test("a written report reads back as it was given, whole, with the file's mtime", () => {
    const written = { ...report("ses_a", 10, [{ kind: "subagent", sessionID: "ses_x", childSessionID: "ses_y", shellID: "sh1", command: "tail -f /w/log", cwd: "/w" }]), gen: 7 }
    writeReport(root, written)
    const read = readReports(root)
    expect(read.unreadable).toBe(false)
    expect(read.reports).toHaveLength(1)
    expect(read.reports[0]).toMatchObject(written)
    expect(Math.abs((read.reports[0]?.mtimeMs ?? 0) - Date.now())).toBeLessThan(60_000)
  })

  test("two instances' reports for one session are two files, and each rewrites only its own", () => {
    writeReport(root, by(INSTANCE_A, "ses_a", 10, [{ kind: "shell", command: "from a" }]))
    writeReport(root, by(INSTANCE_B, "ses_a", 5, [{ kind: "shell", command: "from b" }]))
    expect(files()).toHaveLength(2)
    writeReport(root, by(INSTANCE_A, "ses_a", 11, [{ kind: "shell", command: "from a again" }]))
    const commands = readReports(root).reports.map((r) => r.jobs[0]?.command).sort()
    expect(commands).toEqual(["from a again", "from b"])
  })

  test("a clear removes the instance's own file and no other: B's report survives A's clear, whatever the clocks say", () => {
    // B reports later than A's clear by sequence, but with an equal or earlier clock reading.
    for (const bAt of [20, 15, 3]) {
      writeReport(root, by(INSTANCE_A, "ses_a", 20, [{ kind: "shell", command: "cd /w/linked && make" }]))
      clearReport(root, "ses_a", INSTANCE_A)
      writeReport(root, by(INSTANCE_B, "ses_a", bAt, [{ kind: "shell", command: "cd /w/linked && make" }]))
      const read = readReports(root)
      expect(read.reports.map((r) => r.instance)).toEqual([INSTANCE_B])
      expect(reportBlock(read.reports, ["/w/linked"], () => undefined, clock(), identity)).toContain("names the worktree")
      clearReport(root, "ses_a", INSTANCE_B)
      expect(files()).toEqual([])
    }
  })

  test("a clear leaves no file behind, and clearing what is not there is not an error", () => {
    writeReport(root, report("ses_a", 1))
    clearReport(root, "ses_a", INSTANCE_A)
    clearReport(root, "ses_a", INSTANCE_A)
    expect(files()).toEqual([])
  })

  test("one session's clear touches no other session's report", () => {
    writeReport(root, report("ses_a", 1))
    writeReport(root, report("ses_b", 1))
    clearReport(root, "ses_a", INSTANCE_A)
    expect(readReports(root).reports.map((r) => r.sessionID)).toEqual(["ses_b"])
  })

  test("a removal that names the generation of a deleted incarnation keeps a newer incarnation's report", () => {
    writeReport(root, by(INSTANCE_A, "ses_a", 1, undefined, 5))
    expect(removeReport(root, "ses_a", INSTANCE_A, 4)).toBe("kept") // the report on disk is generation 5
    expect(files()).toHaveLength(1)
    expect(removeReport(root, "ses_a", INSTANCE_A, 5)).toBe("removed")
    expect(files()).toEqual([])
    expect(removeReport(root, "ses_a", INSTANCE_A, 5)).toBe("removed") // already gone
  })

  test("a legacy un-suffixed file is removed only when its pid and instance are ours; any other stays", () => {
    mkdirSync(runningDirectory(root), { recursive: true })
    const legacy = legacyReportFile(root, "ses_a")
    const text = JSON.stringify({ sessionID: "ses_a", jobs: [], at: 1, pid: 4242, host: "box", instance: INSTANCE_A })
    writeFileSync(legacy, text)
    expect(removeLegacyReport(root, "ses_a", INSTANCE_B, 4242)).toBe(false)
    expect(removeLegacyReport(root, "ses_a", INSTANCE_A, 1)).toBe(false)
    expect(files()).toHaveLength(1)
    expect(removeLegacyReport(root, "ses_a", INSTANCE_A, 4242)).toBe(true)
    expect(files()).toEqual([])
  })

  test("a legacy file is read like any other report, with generation 0", () => {
    mkdirSync(runningDirectory(root), { recursive: true })
    writeFileSync(legacyReportFile(root, "ses_a"), JSON.stringify({ sessionID: "ses_a", jobs: [{ kind: "shell", command: "cd /w/linked && make" }], at: 1, pid: 4242, host: "box", instance: "box:99:old" }))
    writeReport(root, by(INSTANCE_A, "ses_a", 2, []))
    const read = readReports(root)
    expect(read.unreadable).toBe(false)
    expect(read.reports.map((r) => [r.instance, r.gen]).sort()).toEqual([[INSTANCE_A, 0], ["box:99:old", 0]])
  })

  // The reader older installs still run (frozen from 3e4afbbe) against what the current writer produces.
  test("the frozen round-1 reader reads every per-instance file and treats both reports as holding", () => {
    const job: ReportJob[] = [{ kind: "shell", command: "cd /w/linked && make" }]
    writeReport(root, by(INSTANCE_A, "ses_a", 1, job, 3))
    writeReport(root, by(INSTANCE_B, "ses_a", 1, job, 1))
    writeReport(root, by(INSTANCE_B, "ses_other", 1, [{ kind: "shell", command: "sleep 9" }]))
    const read = v1ReadReports(root)
    expect(read.unreadable).toBe(false)
    expect(read.reports.map((r) => `${r.sessionID}/${r.instance}`).sort()).toEqual([`ses_a/${INSTANCE_A}`, `ses_a/${INSTANCE_B}`, `ses_other/${INSTANCE_B}`])
    const holds = (reports: typeof read.reports) => v1ReportBlock(reports, ["/w/linked"], () => undefined, clock(), identity)
    expect(holds(read.reports)).toContain("names the worktree")
    // Each instance's report holds on its own: with only one of the two, the worktree is still held.
    for (const instance of [INSTANCE_A, INSTANCE_B]) expect(holds(read.reports.filter((r) => r.instance === instance && r.sessionID === "ses_a"))).toContain("names the worktree")
  })

  test("removeReportsWhere deletes the files whose report matches and leaves the others and unreadable files", () => {
    writeReport(root, by(INSTANCE_A, "ses_a", 1))
    writeReport(root, by(INSTANCE_B, "ses_a", 1))
    writeReport(root, by(INSTANCE_B, "ses_b", 1))
    writeFileSync(join(runningDirectory(root), "bad.json"), "{not json")
    expect(removeReportsWhere(root, (r) => r.instance === INSTANCE_B)).toBe(2)
    expect(readReports(root).reports.map((r) => r.instance)).toEqual([INSTANCE_A])
    expect(readdirSync(runningDirectory(root)).includes("bad.json")).toBe(true)
  })

  test("removeReportsWhere treats a missing store as empty but reports any other failure to list it", () => {
    expect(removeReportsWhere(root, () => true)).toBe(0) // no .running directory yet
    writeFileSync(runningDirectory(root), "not a directory")
    expect(() => removeReportsWhere(root, () => true)).toThrow()
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

  test("a FIFO at an instance's own report path does not stop a write or a clear: the report replaces it", () => {
    mkdirSync(runningDirectory(root), { recursive: true })
    execFileSync("mkfifo", [reportFile(root, "ses_a", INSTANCE_A)])
    writeReport(root, report("ses_a", 1))
    expect(readReports(root)).toMatchObject({ unreadable: false, reports: [{ sessionID: "ses_a" }] })
    rmSync(reportFile(root, "ses_a", INSTANCE_A))
    execFileSync("mkfifo", [reportFile(root, "ses_a", INSTANCE_A)])
    clearReport(root, "ses_a", INSTANCE_A)
    expect(files()).toEqual([])
  })

  test.each([
    ["no session id", { jobs: [], at: 1, pid: 1, host: "h", instance: "i" }],
    ["a job without a kind", { sessionID: "s", jobs: [{}], at: 1, pid: 1, host: "h", instance: "i" }],
    ["a non-numeric time", { sessionID: "s", jobs: [], at: "now", pid: 1, host: "h", instance: "i" }],
    ["no server instance", { sessionID: "s", jobs: [], at: 1, pid: 1, host: "h" }],
    ["a tombstone, which is no longer a shape", { sessionID: "s", cleared: true, at: 1, pid: 1, host: "h" }],
    ["a negative generation", { sessionID: "s", jobs: [], at: 1, pid: 1, host: "h", instance: "i", gen: -1 }],
    ["a fractional generation", { sessionID: "s", jobs: [], at: 1, pid: 1, host: "h", instance: "i", gen: 1.5 }],
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
    const file = reportFile(root, "ses_a", "far:1:c")
    const fresh = readReports(root).reports
    expect(reportBlock(fresh, forms, () => undefined, clock(Date.now()), identity)).toContain("names the worktree")
    utimesSync(file, new Date(0), new Date(0))
    const aged = readReports(root).reports
    expect(reportBlock(aged, forms, () => undefined, clock(Date.now()), identity)).toBeUndefined()
  })
})
