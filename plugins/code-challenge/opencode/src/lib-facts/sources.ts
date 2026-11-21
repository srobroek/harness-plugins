import type { Http, Projection } from "./http.ts"
import type { Ecosystem } from "./types.ts"

export const DEPS_DEV = "https://api.deps.dev"
export const OSV = "https://api.osv.dev/v1/querybatch"
export const GITHUB = "https://api.github.com"

export const DEPS_SYSTEM: Record<Ecosystem, string> = { npm: "NPM", pypi: "PYPI", crates: "CARGO", go: "GO" }
const OSV_ECOSYSTEM: Record<Ecosystem, string> = { npm: "npm", pypi: "PyPI", crates: "crates.io", go: "Go" }

type Json = Record<string, unknown>
const obj = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {})
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)
const num = (value: unknown): number | null => (typeof value === "number" ? value : null)
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null)

/** PyPI names compare normalised (PEP 503); deps.dev and OSV expect that form. */
export function canonicalName(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name
}

/** The module proxy lower-cases paths and escapes each capital as `!` plus the letter. */
const goEscape = (path: string): string => path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)

/** An npm registry path: a scope keeps its `@` and encodes the slash (`@scope%2Fname`). */
const npmPath = (name: string): string => encodeURIComponent(name).replace(/^%40/, "@")

export type VersionEntry = { version: string; publishedAt: string | null; isDefault: boolean; isDeprecated: boolean | null }

export async function depsDevVersions(http: Http, ecosystem: Ecosystem, name: string): Promise<VersionEntry[]> {
  const { body } = await http.get(`${DEPS_DEV}/v3/systems/${DEPS_SYSTEM[ecosystem]}/packages/${encodeURIComponent(name)}`)
  return arr(obj(body).versions).map((entry) => {
    const v = obj(entry)
    return {
      version: str(obj(v.versionKey).version) ?? "",
      publishedAt: str(v.publishedAt),
      isDefault: v.isDefault === true,
      isDeprecated: bool(v.isDeprecated),
    }
  })
}

export type DepsDevVersion = { licences: string[]; repo: string | null; isDeprecated: boolean | null }

const versionUrl = (ecosystem: Ecosystem, name: string, version: string): string =>
  `${DEPS_DEV}/v3/systems/${DEPS_SYSTEM[ecosystem]}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`

export async function depsDevVersion(http: Http, ecosystem: Ecosystem, name: string, version: string): Promise<DepsDevVersion> {
  const { body } = await http.get(versionUrl(ecosystem, name, version))
  const data = obj(body)
  const repoLink = arr(data.links)
    .map(obj)
    .find((link) => link.label === "SOURCE_REPO")
  const related = arr(data.relatedProjects)
    .map((p) => str(obj(obj(p).projectKey).id))
    .find((id) => id?.startsWith("github.com/"))
  return {
    licences: arr(data.licenses).filter((l): l is string => typeof l === "string"),
    repo: related ?? str(repoLink?.url),
    isDeprecated: bool(data.isDeprecated),
  }
}

export async function depsDevDependencies(http: Http, ecosystem: Ecosystem, name: string, version: string) {
  const { body } = await http.get(`${versionUrl(ecosystem, name, version)}:dependencies`)
  const nodes = arr(obj(body).nodes).map(obj)
  return {
    direct: nodes.filter((n) => n.relation === "DIRECT").length,
    transitive: nodes.filter((n) => n.relation === "INDIRECT").length,
  }
}

export async function depsDevDependents(http: Http, ecosystem: Ecosystem, name: string, version: string): Promise<number | null> {
  const { body } = await http.get(`${versionUrl(ecosystem, name, version).replace("/v3/", "/v3alpha/")}:dependents`)
  return num(obj(body).dependentCount)
}

export async function depsDevProject(http: Http, slug: GithubSlug) {
  const { body } = await http.get(`${DEPS_DEV}/v3/projects/${encodeURIComponent(`github.com/${slug.owner}/${slug.repo}`)}`)
  const data = obj(body)
  return { stars: num(data.starsCount), openIssues: num(data.openIssuesCount) }
}

