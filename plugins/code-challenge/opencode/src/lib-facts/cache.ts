import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type Cached = { body: unknown; link: string | null }

/** The per-user cache directory, following the XDG convention `claude-compat` uses. */
export function defaultCacheDir(xdgCacheHome: string | undefined = process.env.XDG_CACHE_HOME): string {
  return join(xdgCacheHome || join(homedir(), ".cache"), "opencode", "code-challenge", "lib-facts")
}

/** A JSON-per-key disk cache with a time-to-live. Every failure reads as a miss. */
export class DiskCache {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CACHE_TTL_MS,
  ) {}

  private file(key: string): string {
    return join(this.dir, `${createHash("sha256").update(key).digest("hex")}.json`)
  }

  get(key: string): Cached | undefined {
    try {
      const entry = JSON.parse(readFileSync(this.file(key), "utf8")) as { at: number } & Cached
      return this.now() - entry.at < this.ttlMs ? { body: entry.body, link: entry.link } : undefined
    } catch {
      return undefined
    }
  }

  put(key: string, value: Cached): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const target = this.file(key)
      const temp = `${target}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify({ at: this.now(), ...value }))
      renameSync(temp, target)
    } catch {
      // A cache that cannot be written only costs a refetch.
    }
  }
}
