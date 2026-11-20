/** The run directory under the git common dir: state.json, journal.jsonl, summary.md and the `latest` link. */

import { execFile } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { type JournalEntry, readJournal } from "./journal.ts"
import type { RunState } from "./state.ts"

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

  create(): void {
    mkdirSync(this.path, { recursive: true })
    if (!existsSync(this.journalPath)) writeFileSync(this.journalPath, "")
    const link = join(this.root, "latest")
    rmSync(link, { force: true })
    symlinkSync(this.runId, link)
  }

  readState(): RunState | undefined {
    try {
      return JSON.parse(readFileSync(this.statePath, "utf8")) as RunState
    } catch {
      return undefined
    }
  }

  /** Write through a temporary file so a crash never leaves half a state. */
  writeState(state: RunState): void {
    const temporary = `${this.statePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
    renameSync(temporary, this.statePath)
  }

  append(entry: JournalEntry): void {
    appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`)
  }

  journal(): JournalEntry[] {
    try {
      return readJournal(readFileSync(this.journalPath, "utf8"))
    } catch {
      return []
    }
  }

  writeSummary(text: string): void {
    writeFileSync(this.summaryPath, text)
  }

  summary(): string | undefined {
    try {
      return readFileSync(this.summaryPath, "utf8")
    } catch {
      return undefined
    }
  }
}

/** The run named `runId`, or the `latest` one. */
export function findRun(root: string, runId?: string): RunDir | undefined {
  let id = runId
  if (id === undefined) {
    try {
      id = readlinkSync(join(root, "latest"))
    } catch {
      return undefined
    }
  }
  if (!/^[\w.-]+$/.test(id)) return undefined
  const dir = new RunDir(root, id)
  return existsSync(dir.statePath) ? dir : undefined
}
