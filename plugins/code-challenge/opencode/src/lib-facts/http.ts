import type { DiskCache } from "./cache.ts"

export const REQUEST_TIMEOUT_MS = 10_000
export const CONCURRENCY = 6
/** A reply larger than this is refused before any JSON is parsed. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024
export const MAX_REDIRECTS = 3

export type HttpOptions = {
  fetch: typeof fetch
  cache: DiskCache
  concurrency?: number
  timeoutMs?: number
  maxBodyBytes?: number
  signal?: AbortSignal
}

export type Reply = { body: unknown; link: string | null }

/** What to keep of a reply, and how to recognise a kept value when it comes back from the cache. */
export type Projection = { project: (reply: Reply) => unknown; valid: (body: unknown) => boolean }

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`${status} ${new URL(url).host}`)
  }
}

const AGENT = { "user-agent": "opencode-code-challenge" }

/** JSON over `fetch` with a shared concurrency limit, a per-request timeout, a body cap and the disk cache. */
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

  /** Read at most `maxBodyBytes` of the body, then parse it. */
  private async readJson(response: Response, url: string): Promise<unknown> {
    const max = this.options.maxBodyBytes ?? MAX_BODY_BYTES
    const tooLarge = () => new Error(`response too large ${new URL(url).host}`)
    if (Number(response.headers.get("content-length")) > max) throw tooLarge()
    const reader = response.body?.getReader()
    if (!reader) return response.json()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        throw tooLarge()
      }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  }

  /**
   * Redirects are followed by hand and only within the original host, so an `Authorization`
   * header never leaves the host it was meant for.
   */
  private send(url: string, init: RequestInit): Promise<Reply> {
    return this.slot(async () => {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout
      const origin = new URL(url)
      let target = url
      try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const response = await this.options.fetch(target, { ...init, signal, redirect: "manual" })
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location")
            const next = location ? new URL(location, target) : undefined
            if (next?.protocol !== "https:" || next.host !== origin.host)
              throw new Error(`redirect refused ${origin.host}`)
            target = next.href
            continue
          }
          if (!response.ok) throw new HttpError(response.status, target)
          return { body: await this.readJson(response, target), link: response.headers.get("link") }
        }
        throw new Error(`too many redirects ${origin.host}`)
      } catch (error) {
        if (timeout.aborted && !this.options.signal?.aborted) throw new Error(`timed out ${origin.host}`, { cause: error })
        throw error
      }
    })
  }

  /**
   * GET JSON, cached for the TTL. `headers` (a token) are not part of the cache key. A
   * `projection` reduces the reply to the public facts worth keeping: only its result is cached,
   * and a cached body that fails `valid` is a miss, so what comes back always has the projected shape.
   */
  async get(url: string, headers: Record<string, string> = {}, projection?: Projection): Promise<Reply> {
    const hit = this.options.cache.get(url, projection?.valid)
    if (hit) return hit
    const raw = await this.send(url, { headers: { accept: "application/json", ...AGENT, ...headers } })
    const reply: Reply = projection ? { body: projection.project(raw), link: null } : raw
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
