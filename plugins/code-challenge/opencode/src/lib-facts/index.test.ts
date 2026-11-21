import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { cacheFileName } from "./cache.ts"
import { type LibFactsOverrides, licenceBlocked, registerLibFacts } from "./index.ts"
import { githubSlug } from "./sources.ts"
import type { LibFacts } from "./types.ts"

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>
type Route = unknown | Handler
type Calls = { urls: string[]; headers: Array<Record<string, string>>; bodies: unknown[]; redirects: Array<string | undefined> }

const NOW = new Date("2026-11-20T00:00:00Z")
const DAY = 24 * 60 * 60 * 1000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers })
const status = (code: number, headers: Record<string, string> = {}): Handler => () =>
  new Response("", { status: code, headers })

const DEPS = "https://api.deps.dev/v3/systems"
const GH = "https://api.github.com"
const OSV_URL = "https://api.osv.dev/v1/querybatch"

/** Recorded GitHub replies for `owner/repo`, with fields the tool must not keep (`node_id`, `owner`). */
function github(slug: string, extra: Record<string, Route> = {}): Record<string, Route> {
  const [owner = "", repo = ""] = slug.split("/")
  const query = encodeURIComponent(`repo:${slug} type:pr state:open`)
  return {
    [`${GH}/repos/${owner}/${repo}`]: {
      stargazers_count: 1234,
      open_issues_count: 10,
      archived: false,
      node_id: "NODE-ID-SENTINEL",
      owner: { login: "OWNER-SENTINEL" },
    },
    [`${GH}/search/issues?q=${query}&per_page=1`]: { total_count: 3 },
    [`${GH}/repos/${owner}/${repo}/commits?per_page=1`]: [{ commit: { committer: { date: "2026-11-10T00:00:00Z" } } }],
    [`${GH}/repos/${owner}/${repo}/contributors?per_page=1&anon=true`]: () =>
      json([{ login: "a" }], { link: `<${GH}/repositories/1/contributors?per_page=1&anon=true&page=25>; rel="last"` }),
    ...extra,
  }
}

/** Recorded replies for the npm package `demo` (latest 2.0.0), trimmed to the fields the tool reads. */
function npmDemo(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    [`${DEPS}/NPM/packages/demo`]: {
      versions: [
        { versionKey: { version: "1.0.0" }, publishedAt: "2023-01-01T00:00:00Z", isDefault: false },
        { versionKey: { version: "1.1.0" }, publishedAt: "2025-06-01T00:00:00Z", isDefault: false },
        { versionKey: { version: "2.0.0" }, publishedAt: "2026-10-01T00:00:00Z", isDefault: true },
      ],
    },
    [`${DEPS}/NPM/packages/demo/versions/2.0.0`]: {
      licenses: ["MIT"],
      relatedProjects: [{ projectKey: { id: "github.com/acme/demo" }, relationType: "SOURCE_REPO" }],
    },
    [`${DEPS}/NPM/packages/demo/versions/2.0.0:dependencies`]: {
      nodes: [{ relation: "SELF" }, ...["DIRECT", "DIRECT", "INDIRECT", "INDIRECT", "INDIRECT"].map((relation) => ({ relation }))],
    },
    "https://api.deps.dev/v3alpha/systems/NPM/packages/demo/versions/2.0.0:dependents": { dependentCount: 42 },
    "https://api.deps.dev/v3/projects/github.com%2Facme%2Fdemo": { starsCount: 900, openIssuesCount: 12 },
    "https://registry.npmjs.org/demo/2.0.0": {
      version: "2.0.0",
      license: "MIT",
      type: "module",
      exports: { ".": { types: "./a.d.ts", import: "./a.js" } },
      dist: { unpackedSize: 1000 },
    },
    "https://api.npmjs.org/downloads/point/last-week/demo": { downloads: 10 },
    "https://api.npmjs.org/downloads/point/last-month/demo": { downloads: 40 },
    ...github("acme/demo"),
    ...extra,
  }
}

