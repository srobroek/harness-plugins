import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** One cached entry past this size is not stored; every entry is a trimmed fact set. */
export const MAX_ENTRY_BYTES = 256 * 1024
/** The sweep keeps the newest entries up to this count. */
export const MAX_ENTRIES = 2000

export type Cached = { body: unknown; link: string | null }

/** The per-user cache directory, following the XDG convention `claude-compat` uses. */
export function defaultCacheDir(xdgCacheHome: string | undefined = process.env.XDG_CACHE_HOME): string {
  return join(xdgCacheHome || join(homedir(), ".cache"), "opencode", "code-challenge", "lib-facts")
}

/**
 * A JSON-per-key disk cache with a time-to-live. Every failure reads as a miss. An expired
 * entry is deleted when read, and the first write of an instance sweeps expired files and
 * trims the directory to {@link MAX_ENTRIES}. A file's mtime is its write time.
 */
export class DiskCache {
  private swept = false

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CACHE_TTL_MS,
  ) {}

  private file(key: string): string {
    return join(this.dir, `${createHash("sha256").update(key).digest("hex")}.json`)
  }

  get(key: string): Cached | undefined {
    const file = this.file(key)
    try {
      const entry = JSON.parse(readFileSync(file, "utf8")) as { at: number } & Cached
      if (this.now() - entry.at < this.ttlMs) return { body: entry.body, link: entry.link }
      unlinkSync(file)
    } catch {
      // A missing or unreadable entry is a miss.
    }
    return undefined
  }

  put(key: string, value: Cached): void {
    try {
      const text = JSON.stringify({ at: this.now(), ...value })
      if (text.length > MAX_ENTRY_BYTES) return
      mkdirSync(this.dir, { recursive: true })
      this.sweep()
      const target = this.file(key)
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
        if (this.now() - at >= this.ttlMs) unlinkSync(file)
        else if (name.endsWith(".json")) live.push({ file, at })
      } catch {
        // Another process may have removed it.
      }
    }
    live.sort((a, b) => a.at - b.at)
    for (const { file } of live.slice(0, Math.max(0, live.length - MAX_ENTRIES))) {
      try {
        unlinkSync(file)
      } catch {
        // Already gone.
      }
    }
  }
}
