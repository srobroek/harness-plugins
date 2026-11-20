/** The run directory under the git common dir: state.json, journal.jsonl, summary.md and the `latest` link. */

import { execFile } from "node:child_process"
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { JournalCorrupt, type JournalEntry, readJournal } from "./journal.ts"
import type { RunState } from "./state.ts"
import { decodeRunState } from "./state-schema.ts"

export type Run = (cwd: string, command: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>

export const runCommand: Run = (cwd, command, args, timeoutMs = 20_000) =>
  new Promise((done) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) =>
      done({ ok: error === null, stdout: String(stdout), stderr: String(stderr) }),
    )
  })

/** `<git common dir>/opencode-scratch/autopilot`, or `undefined` outside a git repository. */
export async function autopilotRoot(directory: string, run: Run = runCommand): Promise<string | undefined> {
  const result = await run(directory, "git", ["rev-parse", "--git-common-dir"])
  if (!result.ok) return undefined
  const common = result.stdout.trim()
  return join(isAbsolute(common) ? common : resolve(directory, common), "opencode-scratch", "autopilot")
}

/**
 * A run file that exists but cannot be used: `io` when reading or writing it failed, `corrupt`
 * when its content is not what the plugin wrote, `stale` when another writer moved it on.
 */
export class RunFileError extends Error {
  constructor(
    readonly kind: "io" | "corrupt" | "stale",
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`)
  }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The file's text, `undefined` when it does not exist; any other failure throws. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if (missing(error)) return undefined
    throw new RunFileError("io", path, describe(error))
  }
}

export class RunDir {
  constructor(
    readonly root: string,
    readonly runId: string,
  ) {}

  get path(): string {
    return join(this.root, this.runId)
  }
  get statePath(): string {
    return join(this.path, "state.json")
  }
  get journalPath(): string {
    return join(this.path, "journal.jsonl")
  }
  get summaryPath(): string {
    return join(this.path, "summary.md")
  }
  /** The cross-process lock every state transition holds. */
  get lockPath(): string {
    return join(this.path, "run.lock")
  }

  create(): void {
    mkdirSync(this.path, { recursive: true })
    if (!existsSync(this.journalPath)) writeFileSync(this.journalPath, "")
    const link = join(this.root, "latest")
    rmSync(link, { force: true })
    symlinkSync(this.runId, link)
  }

  /** The run state; `undefined` only when `state.json` does not exist. */
  readState(): RunState | undefined {
    const text = readText(this.statePath)
    if (text === undefined) return undefined
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      throw new RunFileError("corrupt", this.statePath, `not JSON (${describe(error)})`)
    }
    const decoded = decodeRunState(value)
    if (!decoded.ok) throw new RunFileError("corrupt", this.statePath, `not a run state (${decoded.reason})`)
    return decoded.state
  }

  /**
   * Write `next` as the state after `read`. The write is refused when the file has moved past the
   * generation `read` came from, so a writer holding an old copy never overwrites a newer one.
   * Callers hold the run lock; the generation check is the fence for a lock that was lost.
   */
  writeState(read: Pick<RunState, "generation"> | undefined, next: RunState): RunState {
    const current = this.readState()
    const expected = read?.generation
    if (current !== undefined && current.generation !== expected)
      throw new RunFileError("stale", this.statePath, `generation ${current.generation} on disk, this writer read ${expected ?? "nothing"}`)
    const written: RunState = { ...next, generation: (current?.generation ?? -1) + 1 }
    const temporary = `${this.statePath}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(written, null, 2)}\n`)
      renameSync(temporary, this.statePath)
    } catch (error) {
      throw new RunFileError("io", this.statePath, describe(error))
    }
    return written
  }

  /** Append one line. A torn last line is an append that never completed: it is cut off first. */
  append(entry: JournalEntry): void {
    let fd: number
    try {
      fd = openSync(this.journalPath, "a+")
    } catch (error) {
      throw new RunFileError("io", this.journalPath, describe(error))
    }
    try {
      const size = statSync(this.journalPath).size
      if (size > 0) {
        const last = Buffer.alloc(1)
        readSync(fd, last, 0, 1, size - 1)
        if (last[0] !== 0x0a) ftruncateSync(fd, this.#lastLineEnd(fd, size))
      }
      writeSync(fd, `${JSON.stringify(entry)}\n`)
    } catch (error) {
      throw error instanceof RunFileError ? error : new RunFileError("io", this.journalPath, describe(error))
    } finally {
      closeSync(fd)
    }
  }

  /** The offset just after the last line ending in the first `size` bytes, or 0. */
  #lastLineEnd(fd: number, size: number): number {
    const buffer = Buffer.alloc(size)
    readSync(fd, buffer, 0, size, 0)
    return buffer.lastIndexOf(0x0a) + 1
  }

  /** The journal; empty only when `journal.jsonl` does not exist. */
  journal(): JournalEntry[] {
    const text = readText(this.journalPath)
    if (text === undefined) return []
    try {
      return readJournal(text)
    } catch (error) {
      if (error instanceof JournalCorrupt) throw new RunFileError("corrupt", this.journalPath, error.message)
      throw error
    }
  }

  writeSummary(text: string): void {
    try {
      writeFileSync(this.summaryPath, text)
    } catch (error) {
      throw new RunFileError("io", this.summaryPath, describe(error))
    }
  }

  /** The summary; `undefined` only when `summary.md` does not exist. */
  summary(): string | undefined {
    return readText(this.summaryPath)
  }
}

/** The run named `runId`, or the `latest` one. */
export function findRun(root: string, runId?: string): RunDir | undefined {
  let id = runId
  if (id === undefined) {
    try {
      id = readlinkSync(join(root, "latest"))
    } catch (error) {
      if (missing(error)) return undefined
      throw new RunFileError("io", join(root, "latest"), describe(error))
    }
  }
  if (!/^[\w.-]+$/.test(id)) return undefined
  const dir = new RunDir(root, id)
  return existsSync(dir.statePath) ? dir : undefined
}
