import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** One cached entry past this many UTF-8 bytes is neither stored nor read; every entry is a trimmed fact set. */
export const MAX_ENTRY_BYTES = 256 * 1024
/** The sweep keeps the newest entries up to this count, counting the one being written. */
export const MAX_ENTRIES = 2000
/** Bump when what an entry holds changes: files of any other version are never read and the sweep deletes them. */
export const CACHE_SCHEMA = "v2"

export type Cached = { body: unknown; link: string | null }

/** The per-user cache directory, following the XDG convention `claude-compat` uses. */
export function defaultCacheDir(xdgCacheHome: string | undefined = process.env.XDG_CACHE_HOME): string {
  return join(xdgCacheHome || join(homedir(), ".cache"), "opencode", "code-challenge", "lib-facts")
}

export function cacheFileName(key: string): string {
  return `${CACHE_SCHEMA}-${createHash("sha256").update(key).digest("hex")}.json`
}

const isEntry = (value: unknown): value is { at: number } & Cached => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return Number.isFinite(entry.at) && "body" in entry && (entry.link === null || typeof entry.link === "string")
}

function remove(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // Already gone, or another process removed it.
  }
}

/**
 * A JSON-per-key disk cache with a time-to-live. Every failure reads as a miss. A file is read
 * only when it has the current schema name, is within {@link MAX_ENTRY_BYTES} and has the right
 * shape; one that fails is deleted. An expired entry is deleted when read, and the first write
 * of an instance sweeps expired and other-schema files and trims the directory to `maxEntries`.
 * A file's mtime is its write time.
 */
export class DiskCache {
  private swept = false

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly maxEntries = MAX_ENTRIES,
  ) {}

  /**
   * `valid` checks the body a caller expects (a trimmed projection, not a whole reply); a body
   * that fails it is a miss.
   */
  get(key: string, valid: (body: unknown) => boolean = () => true): Cached | undefined {
    const file = join(this.dir, cacheFileName(key))
    try {
      if (statSync(file).size > MAX_ENTRY_BYTES) throw new Error("oversized")
      const entry: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (isEntry(entry) && this.now() - entry.at < this.ttlMs && valid(entry.body)) return { body: entry.body, link: entry.link }
    } catch {
      // Missing, oversized or unparsable: a miss.
    }
    remove(file)
    return undefined
  }

  put(key: string, value: Cached): void {
    try {
      const text = JSON.stringify({ at: this.now(), ...value })
      if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) return
      mkdirSync(this.dir, { recursive: true })
      this.sweep()
      const target = join(this.dir, cacheFileName(key))
      const temp = `${target}.${process.pid}.tmp`
      writeFileSync(temp, text)
      utimesSync(temp, this.now() / 1000, this.now() / 1000)
      renameSync(temp, target)
    } catch {
      // A cache that cannot be written only costs a refetch.
    }
  }

  private sweep(): void {
    if (this.swept) return
    this.swept = true
    const live: Array<{ file: string; at: number }> = []
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name)
      try {
        const at = statSync(file).mtimeMs
        const otherSchema = name.endsWith(".json") && !name.startsWith(`${CACHE_SCHEMA}-`)
        if (otherSchema || this.now() - at >= this.ttlMs) remove(file)
        else if (name.endsWith(".json")) live.push({ file, at })
      } catch {
        // Another process may have removed it.
      }
    }
    live.sort((a, b) => a.at - b.at)
    for (const { file } of live.slice(0, Math.max(0, live.length - (this.maxEntries - 1)))) remove(file)
  }
}
