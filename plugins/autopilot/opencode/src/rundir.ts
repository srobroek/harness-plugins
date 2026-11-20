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
import { hostname } from "node:os"
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
 * when its content is not what the plugin wrote, `stale` when another writer moved it on or took
 * over the run lease. The underlying error, when there is one, is the `cause`.
 */
export class RunFileError extends Error {
  constructor(
    readonly kind: "io" | "corrupt" | "stale",
    readonly path: string,
    detail: string,
    cause?: unknown,
  ) {
    super(`${path}: ${detail}`, cause === undefined ? undefined : { cause })
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
    throw new RunFileError("io", path, describe(error), error)
  }
}

/** How long a writer waits for the per-write lock, and how old a hold must be before it is presumed dead. */
const WRITE_LOCK_WAIT_MS = 30_000
const WRITE_LOCK_STALE_MS = 10 * 60_000
const WRITE_LOCK_POLL_MS = 10

export type WriteOptions = {
  /** The run lease owner this writer holds; the write is refused once `run.lock` names another. */
  leaseOwner?: string
  /** Test seam: runs after the checks and before the rename, with the write lock held. */
  beforeRename?: () => Promise<void>
}

export class RunDir {
  /** The run lease owner of the transition using this directory; writes check `run.lock` still names it. */
  leaseOwner: string | undefined

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
  /** The short lock each `state.json` write holds from its checks to its rename. */
  get writeLockPath(): string {
    return `${this.statePath}.lock`
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
      throw new RunFileError("corrupt", this.statePath, `not JSON (${describe(error)})`, error)
    }
    const decoded = decodeRunState(value)
    if (!decoded.ok) throw new RunFileError("corrupt", this.statePath, `not a run state (${decoded.reason})`)
    return decoded.state
  }

  /**
   * Write `next` as the state after `read`, refused when the file moved past the generation
   * `read` came from or when the run lease now names another owner.
   *
   * Why this is safe against a writer that stalls and loses its lease: every write holds the
   * per-write lock (`state.json.lock`, created with `O_EXCL`) from its generation check to its
   * rename, so no other write can land in between; the generation it checked is still the one on
   * disk when it renames. The lease is checked again after the last `await` and before the
   * synchronous rename, so a writer that paused and lost the lease meanwhile refuses. A successor
   * that took the lease while this writer was renaming still needs the write lock to write, and
   * then finds the generation moved on and refuses too. A hold is taken over only when its
   * process is gone (same host) or it is older than ten minutes, far past the run lease, so a
   * live writer's hold is never stolen while its lease could still be valid.
   */
  async writeState(read: Pick<RunState, "generation"> | undefined, next: RunState, options: WriteOptions = {}): Promise<RunState> {
    const release = await this.#takeWriteLock()
    try {
      const current = this.readState()
      const expected = read?.generation
      if (current !== undefined && current.generation !== expected)
        throw new RunFileError("stale", this.statePath, `generation ${current.generation} on disk, this writer read ${expected ?? "nothing"}`)
      this.#checkLease(options.leaseOwner ?? this.leaseOwner)
      const written: RunState = { ...next, generation: (current?.generation ?? -1) + 1 }
      const temporary = `${this.statePath}.tmp`
      try {
        writeFileSync(temporary, `${JSON.stringify(written, null, 2)}\n`)
      } catch (error) {
        throw new RunFileError("io", this.statePath, describe(error), error)
      }
      await options.beforeRename?.()
      this.#checkLease(options.leaseOwner ?? this.leaseOwner)
      try {
        renameSync(temporary, this.statePath)
      } catch (error) {
        throw new RunFileError("io", this.statePath, describe(error), error)
      }
      return written
    } finally {
      release()
    }
  }

  /** Throws `stale` unless `run.lock` still names `owner`; no owner means no lease to check. */
  #checkLease(owner: string | undefined): void {
    if (owner === undefined) return
    let holder: unknown
    try {
      holder = (JSON.parse(readFileSync(this.lockPath, "utf8")) as { owner?: unknown }).owner
    } catch (error) {
      throw new RunFileError("stale", this.lockPath, `the run lease cannot be read (${describe(error)})`, error)
    }
    if (holder !== owner) throw new RunFileError("stale", this.lockPath, `the run lease now belongs to ${String(holder)}`)
  }

  async #takeWriteLock(): Promise<() => void> {
    const path = this.writeLockPath
    const deadline = Date.now() + WRITE_LOCK_WAIT_MS
    for (;;) {
      try {
        const fd = openSync(path, "wx")
        try {
          writeSync(fd, JSON.stringify({ host: hostname(), pid: process.pid, taken: Date.now() }))
        } finally {
          closeSync(fd)
        }
        return () => rmSync(path, { force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new RunFileError("io", path, describe(error), error)
      }
      if (this.#writeLockAbandoned(path)) {
        rmSync(path, { force: true })
        continue
      }
      if (Date.now() >= deadline) throw new RunFileError("io", path, `the state write lock stayed held for ${WRITE_LOCK_WAIT_MS / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, WRITE_LOCK_POLL_MS))
    }
  }

  #writeLockAbandoned(path: string): boolean {
    let holder: { host?: unknown; pid?: unknown; taken?: unknown }
    try {
      holder = JSON.parse(readFileSync(path, "utf8")) as typeof holder
    } catch {
      try {
        return Date.now() - statSync(path).mtimeMs > WRITE_LOCK_STALE_MS
      } catch {
        return false
      }
    }
    if (typeof holder.taken === "number" && Date.now() - holder.taken > WRITE_LOCK_STALE_MS) return true
    if (holder.host !== hostname() || typeof holder.pid !== "number") return false
    try {
      process.kill(holder.pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
    }
  }

  /** Append one line. A torn last line is an append that never completed: it is cut off first. */
  append(entry: JournalEntry): void {
    let fd: number
    try {
      fd = openSync(this.journalPath, "a+")
    } catch (error) {
      throw new RunFileError("io", this.journalPath, describe(error), error)
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
      throw error instanceof RunFileError ? error : new RunFileError("io", this.journalPath, describe(error), error)
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
      if (error instanceof JournalCorrupt) throw new RunFileError("corrupt", this.journalPath, error.message, error)
      throw error
    }
  }

  writeSummary(text: string): void {
    try {
      writeFileSync(this.summaryPath, text)
    } catch (error) {
      throw new RunFileError("io", this.summaryPath, describe(error), error)
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
      throw new RunFileError("io", join(root, "latest"), describe(error), error)
    }
  }
  if (!/^[\w.-]+$/.test(id)) return undefined
  const dir = new RunDir(root, id)
  return existsSync(dir.statePath) ? dir : undefined
}