export type Downloads = { lastWeek: number | null; lastMonth: number | null; last90Days: number | null }

export type RegistryFacts = {
  version: string | null
  publishedAt: string | null
  licence: string | null
  deprecated: boolean | null
  yanked: boolean | null
  unpackedBytes: number | null
  downloadBytes: number | null
  types: boolean | null
  modules: "esm" | "cjs" | "dual" | null
  repo: string | null
  downloads: Downloads | null
}

export const EMPTY_REGISTRY: RegistryFacts = {
  version: null,
  publishedAt: null,
  licence: null,
  deprecated: null,
  yanked: null,
  unpackedBytes: null,
  downloadBytes: null,
  types: null,
  modules: null,
  repo: null,
  downloads: null,
}

/** ESM/CJS from the manifest. A heuristic: `exports` conditions and the `type` field decide. */
export function moduleFormat(manifest: Json): "esm" | "cjs" | "dual" {
  const exportsText = JSON.stringify(manifest.exports ?? "")
  const esm = manifest.type === "module" || manifest.module !== undefined || /"(import|module)"/.test(exportsText)
  const cjs = manifest.type !== "module" || /"require"/.test(exportsText)
  return esm && cjs ? "dual" : esm ? "esm" : "cjs"
}

export function npmFacts(manifest: Json): Partial<RegistryFacts> {
  const dist = obj(manifest.dist)
  const license = manifest.license
  return {
    version: str(manifest.version),
    licence: typeof license === "string" ? license : str(obj(license).type),
    deprecated: typeof manifest.deprecated === "string",
    unpackedBytes: num(dist.unpackedSize),
    types: manifest.types !== undefined || manifest.typings !== undefined || /"types"/.test(JSON.stringify(manifest.exports ?? "")),
    modules: moduleFormat(manifest),
    repo: str(obj(manifest.repository).url) ?? str(manifest.repository),
  }
}

/** A PyPI per-version document (`/pypi/{name}/{version}/json`), or the latest one. */
export function pypiFacts(doc: Json): Partial<RegistryFacts> {
  const info = obj(doc.info)
  const files = arr(doc.urls).map(obj)
  const classifiers = arr(info.classifiers)
  const licence = str(info.license_expression) ?? str(info.license)
  return {
    version: str(info.version),
    publishedAt: str(files[0]?.upload_time_iso_8601),
    licence: licence && licence.length <= 64 ? licence : null,
    yanked: info.yanked === true || files.some((f) => f.yanked === true),
    downloadBytes: files.reduce<number | null>((sum, f) => (num(f.size) === null ? sum : (sum ?? 0) + (num(f.size) ?? 0)), null),
    types: classifiers.includes("Typing :: Typed"),
  }
}

/** The crates.io document; `version` picks the entry whose licence, yank flag and size are reported. */
export function cratesFacts(doc: Json, version: string | null): Partial<RegistryFacts> {
  const crate = obj(doc.crate)
  const wanted = version ?? str(crate.max_stable_version) ?? str(crate.max_version)
  const entry = arr(doc.versions)
    .map(obj)
    .find((v) => v.num === wanted)
  return {
    version: entry ? wanted : null,
    publishedAt: str(entry?.created_at),
    licence: str(entry?.license),
    yanked: bool(entry?.yanked),
    downloadBytes: num(entry?.crate_size),
    repo: str(crate.repository),
    downloads: { lastWeek: null, lastMonth: null, last90Days: num(crate.recent_downloads) },
  }
}

/**
 * Registry metadata for `version`, or for the registry's latest when `version` is `null`.
 * The reply names the version it describes, so the caller can discard a mismatch.
 */