type Osv = { latest: string[]; requested: string[] } | ((queries: unknown[]) => unknown)

function fakeFetch(routes: Record<string, Route>, osv: Osv = { latest: [], requested: [] }) {
  const calls: Calls = { urls: [], headers: [], bodies: [], redirects: [] }
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    calls.urls.push(`${init?.method ?? "GET"} ${target}`)
    calls.headers.push((init?.headers ?? {}) as Record<string, string>)
    calls.redirects.push(init?.redirect)
    if (target === OSV_URL) {
      const body = JSON.parse(String(init?.body)) as { queries: unknown[] }
      calls.bodies.push(body)
      if (typeof osv === "function") return json(osv(body.queries))
      return json({ results: [osv.latest, osv.requested].slice(0, body.queries.length).map((ids) => (ids.length ? { vulns: ids.map((id) => ({ id })) } : {})) })
    }
    const route = routes[target]
    if (typeof route === "function") return (route as Handler)(init)
    return route === undefined ? new Response("{}", { status: 404 }) : json(route)
  }) as unknown as typeof fetch
  return { fetch: fetchFake, calls }
}

type ToolResult = { content: string; metadata: { ok: boolean; facts?: LibFacts } }

/** A fetch that never answers; it fails only when its signal aborts, or already has. */
const hang = ((_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) reject(signal.reason)
    signal?.addEventListener("abort", () => reject(signal.reason))
  })) as unknown as typeof fetch

async function run(
  input: unknown,
  overrides: LibFactsOverrides,
  options: { cacheDir?: string; signal?: AbortSignal } = {},
) {
  const cacheDir = options.cacheDir ?? mkdtempSync(join(tmpdir(), "lib-facts-"))
  dirs.push(cacheDir)
  const fake = createFakeContext()
  await registerLibFacts(fake.context, { cacheDir, now: () => NOW, token: async () => "ghp_secret", ...overrides })
  const tool = fake.tools.get("challenge_lib_facts")?.execute as (input: unknown, context: unknown) => Promise<ToolResult>
  const result = await tool(input, { signal: options.signal ?? new AbortController().signal })
  return { result, facts: result.metadata.facts?.packages[0], cacheDir }
}

const demo = { ecosystem: "npm", packages: [{ name: "demo", version: "1.0.0" }] }

