import type { DiskCache } from "./cache.ts"

export const REQUEST_TIMEOUT_MS = 10_000
export const CONCURRENCY = 6

export type HttpOptions = {
  fetch: typeof fetch
  cache: DiskCache
  concurrency?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export type Reply = { body: unknown; link: string | null }

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`${status} ${new URL(url).host}`)
  }
}

const AGENT = { "user-agent": "opencode-code-challenge" }

/** JSON over `fetch` with a shared concurrency limit, a per-request timeout and the disk cache. */
export class Http {
  private active = 0
  private readonly waiting: Array<() => void> = []
  private readonly limit: number

  constructor(private readonly options: HttpOptions) {
    this.limit = options.concurrency ?? CONCURRENCY
  }

  private async slot<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    try {
      return await run()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }

  private send(url: string, init: RequestInit): Promise<Reply> {
    return this.slot(async () => {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout
      const response = await this.options.fetch(url, { ...init, signal })
      if (!response.ok) throw new HttpError(response.status, url)
      return { body: await response.json(), link: response.headers.get("link") }
    })
  }

  /** GET JSON, cached for the TTL. `headers` (a token) are not part of the cache key. */
  async get(url: string, headers: Record<string, string> = {}): Promise<Reply> {
    const hit = this.options.cache.get(url)
    if (hit) return hit
    const reply = await this.send(url, { headers: { accept: "application/json", ...AGENT, ...headers } })
    this.options.cache.put(url, reply)
    return reply
  }

  /** POST JSON, never cached: OSV is always fetched fresh. */
  post(url: string, payload: unknown): Promise<Reply> {
    return this.send(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...AGENT },
      body: JSON.stringify(payload),
    })
  }
}
