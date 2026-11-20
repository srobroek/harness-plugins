import { afterEach, expect, test } from "bun:test"
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