describe("challenge_lib_facts on npm", () => {
  test("returns the facts of one package from every source", async () => {
    const { fetch } = fakeFetch(npmDemo(), { latest: [], requested: ["GHSA-old"] })
    const { facts, result } = await run(demo, { fetch })
    expect(facts).toEqual({
      name: "demo",
      requestedVersion: "1.0.0",
      latest: { version: "2.0.0", publishedAt: "2026-10-01T00:00:00Z" },
      releases: { last12Months: 1, last24Months: 2, monthsSinceLast: 1.6 },
      deprecated: false,
      yanked: null,
      licence: ["MIT"],
      downloads: { lastWeek: 10, lastMonth: 40, last90Days: null },
      dependents: 42,
      repo: {
        url: "https://github.com/acme/demo",
        stars: 1234,
        openIssues: 7,
        openPullRequests: 3,
        lastCommit: "2026-11-10T00:00:00Z",
        contributors: 25,
        archived: false,
      },
      dependencies: { direct: 2, transitive: 3 },
      size: { unpackedBytes: 1000, downloadBytes: null },
      types: true,
      modules: "esm",
      vulnerabilities: { latest: [], requested: ["GHSA-old"] },
      gates: { unpatchedCve: false, licenceNotAllowed: false, failed: [] },
      missing: [],
    })
    expect(result.content).not.toContain("ghp_secret")
  })

  test("encodes a scoped name the way each service expects", async () => {
    const scoped = "%40acme%2Fwidget"
    const { fetch, calls } = fakeFetch({
      [`${DEPS}/NPM/packages/${scoped}`]: { versions: [{ versionKey: { version: "1.0.0" }, publishedAt: "2026-01-01T00:00:00Z", isDefault: true }] },
    })
    await run({ ecosystem: "npm", packages: [{ name: "@acme/widget" }] }, { fetch })
    expect(calls.urls).toContain("GET https://registry.npmjs.org/@acme%2Fwidget/1.0.0")
    expect(calls.urls).toContain("GET https://api.npmjs.org/downloads/point/last-week/@acme%2Fwidget")
    expect(calls.urls).toContain(`GET ${DEPS}/NPM/packages/${scoped}/versions/1.0.0`)
  })

  test("serves a second call from the cache but asks OSV again", async () => {
    const { fetch, calls } = fakeFetch(npmDemo())
    const first = await run(demo, { fetch })
    const afterFirst = calls.urls.length
    await run(demo, { fetch }, { cacheDir: first.cacheDir })
    expect(calls.urls.slice(afterFirst)).toEqual([`POST ${OSV_URL}`])
  })

  test("expires a cache entry exactly 7 days after it was written", async () => {
    const { fetch, calls } = fakeFetch(npmDemo())
    const first = await run(demo, { fetch })
    const reads = () => calls.urls.filter((u) => u.startsWith("GET")).length
    const initial = reads()
    await run(demo, { fetch, now: () => new Date(NOW.getTime() + 7 * DAY - 1) }, { cacheDir: first.cacheDir })
    expect(reads()).toBe(initial)
    await run(demo, { fetch, now: () => new Date(NOW.getTime() + 7 * DAY) }, { cacheDir: first.cacheDir })
    expect(reads()).toBe(initial * 2)
  })

  test("sends the GitHub token only to GitHub", async () => {
    const { fetch, calls } = fakeFetch(npmDemo())
    await run(demo, { fetch })
    const withToken = calls.urls.filter((_, i) => calls.headers[i]?.authorization === "Bearer ghp_secret")
    expect(withToken.length).toBeGreaterThan(0)
    expect(withToken.every((u) => u.includes("api.github.com"))).toBe(true)
  })

  test("caches only the public facts it needs from GitHub", async () => {
    const { fetch } = fakeFetch(npmDemo())
    const { cacheDir } = await run(demo, { fetch })
    const stored = readdirSync(cacheDir).map((f) => readFileSync(join(cacheDir, f), "utf8"))
    expect(stored.join("")).toContain("1234")
    expect(stored.join("")).not.toMatch(/SENTINEL|ghp_secret/)
  })

  test("a failed download call leaves the other figure in place", async () => {
    const { fetch } = fakeFetch(npmDemo({ "https://api.npmjs.org/downloads/point/last-week/demo": status(500) }))
    const { facts } = await run(demo, { fetch })
    expect(facts?.downloads).toEqual({ lastWeek: null, lastMonth: 40, last90Days: null })
    expect(facts?.missing).toEqual(["npm downloads last-week: 500 api.npmjs.org"])
  })

  test.each([
    ["a legacy-format file", (key: string) => `${createHash("sha256").update(key).digest("hex")}.json`],
    ["a current-format file holding a whole reply", (key: string) => cacheFileName(key)],
  ])("never serves %s from the cache", async (_name, fileFor) => {
    const { fetch, calls } = fakeFetch(npmDemo())
    const cacheDir = mkdtempSync(join(tmpdir(), "lib-facts-"))
    const url = `${GH}/repos/acme/demo`
    const whole = { at: NOW.getTime(), body: { stargazers_count: 5, node_id: "LEGACY-SENTINEL" }, link: null }
    writeFileSync(join(cacheDir, fileFor(url)), JSON.stringify(whole))
    const { facts, result } = await run(demo, { fetch }, { cacheDir })
    expect(calls.urls).toContain(`GET ${url}`)
    expect(facts?.repo?.stars).toBe(1234)
    expect(result.content).not.toContain("SENTINEL")
  })

  test("a failed source leaves only its own fields null", async () => {
    const { fetch } = fakeFetch(npmDemo({ "https://api.deps.dev/v3alpha/systems/NPM/packages/demo/versions/2.0.0:dependents": status(500) }))
    const { facts } = await run(demo, { fetch })
    expect(facts?.dependents).toBeNull()
    expect(facts?.missing).toEqual(["deps.dev dependents: 500 api.deps.dev"])
    expect(facts?.downloads?.lastWeek).toBe(10)
  })

  test.each([
    ["both GitHub counts fail", { [`${GH}/repos/acme/demo`]: status(403), [`${GH}/search/issues?q=repo%3Aacme%2Fdemo%20type%3Apr%20state%3Aopen&per_page=1`]: status(500) }],
    ["only the pull request count fails", { [`${GH}/search/issues?q=repo%3Aacme%2Fdemo%20type%3Apr%20state%3Aopen&per_page=1`]: status(500) }],
  ])("reports no open-issue count when %s, rather than one that includes pull requests", async (_name, routes) => {
    const { fetch } = fakeFetch(npmDemo(routes))
    const { facts } = await run(demo, { fetch })
    expect(facts?.repo?.openIssues).toBeNull()
  })

  test.each([
    ["deps.dev says the version is deprecated", { isDeprecated: true }, true, true],
    ["deps.dev says it is not deprecated and the registry fails", { isDeprecated: false }, false, false],
    ["neither deps.dev nor the registry can say", {}, false, null],
  ])("deprecated when %s", async (_name, versionDoc, registryWorks, expected) => {
    const routes = npmDemo({
      [`${DEPS}/NPM/packages/demo/versions/2.0.0`]: { licenses: ["MIT"], ...versionDoc },
      ...(registryWorks ? {} : { "https://registry.npmjs.org/demo/2.0.0": status(500) }),
    })
    const { facts } = await run(demo, { fetch: fakeFetch(routes).fetch })
    expect(facts?.deprecated).toBe(expected)
  })

  test("falls back to deps.dev counts when GitHub refuses, without counting pull requests as issues", async () => {
    const { fetch } = fakeFetch(npmDemo({ [`${GH}/repos/acme/demo`]: status(403) }))
    const { facts } = await run(demo, { fetch })
    expect(facts?.repo).toMatchObject({ stars: 900, openIssues: 9, openPullRequests: 3, contributors: 25 })
    expect(facts?.missing).toEqual(["github repo: 403 api.github.com"])
  })

  test("ignores registry metadata that describes another version than the reported one", async () => {
    const { fetch } = fakeFetch(
      npmDemo({
        [`${DEPS}/NPM/packages/demo/versions/2.0.0`]: { licenses: [] },
        "https://registry.npmjs.org/demo/2.0.0": { version: "1.9.0", license: "GPL-3.0-only", dist: { unpackedSize: 5 } },
      }),
    )
    const { facts } = await run(demo, { fetch })
    expect(facts).toMatchObject({ licence: null, size: null, types: null, modules: null })
    expect(facts?.gates.licenceNotAllowed).toBeNull()
    expect(facts?.missing).toEqual(["registry: describes 1.9.0, not 2.0.0"])
  })

  test("a package no source knows yields only missing entries", async () => {
    const { fetch } = fakeFetch(npmDemo())
    const { facts } = await run({ ecosystem: "npm", packages: [{ name: "ghost" }] }, { fetch })
    expect(facts?.latest).toBeNull()
    expect(facts?.gates).toEqual({ unpatchedCve: null, licenceNotAllowed: null, failed: [] })
    expect(facts?.missing.length).toBeGreaterThan(0)
  })
})

