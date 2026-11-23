/**
 * Refuses writes to chezmoi-managed live targets, naming the source path to edit.
 * The target parser and guard policy are shared by the OpenCode and pi adapters.
 */

import { spawn as spawnProcess } from "node:child_process"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename } from "node:path"
import { under } from "@srobroek/opencode-lib/shell-write-targets"
import { shellCall, writtenPaths } from "@srobroek/opencode-lib/tool-targets"

export const SUBPROCESS_TIMEOUT_MS = 2000
/** `chezmoi add`/`forget` from another terminal change the managed set without any call the guard sees. */
export const MANAGED_TTL_MS = 5000

/** Source-name attribute prefixes that can precede a type prefix such as `create_`. */
const ATTRIBUTE_PREFIXES = new Set([
  "encrypted", "private", "readonly", "empty", "executable", "exact", "external",
  "create", "modify", "remove", "symlink", "run", "once", "onchange", "before", "after",
])

/** Whether a source file is seed-once: its attribute run includes `create_` in any order. */
function isSeedOnceSource(source: string): boolean {
  let name = basename(source)
  for (;;) {
    const cut = name.indexOf("_")
    if (cut <= 0 || !ATTRIBUTE_PREFIXES.has(name.slice(0, cut))) return false
    if (name.slice(0, cut) === "create") return true
    name = name.slice(cut + 1)
  }
}

/** `chezmoi` as a command word: its subcommands (`add`, `forget`, …) change the managed set. */
const CHEZMOI_RUN = /(?:^|[\s;&|(/])chezmoi(?:\s|$)/

/** Runs `chezmoi <args>`; resolves to stdout, or `null` when it fails, times out or is missing. */
export type Spawn = (args: string[], globalArgs?: string[]) => Promise<string | null>

export const spawnChezmoi: Spawn = (args, globalArgs = []) =>
  new Promise((resolve) => {
    let stdout = ""
    let settled = false
    const child = spawnProcess("chezmoi", [...globalArgs, ...args], { stdio: ["ignore", "pipe", "ignore"] })
    const timer = setTimeout(() => child.kill("SIGKILL"), SUBPROCESS_TIMEOUT_MS)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    child.on("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(null)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code === 0 ? stdout : null)
    })
  })

function normalized(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export type GuardOptions = {
  spawn?: Spawn
  now?: () => number
  home?: string
  ttlMs?: number
  onUnavailable?: () => void
  globalArgs?: string[]
}

export type Guard = {
  /** The refusal for a tool call, or `undefined` when it writes no managed target. */
  decide: (tool: string, input: unknown, cwd: string) => Promise<string | undefined>
  /** Drop the cached managed list. */
  invalidate: () => void
}

export function refusal(target: string, source: string | undefined): string {
  const hint = source ? `'${source}'` : `the path \`chezmoi source-path ${target}\` prints`
  return (
    `'${target}' is a chezmoi-managed target, not the source; the next chezmoi apply overwrites it. ` +
    `Edit the source at ${hint}, then run chezmoi apply. Do not write the live home-directory copy.`
  )
}

export function createGuard(options: GuardOptions = {}): Guard {
  const spawn = options.spawn ?? spawnChezmoi
  const now = options.now ?? Date.now
  const home = options.home ?? homedir()
  const ttl = options.ttlMs ?? MANAGED_TTL_MS
  let managed: Set<string> | null = null
  /** Real path to managed path, built on the first miss after each load. */
  let aliases: Map<string, string> | null = null
  let managedAt = 0
  let sourceDir: string | null | undefined
  let unavailableNotified = false
  const notifyUnavailable = () => {
    if (unavailableNotified) return
    unavailableNotified = true
    options.onUnavailable?.()
  }

  const invalidate = () => {
    managed = null
    aliases = null
  }

  const loadSourceDir = async (): Promise<string | null> => {
    if (sourceDir !== undefined) return sourceDir
    const out = await spawn(["source-path"], options.globalArgs)
    if (out === null) notifyUnavailable()
    sourceDir = out?.trim() || null
    return sourceDir
  }

  const loadManaged = async (): Promise<Set<string> | null> => {
    if (managed && now() - managedAt < ttl) return managed
    const out = await spawn(["managed", "--path-style=absolute"], options.globalArgs)
    if (out === null) {
      notifyUnavailable()
      return null
    }

    managed = new Set(out.split("\n").map((line) => line.trim()).filter(Boolean))
    aliases = null
    managedAt = now()
    return managed
  }

  const managedTarget = (set: Set<string>, abs: string): string | undefined => {
    if (set.has(abs)) return abs
    aliases ??= new Map([...set].map((path) => [normalized(path), path]))
    return aliases.get(normalized(abs))
  }

  const considerPath = async (abs: string): Promise<string | undefined> => {
    if (!under(abs, home) && !under(normalized(abs), normalized(home))) return undefined
    const source = await loadSourceDir()
    if (source && (under(abs, source) || under(normalized(abs), normalized(source)))) {
      invalidate()
      return undefined
    }
    const set = await loadManaged()
    if (!set) return undefined
    const target = managedTarget(set, abs)
    if (!target) return undefined
    const targetSource = (await spawn(["source-path", target], options.globalArgs))?.trim() || undefined
    if (targetSource && isSeedOnceSource(targetSource)) return undefined
    return refusal(abs, targetSource)
  }

  return {
    invalidate,
    decide: async (tool, input, cwd) => {
      const shell = shellCall(tool, input)
      if (shell && CHEZMOI_RUN.test(shell.command)) invalidate()
      for (const abs of writtenPaths(tool, input, cwd)) {
        const reason = await considerPath(abs)
        if (reason) return reason
      }
      return undefined
    },
  }
}