export async function registryFacts(http: Http, ecosystem: Ecosystem, name: string, version: string | null): Promise<RegistryFacts> {
  switch (ecosystem) {
    case "npm": {
      const url = `https://registry.npmjs.org/${npmPath(name)}/${version ? encodeURIComponent(version) : "latest"}`
      return { ...EMPTY_REGISTRY, ...npmFacts(obj((await http.get(url)).body)) }
    }
    case "pypi": {
      const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/${version ? `${encodeURIComponent(version)}/` : ""}json`
      return { ...EMPTY_REGISTRY, ...pypiFacts(obj((await http.get(url)).body)) }
    }
    case "crates": {
      const doc = obj((await http.get(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`)).body)
      return { ...EMPTY_REGISTRY, ...cratesFacts(doc, version) }
    }
    case "go": {
      const tail = version ? `@v/${goEscape(version)}.info` : "@latest"
      const info = obj((await http.get(`https://proxy.golang.org/${goEscape(name)}/${tail}`)).body)
      return { ...EMPTY_REGISTRY, version: str(info.Version), publishedAt: str(info.Time) }
    }
  }
}

/** One download figure group and the call that gets it; calls fail independently. */
export type DownloadSource = { label: string; run: () => Promise<Partial<Downloads>> }

/** Weekly and monthly downloads: two npm calls, one pypistats call; crates reports in its own document, Go has none. */
export function downloadSources(http: Http, ecosystem: Ecosystem, name: string): DownloadSource[] {
  if (ecosystem === "npm") {
    const period = (label: "last-week" | "last-month", key: "lastWeek" | "lastMonth"): DownloadSource => ({
      label: `npm downloads ${label}`,
      run: async () => ({
        [key]: num(obj((await http.get(`https://api.npmjs.org/downloads/point/${label}/${npmPath(name)}`)).body).downloads),
      }),
    })
    return [period("last-week", "lastWeek"), period("last-month", "lastMonth")]
  }
  if (ecosystem === "pypi")
    return [
      {
        label: "pypistats",
        run: async () => {
          const data = obj(obj((await http.get(`https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`)).body).data)
          return { lastWeek: num(data.last_week), lastMonth: num(data.last_month) }
        },
      },
    ]
  return []
}

/**
 * One OSV batch for the given versions, never cached. The reply must hold one result per query
 * and no continuation token; anything else throws, so a truncated answer never reads as "clean".
 */
export async function osvVulnerabilities(
  http: Http,
  ecosystem: Ecosystem,
  name: string,
  versions: readonly string[],
): Promise<string[][]> {
  const queries = versions.map((version) => ({ package: { name, ecosystem: OSV_ECOSYSTEM[ecosystem] }, version }))
  const { body } = await http.post(OSV, { queries })
  const results = obj(body).results
  if (!Array.isArray(results) || results.length !== versions.length) throw new Error("malformed response api.osv.dev")
  return results.map((result) => {
    // A null, scalar or array entry is not an answer: it must never pass as "no vulnerabilities".
    if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("malformed response api.osv.dev")
    const entry = obj(result)
    if (entry.next_page_token !== undefined) throw new Error("truncated response api.osv.dev")
    if (entry.vulns === undefined) return []
    if (!Array.isArray(entry.vulns)) throw new Error("malformed response api.osv.dev")
    return entry.vulns.map((v) => {
      const id = str(obj(v).id)
      if (id === null) throw new Error("malformed response api.osv.dev")
      return id
    })
  })
}

export type GithubFacts = {
  stars: number | null
  openIssues: number | null
  openPullRequests: number | null
  lastCommit: string | null
  contributors: number | null
  archived: boolean | null
}

export type GithubSlug = { owner: string; repo: string }

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const TAIL = String.raw`(?:\.git)?\/?(?:(?:#|\/(?:tree|blob)\/)[^\s\\]*)?$`
const FORMS = [
  new RegExp(String.raw`^(?:git\+)?https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)${TAIL}`, "i"),
  new RegExp(String.raw`^git:\/\/github\.com\/([^/]+)\/([^/#?]+?)${TAIL}`, "i"),
  new RegExp(String.raw`^(?:git\+)?ssh:\/\/git@github\.com\/([^/]+)\/([^/#?]+?)${TAIL}`, "i"),
  new RegExp(String.raw`^git@github\.com:([^/]+)\/([^/#?]+?)${TAIL}`, "i"),
  new RegExp(String.raw`^github\.com\/([^/]+)\/([^/#?]+?)${TAIL}`, "i"),
  new RegExp(String.raw`^github:([^/]+)\/([^/#?]+?)${TAIL}`, "i"),
]

