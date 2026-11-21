import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess"
import type { Exec, ExecRun } from "./exec.ts"

/** Shared fixtures for the scan tests: temp repos, canned analyzer runs and a recording fake exec. */

const dirs: string[] = []
export function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "challenge-scan-"))
  dirs.push(dir)
  return dir
}
export function cleanup(): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

export const exited = (stdout: string, exitCode = 0, stderr = ""): SupervisedRun => ({
  kind: "exited",
  exitCode,
  signalCode: null,
  stdout,
  stderr,
})

export const RUFF_HIT = JSON.stringify([
  { code: "PERF401", filename: "a.py", location: { row: 5 }, message: "use a list comprehension" },
  { code: "T201", filename: "a.py", location: { row: 9 }, message: "print found" },
])

export function pythonRepo(): string {
  const root = temp()
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname='x'\n")
  writeFileSync(join(root, "a.py"), "print(1)\n")
  return root
}

/** A fake exec answering by a fragment of the tool's argv; records every call. */
export function fakeExec(answers: Record<string, ExecRun>, calls: Array<{ argv: string[]; options: Parameters<Exec>[1] }> = []): Exec {
  return async (argv, options) => {
    calls.push({ argv, options })
    const key = Object.keys(answers).find((k) => argv.join(" ").includes(k))
    return key ? (answers[key] as ExecRun) : exited("", 0)
  }
}

export const withTools =
  (...names: string[]) =>
  (binary: string) =>
    names.includes(binary) ? `/bin/${binary}` : null
