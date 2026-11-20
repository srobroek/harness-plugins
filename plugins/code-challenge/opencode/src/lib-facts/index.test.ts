import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { type LibFactsOverrides, licenceBlocked, registerLibFacts } from "./index.ts"
import type { LibFacts } from "./types.ts"

type Route = unknown | (() => Response)
type Calls = { urls: string[]; headers: Array<Record<string, string>> }

const NOW = new Date("2026-11-20T00:00:00Z")
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers })

/** Recorded response bodies for the npm package `demo`, trimmed to the fields the tool reads. */
function fixtures(overrides: Record<string, Route> = {}, osv: { latest: string[]; requested: string[] } = { latest: [], requested: [] }) {
  const routes: Record<string, Route> = {
    "https://api.deps.dev/v3/systems/NPM/packages/demo": {
      versions: [
        { versionKey: { version: "1.0.0" }, publishedAt: "2023-01-01T00:00:00Z", isDefault: false },
        { versionKey: { version: "1.1.0" }, publishedAt: "2025-06-01T00:00:00Z", isDefault: false },
        { versionKey: { version: "2.0.0" }, publishedAt: "2026-10-01T00:00:00Z", isDefault: true },
      ],
    },
    "https://api.deps.dev/v3/systems/NPM/packages/demo/versions/2.0.0": {
      licenses: ["MIT"],
      relatedProjects: [{ projectKey: { id: "github.com/acme/demo" }, relationType: "SOURCE_REPO" }],
    },
    "https://api.deps.dev/v3/systems/NPM/packages/demo/versions/2.0.0:dependencies": {
      nodes: [{ relation: "SELF" }, { relation: "DIRECT" }, { relation: "DIRECT" }, { relation: "INDIRECT" }, { relation: "INDIRECT" }, { relation: "INDIRECT" }],
    },
    "https://api.deps.dev/v3alpha/systems/NPM/packages/demo/versions/2.0.0:dependents": { dependentCount: 42 },
    "https://api.deps.dev/v3/projects/github.com%2Facme%2Fdemo": { starsCount: 900, openIssuesCount: 12 },
    "https://registry.npmjs.org/demo/latest": {
      version: "2.0.0",
      license: "MIT",
      type: "module",
      exports: { ".": { types: "./a.d.ts", import: "./a.js" } },
      dist: { unpackedSize: 1000 },
    },
    "https://api.npmjs.org/downloads/point/last-week/demo": { downloads: 10 },
    "https://api.npmjs.org/downloads/point/last-month/demo": { downloads: 40 },
    "https://api.github.com/repos/acme/demo": { stargazers_count: 1234, open_issues_count: 10, archived: false },
    "https://api.github.com/search/issues?q=repo%3Aacme%2Fdemo%20type%3Apr%20state%3Aopen&per_page=1": { total_count: 3 },
    "https://api.github.com/repos/acme/demo/commits?per_page=1": [{ commit: { committer: { date: "2026-11-10T00:00:00Z" } } }],
    "https://api.github.com/repos/acme/demo/contributors?per_page=1&anon=true": [{ login: "a" }],
    ...overrides,
  }
  const calls: Calls = { urls: [], headers: [] }
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    calls.urls.push(`${init?.method ?? "GET"} ${target}`)
    calls.headers.push((init?.headers ?? {}) as Record<string, string>)
    if (target === "https://api.osv.dev/v1/querybatch") {
      const queries = JSON.parse(String(init?.body)).queries as unknown[]
      return json({ results: [osv.latest, osv.requested].slice(0, queries.length).map((ids) => ({ vulns: ids.map((id) => ({ id })) })) })
    }
    if (target === "https://api.github.com/repos/acme/demo/contributors?per_page=1&anon=true")
      return json(routes[target], { link: '<https://api.github.com/repositories/1/contributors?per_page=1&anon=true&page=25>; rel="last"' })
    const route = routes[target]
    if (typeof route === "function") return (route as () => Response)()
    return route === undefined ? new Response("{}", { status: 404 }) : json(route)
  }) as unknown as typeof fetch
  return { fetch: fetchFake, calls }
}

async function run(input: unknown, overrides: LibFactsOverrides, cacheDir = mkdtempSync(join(tmpdir(), "lib-facts-"))) {
  dirs.push(cacheDir)
  const fake = createFakeContext()
  await registerLibFacts(fake.context, { cacheDir, now: () => NOW, token: async () => "ghp_secret", ...overrides })
  const tool = fake.tools.get("challenge_lib_facts")?.execute as (
    input: unknown,
    context: unknown,
  ) => Promise<{ content: string; metadata: { ok: boolean; facts?: LibFacts } }>
  const result = await tool(input, { signal: new AbortController().signal })
  return { result, facts: result.metadata.facts?.packages[0], cacheDir }
}

const demo = { ecosystem: "npm", packages: [{ name: "demo", version: "1.0.0" }] }