/**
 * `owner` and `repo` from a recognised github.com repository URL form, or `null`. Publisher
 * metadata is untrusted: the whole string must match a known form, each part must use GitHub's
 * own charset, and dot segments are refused, so nothing here can climb out of `/repos/{o}/{r}`.
 */
export function githubSlug(url: string | null): GithubSlug | null {
  if (url === null) return null
  for (const form of FORMS) {
    const match = form.exec(url.trim())
    const owner = match?.[1]
    const repo = match?.[2]
    if (owner === undefined || repo === undefined) continue
    if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null
    return { owner, repo }
  }
  return null
}

/** The page count of a `Link: <...&page=N>; rel="last"` header: with `per_page=1`, the item count. */
export function lastPage(link: string | null): number | null {
  const match = link?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/)
  return match ? Number(match[1]) : null
}

const nullable = (value: unknown, type: "number" | "string" | "boolean"): boolean => value === null || typeof value === type
const hasOnly = (value: unknown, keys: string[]): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const found = Object.keys(value)
  return found.length === keys.length && keys.every((key) => found.includes(key))
}

/** Repo metrics from the GitHub REST API. Each call degrades alone; `failures` lists the ones that failed. */
export async function githubFacts(http: Http, slug: GithubSlug, token: string | undefined) {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" }
  if (token) headers.authorization = `Bearer ${token}`
  const base = `${GITHUB}/repos/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.repo)}`
  const failures: string[] = []
  const attempt = async <T>(label: string, url: string, projection: Projection): Promise<T | undefined> => {
    try {
      return (await http.get(url, headers, projection)).body as T
    } catch (error) {
      failures.push(`github ${label}: ${error instanceof Error ? error.message : "failed"}`)
      return undefined
    }
  }
  // Each projection keeps only the public fact it needs, so the cache never holds a whole authenticated
  // reply, and `valid` rejects a cached value of any other shape.
  const [repo, pulls, commit, contributors] = await Promise.all([
    attempt<{ stars: number | null; openAndPulls: number | null; archived: boolean | null }>("repo", base, {
      project: ({ body }) => ({
        stars: num(obj(body).stargazers_count),
        openAndPulls: num(obj(body).open_issues_count),
        archived: bool(obj(body).archived),
      }),
      valid: (v) =>
        hasOnly(v, ["stars", "openAndPulls", "archived"]) &&
        nullable(obj(v).stars, "number") &&
        nullable(obj(v).openAndPulls, "number") &&
        nullable(obj(v).archived, "boolean"),
    }),
    attempt<number | null>(
      "pulls",
      `${GITHUB}/search/issues?q=${encodeURIComponent(`repo:${slug.owner}/${slug.repo} type:pr state:open`)}&per_page=1`,
      { project: ({ body }) => num(obj(body).total_count), valid: (v) => nullable(v, "number") },
    ),
    attempt<string | null>("commits", `${base}/commits?per_page=1`, {
      project: ({ body }) => str(obj(obj(obj(arr(body)[0]).commit).committer).date),
      valid: (v) => nullable(v, "string"),
    }),
    attempt<number | null>("contributors", `${base}/contributors?per_page=1&anon=true`, {
      project: ({ body, link }) => lastPage(link) ?? arr(body).length,
      valid: (v) => nullable(v, "number"),
    }),
  ])
  const openPullRequests = pulls ?? null
  const facts: GithubFacts = {
    stars: repo?.stars ?? null,
    openIssues:
      repo?.openAndPulls != null && openPullRequests !== null ? Math.max(0, repo.openAndPulls - openPullRequests) : null,
    openPullRequests,
    lastCommit: commit ?? null,
    contributors: contributors ?? null,
    archived: repo?.archived ?? null,
  }
  return { facts, failures }
}