describe("hard gates", () => {
  test.each([
    ["GPL-3.0-only", true],
    ["(MIT OR Apache-2.0) AND GPL-3.0-only", true],
    ["MIT OR GPL-3.0-only", false],
  ])("licence %s -> not allowed: %p", async (licence, blocked) => {
    const { fetch } = fakeFetch(npmDemo({ [`${DEPS}/NPM/packages/demo/versions/2.0.0`]: { licenses: [licence] } }))
    const { facts } = await run(demo, { fetch })
    expect(facts?.gates.licenceNotAllowed).toBe(blocked)
    expect(facts?.gates.failed).toEqual(blocked ? ["licence-not-allowed"] : [])
  })

  test("fails the CVE gate when the latest version still has an advisory", async () => {
    const { fetch } = fakeFetch(npmDemo(), { latest: ["GHSA-live"], requested: ["GHSA-live", "GHSA-old"] })
    const { facts } = await run(demo, { fetch })
    expect(facts?.vulnerabilities).toEqual({ latest: ["GHSA-live"], requested: ["GHSA-live", "GHSA-old"] })
    expect(facts?.gates).toEqual({ unpatchedCve: true, licenceNotAllowed: false, failed: ["unpatched-cve"] })
  })

  test("leaves the CVE gate unknown when OSV is down", async () => {
    const { fetch } = fakeFetch({ ...npmDemo(), [OSV_URL]: status(503) })
    const down = ((url: string | URL | Request, init?: RequestInit) =>
      String(url) === OSV_URL ? Promise.resolve(new Response("", { status: 503 })) : fetch(url, init)) as unknown as typeof globalThis.fetch
    const { facts } = await run(demo, { fetch: down })
    expect(facts?.gates.unpatchedCve).toBeNull()
    expect(facts?.missing).toEqual(["osv: 503 api.osv.dev"])
  })

  test.each([
    ["no results", () => ({})],
    ["too few results", () => ({ results: [{}] })],
    ["a continuation token", () => ({ results: [{ vulns: [{ id: "A" }], next_page_token: "more" }, {}] })],
    ["vulns that is not a list", () => ({ results: [{ vulns: "none" }, {}] })],
    ["a vuln without an id", () => ({ results: [{ vulns: [{}] }, {}] })],
    ["a null result entry", () => ({ results: [null, {}] })],
    ["a scalar result entry", () => ({ results: [{}, 5] })],
    ["an array result entry", () => ({ results: [[], {}] })],
  ])("an OSV reply with %s never reads as a clean pass", async (_name, reply) => {
    const { fetch } = fakeFetch(npmDemo(), reply)
    const { facts } = await run(demo, { fetch })
    expect(facts?.vulnerabilities).toBeNull()
    expect(facts?.gates.unpatchedCve).toBeNull()
    expect(facts?.missing).toHaveLength(1)
    expect(facts?.missing[0]).toMatch(/^osv: (malformed|truncated) response api\.osv\.dev$/)
  })
})