describe("challenge_lib_facts", () => {
  test("returns the facts of one package from every source", async () => {
    const { fetch } = fixtures({}, { latest: [], requested: ["GHSA-old"] })
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
        url: "github.com/acme/demo",
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

  test("serves a second call from the cache but always asks OSV again", async () => {
    const { fetch, calls } = fixtures()
    const first = await run(demo, { fetch })
    const afterFirst = calls.urls.length
    await run(demo, { fetch }, first.cacheDir)
    const second = calls.urls.slice(afterFirst)
    expect(second).toEqual(["POST https://api.osv.dev/v1/querybatch"])
    expect(calls.urls.filter((u) => u.startsWith("POST"))).toHaveLength(2)
  })

  test("sends the GitHub token only to GitHub", async () => {
    const { fetch, calls } = fixtures()
    await run(demo, { fetch })
    const withToken = calls.urls.filter((_, i) => calls.headers[i]?.authorization === "Bearer ghp_secret")
    expect(withToken.length).toBeGreaterThan(0)
    expect(withToken.every((u) => u.includes("api.github.com"))).toBe(true)
  })

  test("a failed source leaves its fields null and lists it as missing", async () => {
    const { fetch } = fixtures({ "https://api.npmjs.org/downloads/point/last-week/demo": () => new Response("no", { status: 500 }) })
    const { facts } = await run(demo, { fetch })
    expect(facts?.downloads).toBeNull()
    expect(facts?.missing).toEqual(["download stats: 500 api.npmjs.org"])
    expect(facts?.latest?.version).toBe("2.0.0")
    expect(facts?.dependents).toBe(42)
  })

  test("falls back to deps.dev project counts when GitHub refuses", async () => {
    const { fetch } = fixtures({ "https://api.github.com/repos/acme/demo": () => new Response("", { status: 403 }) })
    const { facts } = await run(demo, { fetch })
    expect(facts?.repo).toMatchObject({ stars: 900, openIssues: 12, openPullRequests: 3, contributors: 25 })
    expect(facts?.missing).toEqual(["github repo: 403 api.github.com"])
  })

  test("a package no source knows yields only missing entries", async () => {
    const { fetch } = fixtures()
    const { facts } = await run({ ecosystem: "npm", packages: [{ name: "ghost" }] }, { fetch })
    expect(facts?.latest).toBeNull()
    expect(facts?.gates).toEqual({ unpatchedCve: null, licenceNotAllowed: null, failed: [] })
    expect(facts?.missing.length).toBeGreaterThan(0)
  })

  test("fails the licence gate for a licence outside the allowlist", async () => {
    const { fetch } = fixtures({
      "https://api.deps.dev/v3/systems/NPM/packages/demo/versions/2.0.0": {
        licenses: ["GPL-3.0-only"],
        relatedProjects: [],
      },
    })
    const { facts } = await run(demo, { fetch })
    expect(facts?.gates).toEqual({ unpatchedCve: false, licenceNotAllowed: true, failed: ["licence-not-allowed"] })
  })

  test("fails the CVE gate when the latest version still has an advisory", async () => {
    const { fetch } = fixtures({}, { latest: ["GHSA-live"], requested: ["GHSA-live", "GHSA-old"] })
    const { facts } = await run(demo, { fetch })
    expect(facts?.vulnerabilities).toEqual({ latest: ["GHSA-live"], requested: ["GHSA-live", "GHSA-old"] })
    expect(facts?.gates).toEqual({ unpatchedCve: true, licenceNotAllowed: false, failed: ["unpatched-cve"] })
  })

  test("leaves the CVE gate unknown when OSV is down", async () => {
    const { fetch } = fixtures()
    const down = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes("osv.dev") ? new Response("", { status: 503 }) : fetch(url, init)) as unknown as typeof fetch
    const { facts } = await run(demo, { fetch: down })
    expect(facts?.gates.unpatchedCve).toBeNull()
    expect(facts?.missing).toEqual(["osv: 503 api.osv.dev"])
  })

  test("rejects an unknown ecosystem and too many packages without any request", async () => {
    const { fetch, calls } = fixtures()
    const bad = await run({ ecosystem: "gem", packages: [{ name: "x" }] }, { fetch })
    expect(bad.result.metadata.ok).toBe(false)
    const many = await run({ ecosystem: "npm", packages: Array.from({ length: 7 }, (_, i) => ({ name: `p${i}` })) }, { fetch })
    expect(many.result.content).toContain("1 to 6")
    expect(calls.urls).toEqual([])
  })
})

describe("licenceBlocked", () => {
  test.each([
    [["MIT"], false],
    [["Apache-2.0", "BSD-3-Clause"], false],
    [["MIT OR GPL-3.0-only"], false],
    [["MIT AND GPL-3.0-only"], true],
    [["LGPL-3.0-or-later"], false],
    [["GPL-3.0-only"], true],
    [["AGPL-3.0-only"], true],
    [["non-standard"], true],
    [[], null],
    [null, null],
  ])("%j -> %p", (licences, expected) => {
    expect(licenceBlocked(licences)).toBe(expected)
  })
})
