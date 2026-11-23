import { execFile } from "node:child_process"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolCall, ToolOutcome } from "../tool-call.ts"
import { DiskCache, defaultCacheDir } from "./cache.ts"
import { collectPackage } from "./facts.ts"
import { Http } from "./http.ts"
import { nameProblem, versionProblem } from "./names.ts"
import { ECOSYSTEMS, type Ecosystem, type LibFacts, type PackageRequest } from "./types.ts"

export { CACHE_TTL_MS, DiskCache, defaultCacheDir } from "./cache.ts"
export { ALLOWED_LICENCES, licenceBlocked } from "./licence.ts"
export type { LibFacts, PackageFacts } from "./types.ts"

export const LIB_FACTS_TOOL = "challenge_lib_facts"
export const MAX_PACKAGES = 6

export const LIB_FACTS_DESCRIPTION =
  "Registry, OSV and GitHub facts for 1-6 packages (npm, pypi, crates, go); facts only, no verdict.\n" +
  "Per package: latest version and date, releases in 12 and 24 months, licence, downloads, dependents, " +
  "GitHub activity, dependency counts, size, types, ESM/CJS, OSV advisories (always fresh), and the hard gates " +
  "unpatchedCve and licenceNotAllowed. A failed source is listed in `missing`; the call still succeeds. " +
  "Everything but OSV is cached for 7 days."

export const LIB_FACTS_INPUT = {
  type: "object",
  properties: {
    ecosystem: { type: "string", enum: [...ECOSYSTEMS], description: "Package ecosystem" },
    packages: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PACKAGES,
      description: "Packages to look up; a version adds its OSV advisories",
      items: {
        type: "object",
        properties: { name: { type: "string" }, version: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  required: ["ecosystem", "packages"],
  additionalProperties: false,
} as const

/** The validated request, or the reason it is invalid. */
export function readRequest(input: unknown): { ecosystem: Ecosystem; packages: PackageRequest[] } | string {
  const { ecosystem, packages } = (input ?? {}) as { ecosystem?: unknown; packages?: unknown }
  if (!ECOSYSTEMS.includes(ecosystem as Ecosystem)) return `ecosystem must be one of ${ECOSYSTEMS.join(", ")}`
  if (!Array.isArray(packages) || packages.length < 1 || packages.length > MAX_PACKAGES)
    return `packages must hold 1 to ${MAX_PACKAGES} entries`
  const parsed: PackageRequest[] = []
  for (const entry of packages) {
    const { name, version } = (entry ?? {}) as { name?: unknown; version?: unknown }
    if (typeof name !== "string" || name.trim() === "") return "each package needs a non-empty name"
    const nameIssue = nameProblem(ecosystem as Ecosystem, name.trim())
    if (nameIssue) return `${nameIssue}: ${JSON.stringify(name.slice(0, 80))}`
    if (version === undefined) {
      parsed.push({ name: name.trim() })
      continue
    }
    if (typeof version !== "string" || versionProblem(version.trim()))
      return `invalid version: ${JSON.stringify(String(version).slice(0, 80))}`
    parsed.push({ name: name.trim(), version: version.trim() })
  }
  return { ecosystem: ecosystem as Ecosystem, packages: parsed }
}

/** `gh auth token`, run by the tool so the value never reaches the transcript. `undefined` when gh is absent or signed out. */
export function ghToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 5_000 }, (error, stdout) => {
      const token = error ? "" : stdout.trim()
      resolve(token === "" ? undefined : token)
    })
  })
}

/** Test seams; the host never passes them. */
export type LibFactsOverrides = {
  fetch?: typeof fetch
  cacheDir?: string
  token?: () => Promise<string | undefined>
  now?: () => Date
  timeoutMs?: number
  maxBodyBytes?: number
  concurrency?: number
}

export async function lookupLibFacts(
  ecosystem: Ecosystem,
  packages: readonly PackageRequest[],
  overrides: LibFactsOverrides = {},
  signal?: AbortSignal,
): Promise<LibFacts> {
  const now = overrides.now ?? (() => new Date())
  const cache = new DiskCache(overrides.cacheDir ?? defaultCacheDir(), () => now().getTime())
  const http = new Http({
    fetch: overrides.fetch ?? fetch,
    cache,
    signal,
    timeoutMs: overrides.timeoutMs,
    maxBodyBytes: overrides.maxBodyBytes,
    concurrency: overrides.concurrency,
  })
  let token: Promise<string | undefined> | undefined
  const collector = { http, now, token: () => (token ??= (overrides.token ?? ghToken)()) }
  const results = await Promise.all(packages.map((p) => collectPackage(ecosystem, p, collector)))
  // A cancelled call is not a degraded one: stop rather than return facts built from aborted requests.
  signal?.throwIfAborted()
  return { ecosystem, fetchedAt: now().toISOString(), packages: results }
}

/** `challenge_lib_facts` for any host: validate the request, then look the packages up. */
export async function runLibFacts(input: unknown, call: Pick<ToolCall, "signal">, overrides: LibFactsOverrides = {}): Promise<ToolOutcome> {
  const request = readRequest(input)
  if (typeof request === "string") return { content: `${LIB_FACTS_TOOL}: ${request}`, metadata: { ok: false } }
  const facts = await lookupLibFacts(request.ecosystem, request.packages, overrides, call.signal)
  return { content: JSON.stringify(facts, null, 1), metadata: { ok: true, facts } }
}

/** Register `challenge_lib_facts`. Dispose the returned registration with the plugin's other cleanups. */
export function registerLibFacts(ctx: Context, overrides: LibFactsOverrides = {}) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: LIB_FACTS_TOOL,
      description: LIB_FACTS_DESCRIPTION,
      input: LIB_FACTS_INPUT,
      execute: (input, context) => runLibFacts(input, { signal: context.signal }, overrides),
    })
  })
}