describe("other ecosystems", () => {
  test("reads PyPI with a normalised name and the per-version document", async () => {
    const { fetch, calls } = fakeFetch({
      [`${DEPS}/PYPI/packages/demo-pkg`]: {
        versions: [
          { versionKey: { version: "0.9" }, publishedAt: "2024-01-01T00:00:00Z", isDefault: false },
          { versionKey: { version: "1.0.0" }, publishedAt: "2026-09-01T00:00:00Z", isDefault: true },
        ],
      },
      [`${DEPS}/PYPI/packages/demo-pkg/versions/1.0.0`]: {
        licenses: ["Apache-2.0"],
        links: [{ label: "SOURCE_REPO", url: "git+https://github.com/acme/demo-pkg.git" }],
      },
      [`${DEPS}/PYPI/packages/demo-pkg/versions/1.0.0:dependencies`]: { nodes: [{ relation: "SELF" }, { relation: "DIRECT" }] },
      "https://pypi.org/pypi/demo-pkg/1.0.0/json": {
        info: { version: "1.0.0", license_expression: "Apache-2.0", yanked: false, classifiers: ["Typing :: Typed"] },
        urls: [
          { size: 300, upload_time_iso_8601: "2026-09-01T00:00:00Z", yanked: false },
          { size: 700, yanked: false },
        ],
      },
      "https://pypistats.org/api/packages/demo-pkg/recent": { data: { last_week: 5, last_month: 20 } },
      ...github("acme/demo-pkg"),
    })
    const { facts } = await run({ ecosystem: "pypi", packages: [{ name: "Demo_Pkg" }] }, { fetch })
    expect(facts).toMatchObject({
      name: "Demo_Pkg",
      latest: { version: "1.0.0", publishedAt: "2026-09-01T00:00:00Z" },
      releases: { last12Months: 1, last24Months: 1, monthsSinceLast: 2.6 },
      licence: ["Apache-2.0"],
      yanked: false,
      types: true,
      modules: null,
      size: { unpackedBytes: null, downloadBytes: 1000 },
      downloads: { lastWeek: 5, lastMonth: 20, last90Days: null },
      dependencies: { direct: 1, transitive: 0 },
      repo: { url: "https://github.com/acme/demo-pkg", stars: 1234 },
    })
    expect(calls.bodies).toEqual([{ queries: [{ package: { name: "demo-pkg", ecosystem: "PyPI" }, version: "1.0.0" }] }])
  })

  test("reads crates.io from the entry of the reported version", async () => {
    const { fetch, calls } = fakeFetch({
      [`${DEPS}/CARGO/packages/serde-demo`]: {
        versions: [
          { versionKey: { version: "1.0.0" }, publishedAt: "2025-01-01T00:00:00Z", isDefault: false },
          { versionKey: { version: "1.1.0" }, publishedAt: "2026-11-01T00:00:00Z", isDefault: true },
        ],
      },
      [`${DEPS}/CARGO/packages/serde-demo/versions/1.1.0`]: { licenses: [] },
      "https://crates.io/api/v1/crates/serde-demo": {
        crate: { max_version: "1.1.0", repository: "https://github.com/acme/serde-demo", recent_downloads: 5000 },
        versions: [
          { num: "1.0.0", license: "GPL-3.0-only", yanked: false, crate_size: 1 },
          { num: "1.1.0", license: "MIT OR Apache-2.0", yanked: true, crate_size: 2048 },
        ],
      },
      ...github("acme/serde-demo"),
    })
    const { facts } = await run({ ecosystem: "crates", packages: [{ name: "serde-demo" }] }, { fetch })
    expect(facts).toMatchObject({
      latest: { version: "1.1.0" },
      licence: ["MIT OR Apache-2.0"],
      yanked: true,
      size: { downloadBytes: 2048 },
      downloads: { lastWeek: null, lastMonth: null, last90Days: 5000 },
      repo: { url: "https://github.com/acme/serde-demo" },
    })
    expect(facts?.gates.licenceNotAllowed).toBe(false)
    expect(calls.bodies).toEqual([{ queries: [{ package: { name: "serde-demo", ecosystem: "crates.io" }, version: "1.1.0" }] }])
  })

  test("reads a Go module through the escaped proxy path and has no download figures", async () => {
    const { fetch, calls } = fakeFetch({
      [`${DEPS}/GO/packages/github.com%2FAcme%2FMod`]: {
        versions: [{ versionKey: { version: "v1.2.0" }, publishedAt: "2026-06-01T00:00:00Z", isDefault: true }],
      },
      [`${DEPS}/GO/packages/github.com%2FAcme%2FMod/versions/v1.2.0`]: {
        licenses: ["BSD-3-Clause"],
        relatedProjects: [{ projectKey: { id: "github.com/Acme/Mod" } }],
      },
      "https://proxy.golang.org/github.com/!acme/!mod/@v/v1.2.0.info": { Version: "v1.2.0", Time: "2026-06-01T00:00:00Z" },
      ...github("Acme/Mod"),
    })
    const { facts } = await run({ ecosystem: "go", packages: [{ name: "github.com/Acme/Mod" }] }, { fetch })
    expect(facts).toMatchObject({
      latest: { version: "v1.2.0" },
      licence: ["BSD-3-Clause"],
      downloads: null,
      repo: { url: "https://github.com/Acme/Mod", stars: 1234 },
    })
    expect(facts?.missing.filter((m) => m.includes("download"))).toEqual([])
    expect(calls.bodies).toEqual([{ queries: [{ package: { name: "github.com/Acme/Mod", ecosystem: "Go" }, version: "v1.2.0" }] }])
  })
})

