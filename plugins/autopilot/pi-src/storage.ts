/**
 * Plugin storage on pi: one JSON file per key, so every pi process on the machine (a lead, its
 * detached subagent runners) reads the same armed runs and review records. pi has no storage API
 * of its own, and a session's custom entries are visible to that session only.
 *
 * A write lands whole or not at all: it goes to a temporary file that is renamed over the key.
 * A file that is not JSON is an error, never an absent key, so a damaged store fails closed.
 */

import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { HostStorage, Json } from "../shared/autopilot.ts"

const SUFFIX = ".json"

const missing = (error: unknown) => (error as { code?: unknown } | null)?.code === "ENOENT"

/**
 * pi's agent directory: `PI_CODING_AGENT_DIR` (a leading `~` expanded) or `~/.pi/agent`, as pi's
 * own `getAgentDir` reads it. Computed here so the bundle imports no runtime value from pi, which
 * a host that loads pi extensions (OMP) may not provide.
 */
export function agentDir(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  const dir = env.PI_CODING_AGENT_DIR
  if (!dir) return join(home, ".pi", "agent")
  if (dir === "~") return home
  return dir.startsWith("~/") ? join(home, dir.slice(2)) : dir
}

/** The directory autopilot keeps its pi storage in. */
export const storageDir = (env?: Readonly<Record<string, string | undefined>>) => join(agentDir(env), "autopilot", "storage")

/** A storage key as a file name, and back; every character outside `[A-Za-z0-9._~-]` is escaped. */
const fileOf = (key: string) => `${encodeURIComponent(key).replaceAll("*", "%2A")}${SUFFIX}`
const keyOf = (name: string): string | undefined => {
  if (!name.endsWith(SUFFIX)) return undefined
  try {
    return decodeURIComponent(name.slice(0, -SUFFIX.length))
  } catch {
    return undefined
  }
}

export function fileStorage(dir: string): HostStorage {
  const read = (key: string): Json | undefined => {
    let text: string
    try {
      text = readFileSync(join(dir, fileOf(key)), "utf8")
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
    try {
      return JSON.parse(text) as Json
    } catch (error) {
      throw new Error(`the stored value of ${key} is not JSON (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return {
    get: async (key) => read(key),
    set: async (key, value) => {
      mkdirSync(dir, { recursive: true })
      const target = join(dir, fileOf(key))
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify(value), { flag: "wx" })
      try {
        renameSync(temporary, target)
      } catch (error) {
        rmSync(temporary, { force: true })
        throw error
      }
    },
    remove: async (key) => {
      rmSync(join(dir, fileOf(key)), { force: true })
    },
    scan: async ({ prefix, limit, after }) => {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch (error) {
        if (missing(error)) return { entries: [] }
        throw error
      }
      const keys = names
        .flatMap((name) => keyOf(name) ?? [])
        .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort()
      const entries: { key: string; value: Json }[] = []
      let index = 0
      for (; index < keys.length && entries.length < limit; index++) {
        const key = keys[index] as string
        const value = read(key)
        // A key removed since the listing is simply gone.
        if (value !== undefined) entries.push({ key, value })
      }
      const last = entries.at(-1)
      return index < keys.length && last !== undefined ? { entries, next: last.key } : { entries }
    },
  }
}
