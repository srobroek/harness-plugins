import { afterEach, expect, test } from "bun:test"
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunDir, RunFileError } from "./rundir.ts"
import { newRunState, type RunState } from "./state.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runDir(id: string): RunDir {
  const root = mkdtempSync(join(tmpdir(), "autopilot-rundir-"))
  roots.push(root)
  const dir = new RunDir(root, id)
  dir.create()
  return dir
}

const fresh = (id: string): RunState => newRunState({ runId: id, sessionID: "s", directory: "/repo", options: {}, scope: { kind: "queue" }, now: 0 })

/** Settles every pending promise step, without waiting on a timer. */
async function settle(steps = 200): Promise<void> {
  for (let step = 0; step < steps; step++) await Promise.resolve()
}

test("an entry appended after a torn last line still reads back", () => {
  const dir = runDir("r1")
  dir.append({ ts: "t", type: "progress", summary: "a" })
  appendFileSync(dir.journalPath, '{"ts":"t","ty')
  dir.append({ ts: "t", type: "progress", summary: "b" })
  expect(dir.journal().map((entry) => entry.summary)).toEqual(["a", "b"])
})

test("a writer holding an older read of state.json is refused", async () => {
  const dir = runDir("r3")
  const first = await dir.writeState(undefined, fresh("r3"))
  const stale = dir.readState() as RunState
  await dir.writeState(first, { ...first, phase: "stopped" })
  await expect(dir.writeState(stale, { ...stale, phase: "running" })).rejects.toThrow(RunFileError)
  expect(dir.readState()?.phase).toBe("stopped")
})

test("a writer paused between its check and its rename holds off a successor, which is then refused", async () => {
  const dir = runDir("r4")
  const first = await dir.writeState(undefined, fresh("r4"))
  let resume: () => void = () => {}
  const paused = new Promise<void>((resolve) => {
    resume = resolve
  })
  let reached: () => void = () => {}
  const atRename = new Promise<void>((resolve) => {
    reached = resolve
  })
  const slow = dir.writeState(first, { ...first, ticks: 1 }, {
    beforeRename: async () => {
      reached()
      await paused
    },
  })
  await atRename
  const successor = dir.writeState(first, { ...first, phase: "stopped" }).then(
    () => "written",
    (error: unknown) => (error instanceof RunFileError ? error.kind : "other"),
  )
  await settle()
  expect(dir.readState()?.ticks).toBe(0)
  resume()
  await slow
  expect(await successor).toBe("stale")
  expect(dir.readState()).toMatchObject({ ticks: 1, phase: "setup" })
})

/** A write paused before its rename, and how to let it go on. */
function pausedWrite(dir: RunDir, read: RunState, next: RunState) {
  let resume: () => void = () => {}
  const paused = new Promise<void>((resolve) => {
    resume = resolve
  })
  let reached: () => void = () => {}
  const atRename = new Promise<void>((resolve) => {
    reached = resolve
  })
  const done = dir.writeState(read, next, {
    beforeRename: async () => {
      reached()
      await paused
    },
  })
  return { atRename, resume, done }
}

test("a stalled writer that resumes after the takeover age keeps its lock, and its successor is refused", async () => {
  const dir = runDir("r7")
  const first = await dir.writeState(undefined, fresh("r7"))
  const slow = pausedWrite(dir, first, { ...first, ticks: 1 })
  await slow.atRename
  // The hold looks ancient, but the writer that took it is alive.
  const record = JSON.parse(readFileSync(dir.writeLockPath, "utf8")) as Record<string, unknown>
  writeFileSync(dir.writeLockPath, JSON.stringify({ ...record, taken: 0 }))
  let successorRenaming = false
  const successor = dir
    .writeState(first, { ...first, ticks: 2 }, {
      beforeRename: async () => {
        successorRenaming = true
      },
    })
    .then(
      () => "written",
      (error: unknown) => (error instanceof RunFileError ? error.kind : "other"),
    )
  await settle()
  expect(successorRenaming).toBe(false)
  slow.resume()
  await slow.done
  expect(await successor).toBe("stale")
  expect(dir.readState()?.ticks).toBe(1)
  expect(existsSync(dir.writeLockPath)).toBe(false)
})

test("a writer releases only a write lock it still owns", async () => {
  const dir = runDir("r8")
  const first = await dir.writeState(undefined, fresh("r8"))
  const slow = pausedWrite(dir, first, { ...first, ticks: 1 })
  await slow.atRename
  const record = JSON.parse(readFileSync(dir.writeLockPath, "utf8")) as Record<string, unknown>
  const successor = JSON.stringify({ ...record, token: "successor" })
  writeFileSync(dir.writeLockPath, successor)
  slow.resume()
  await slow.done.catch(() => undefined)
  expect(readFileSync(dir.writeLockPath, "utf8")).toBe(successor)
})

test("a writer whose run lease another owner took over is refused at the rename", async () => {
  const dir = runDir("r5")
  const first = await dir.writeState(undefined, fresh("r5"))
  writeFileSync(dir.lockPath, JSON.stringify({ host: "h", pid: 1, owner: "successor", token: "t", taken: 0, expires: 0 }))
  await expect(dir.writeState(first, { ...first, ticks: 1 }, { leaseOwner: "me" })).rejects.toThrow(/lease/)
  expect(dir.readState()?.ticks).toBe(0)
})

test("append reports a journal it cannot read instead of guessing", () => {
  const dir = runDir("r2")
  dir.append({ ts: "t", type: "progress", summary: "a" })
  chmodSync(dir.journalPath, 0o200)
  try {
    expect(() => dir.append({ ts: "t", type: "progress", summary: "b" })).toThrow(/EACCES/)
  } finally {
    chmodSync(dir.journalPath, 0o600)
  }
})

test("a run file error keeps the error it wraps as its cause", async () => {
  const dir = runDir("r6")
  await dir.writeState(undefined, fresh("r6"))
  chmodSync(dir.statePath, 0o200)
  try {
    let caught: unknown
    try {
      dir.readState()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RunFileError)
    expect(((caught as Error).cause as NodeJS.ErrnoException).code).toBe("EACCES")
  } finally {
    chmodSync(dir.statePath, 0o600)
  }
})