describe("untrusted input", () => {
  const withRepo = (url: string) =>
    npmDemo({
      [`${DEPS}/NPM/packages/demo/versions/2.0.0`]: { licenses: ["MIT"] },
      "https://registry.npmjs.org/demo/2.0.0": { version: "2.0.0", license: "MIT", repository: { url } },
    })

  test.each([
    "https://github.com/acme/..%2F..%2Fuser",
    "https://github.com/acme\\..\\x",
    "github.com/../../user",
    "https://github.com/acme/demo/../../orgs/x",
    "https://github.com/acme/..",
    "https://github.com/acme/%2e%2e",
    "https://github.com/acme/demo?x=/../..",
    "https://github.com/ac me/demo",
    "https://evil.example/github.com/acme/demo",
    "https://github.com.evil.example/acme/demo",
  ])("never builds a GitHub API path from the repository URL %p", async (url) => {
    const { fetch, calls } = fakeFetch(withRepo(url))
    const { facts } = await run(demo, { fetch })
    expect(facts?.repo).toBeNull()
    expect(calls.urls.filter((u) => u.includes("api.github.com") || u.includes("/v3/projects/"))).toEqual([])
  })

  test.each([
    ["https://github.com/acme/demo", "acme/demo"],
    ["git+https://github.com/acme/demo.git", "acme/demo"],
    ["git://github.com/acme/demo.git", "acme/demo"],
    ["ssh://git@github.com/acme/demo.git", "acme/demo"],
    ["git@github.com:acme/demo.git", "acme/demo"],
    ["github:acme/demo", "acme/demo"],
    ["github.com/acme/demo", "acme/demo"],
    ["https://github.com/acme/demo/tree/main/packages/x", "acme/demo"],
    ["https://github.com/acme/demo.js#readme", "acme/demo.js"],
  ])("reads the repository from %p", (url, expected) => {
    const slug = githubSlug(url)
    expect(slug && `${slug.owner}/${slug.repo}`).toBe(expected)
  })

  test("does not follow a GitHub redirect to another host", async () => {
    const { fetch, calls } = fakeFetch(npmDemo({ [`${GH}/repos/acme/demo`]: status(301, { location: "https://evil.example/steal" }) }))
    const { facts } = await run(demo, { fetch })
    expect(calls.urls.some((u) => u.includes("evil.example"))).toBe(false)
    expect(facts?.missing).toContain("github repo: redirect refused api.github.com")
  })

  test("follows a redirect within GitHub and keeps the token there", async () => {
    const { fetch, calls } = fakeFetch(
      npmDemo({
        [`${GH}/repos/acme/demo`]: status(301, { location: `${GH}/repositories/1` }),
        [`${GH}/repositories/1`]: { stargazers_count: 77, open_issues_count: 5, archived: false },
      }),
    )
    const { facts } = await run(demo, { fetch })
    expect(facts?.repo?.stars).toBe(77)
    const hop = calls.urls.indexOf(`GET ${GH}/repositories/1`)
    expect(calls.headers[hop]?.authorization).toBe("Bearer ghp_secret")
    expect(calls.redirects.every((mode) => mode === "manual")).toBe(true)
  })

  test.each([
    ["npm", "../x"],
    ["npm", "@a/b/c"],
    ["npm", "a?b"],
    ["npm", "a#b"],
    ["pypi", "a/b"],
    ["pypi", "bad\u0000name"],
    ["crates", "9start"],
    ["go", "github.com/a/../b"],
    ["go", "example.com/mod?x=1"],
    ["go", "example.com/a#b"],
    ["go", "example.com/a\nb"],
  ])("rejects the %s name %p before any request", async (ecosystem, name) => {
    const { fetch, calls } = fakeFetch({})
    const { result } = await run({ ecosystem, packages: [{ name }] }, { fetch })
    expect(result.metadata.ok).toBe(false)
    expect(result.content).toContain("invalid")
    expect(calls.urls).toEqual([])
  })

  test("rejects a version that is not a plain version string", async () => {
    const { fetch, calls } = fakeFetch({})
    const { result } = await run({ ecosystem: "npm", packages: [{ name: "demo", version: "1/../2" }] }, { fetch })
    expect(result.metadata.ok).toBe(false)
    expect(calls.urls).toEqual([])
  })

  test("rejects an unknown ecosystem and too many packages", async () => {
    const { fetch, calls } = fakeFetch({})
    const bad = await run({ ecosystem: "gem", packages: [{ name: "x" }] }, { fetch })
    expect(bad.result.metadata.ok).toBe(false)
    const many = await run({ ecosystem: "npm", packages: Array.from({ length: 7 }, (_, i) => ({ name: `p${i}` })) }, { fetch })
    expect(many.result.content).toContain("1 to 6")
    expect(calls.urls).toEqual([])
  })
})

describe("resource limits", () => {
  test("refuses a reply over the byte cap without parsing it", async () => {
    const { fetch } = fakeFetch(npmDemo({ [`${DEPS}/NPM/packages/demo`]: () => new Response(JSON.stringify({ pad: "x".repeat(3000) })) }))
    const { facts } = await run(demo, { fetch, maxBodyBytes: 1000 })
    expect(facts?.releases).toBeNull()
    expect(facts?.missing).toContain("deps.dev packages: response too large api.deps.dev")
  })

  test("never has more requests in flight than the limit", async () => {
    let active = 0
    let peak = 0
    const slow = (async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    const packages = Array.from({ length: 6 }, (_, i) => ({ name: `pkg${i}` }))
    await run({ ecosystem: "npm", packages }, { fetch: slow, concurrency: 2 })
    expect(peak).toBe(2)
  })

  test("times out a source that never answers and still returns the call", async () => {
    const { facts } = await run(demo, { fetch: hang, timeoutMs: 20 })
    expect(facts?.latest).toBeNull()
    expect(facts?.missing).toContain("deps.dev packages: timed out api.deps.dev")
    expect(facts?.missing).toContain("registry: timed out registry.npmjs.org")
  })

  test("stops when the caller cancels instead of returning degraded facts", async () => {
    const controller = new AbortController()
    const pending = run(demo, { fetch: hang }, { signal: controller.signal })
    setTimeout(() => controller.abort(new Error("cancelled")), 10)
    await expect(pending).rejects.toThrow("cancelled")
  })
})

describe("licenceBlocked", () => {
  test.each([
    [["MIT"], false],
    [["Apache-2.0", "BSD-3-Clause"], false],
    [["MIT OR GPL-3.0-only"], false],
    [["MIT AND GPL-3.0-only"], true],
    [["(MIT OR Apache-2.0) AND GPL-3.0-only"], true],
    [["GPL-3.0-only OR (MIT AND Apache-2.0)"], false],
    [["MIT AND (GPL-3.0-only OR AGPL-3.0-only)"], true],
    [["GPL-2.0-only WITH Classpath-exception-2.0"], true],
    [["LGPL-3.0-or-later"], false],
    [["AGPL-3.0-only"], true],
    [["non-standard"], true],
    [["(MIT"], true],
    [[], null],
    [null, null],
  ])("%j -> %p", (licences, expected) => {
    expect(licenceBlocked(licences)).toBe(expected)
  })
})
