import type { Http } from "./http.ts"
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

export type VersionEntry = { version: string; publishedAt: string | null; isDefault: boolean; isDeprecated: boolean }

export async function depsDevVersions(http: Http, ecosystem: Ecosystem, name: string): Promise<VersionEntry[]> {
  const { body } = await http.get(`${DEPS_DEV}/v3/systems/${DEPS_SYSTEM[ecosystem]}/packages/${encodeURIComponent(name)}`)
  return arr(obj(body).versions).map((entry) => {
    const v = obj(entry)
    return {
      version: str(obj(v.versionKey).version) ?? "",
      publishedAt: str(v.publishedAt),
      isDefault: v.isDefault === true,
      isDeprecated: v.isDeprecated === true,
    }
  })
}

export type DepsDevVersion = { licences: string[]; repo: string | null }

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
  }
}

const versionUrl = (ecosystem: Ecosystem, name: string, version: string): string =>
  `${DEPS_DEV}/v3/systems/${DEPS_SYSTEM[ecosystem]}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`

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

export async function depsDevProject(http: Http, repo: string) {
  const { body } = await http.get(`${DEPS_DEV}/v3/projects/${encodeURIComponent(repo)}`)
  const data = obj(body)
  return { stars: num(data.starsCount), openIssues: num(data.openIssuesCount) }
}

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
  downloads: { lastWeek: number | null; lastMonth: number | null; last90Days: number | null } | null
}

const EMPTY: RegistryFacts = {
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

export function cratesFacts(doc: Json): Partial<RegistryFacts> {
  const crate = obj(doc.crate)
  const version = str(crate.max_stable_version) ?? str(crate.max_version)
  const entry = arr(doc.versions)
    .map(obj)
    .find((v) => v.num === version)
  return {
    version,
    publishedAt: str(entry?.created_at),
    licence: str(entry?.license),
    yanked: bool(entry?.yanked),
    downloadBytes: num(entry?.crate_size),
    repo: str(crate.repository),
    downloads: { lastWeek: null, lastMonth: null, last90Days: num(crate.recent_downloads) },
  }
}

export async function registryFacts(http: Http, ecosystem: Ecosystem, name: string): Promise<RegistryFacts> {
  const id = encodeURIComponent(name)
  switch (ecosystem) {
    case "npm":
      return { ...EMPTY, ...npmFacts(obj((await http.get(`https://registry.npmjs.org/${id}/latest`)).body)) }
    case "pypi":
      return { ...EMPTY, ...pypiFacts(obj((await http.get(`https://pypi.org/pypi/${id}/json`)).body)) }
    case "crates":
      return { ...EMPTY, ...cratesFacts(obj((await http.get(`https://crates.io/api/v1/crates/${id}`)).body)) }
    case "go": {
      const latest = obj((await http.get(`https://proxy.golang.org/${goEscape(name)}/@latest`)).body)
      return { ...EMPTY, version: str(latest.Version), publishedAt: str(latest.Time) }
    }
  }
}

/** Weekly and monthly downloads from the registry's stats service; crates reports them in its own document, Go has none. */
export async function downloadStats(http: Http, ecosystem: Ecosystem, name: string): Promise<RegistryFacts["downloads"]> {
  if (ecosystem === "npm") {
    const id = encodeURIComponent(name).replace("%40", "@")
    const [week, month] = await Promise.all(
      ["last-week", "last-month"].map(async (period) =>
        num(obj((await http.get(`https://api.npmjs.org/downloads/point/${period}/${id}`)).body).downloads),
      ),
    )
    return { lastWeek: week ?? null, lastMonth: month ?? null, last90Days: null }
  }
  if (ecosystem === "pypi") {
    const data = obj(obj((await http.get(`https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`)).body).data)
    return { lastWeek: num(data.last_week), lastMonth: num(data.last_month), last90Days: null }
  }
  return null
}

/** One OSV batch for the latest version and, when asked, the requested one. Never cached. */
export async function osvVulnerabilities(
  http: Http,
  ecosystem: Ecosystem,
  name: string,
  versions: readonly string[],
): Promise<string[][]> {
  const queries = versions.map((version) => ({ package: { name, ecosystem: OSV_ECOSYSTEM[ecosystem] }, version }))
  const { body } = await http.post(OSV, { queries })
  const results = arr(obj(body).results)
  return versions.map((_, i) =>
    arr(obj(results[i]).vulns)
      .map((v) => str(obj(v).id))
      .filter((id): id is string => id !== null),
  )
}

export type GithubFacts = {
  stars: number | null
  openIssues: number | null
  openPullRequests: number | null
  lastCommit: string | null
  contributors: number | null
  archived: boolean | null
}

/** `owner/repo` from a repository URL, or `null` when it is not on GitHub. */
export function githubSlug(url: string | null): string | null {
  const match = url?.match(/github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[/#?].*)?$/i)
  return match ? `${match[1]}/${match[2]}` : null
}

/** The page count of a `Link: <...&page=N>; rel="last"` header: with `per_page=1`, the item count. */
export function lastPage(link: string | null): number | null {
  const match = link?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/)
  return match ? Number(match[1]) : null
}

/** Repo metrics from the GitHub REST API. Each call degrades alone; `failures` lists the ones that failed. */
export async function githubFacts(http: Http, slug: string, token: string | undefined) {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" }
  if (token) headers.authorization = `Bearer ${token}`
  const failures: string[] = []
  const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run()
    } catch (error) {
      failures.push(`github ${label}: ${error instanceof Error ? error.message : "failed"}`)
      return undefined
    }
  }
  const [repo, pulls, commits, contributors] = await Promise.all([
    attempt("repo", () => http.get(`${GITHUB}/repos/${slug}`, headers)),
    attempt("pulls", () => http.get(`${GITHUB}/search/issues?q=${encodeURIComponent(`repo:${slug} type:pr state:open`)}&per_page=1`, headers)),
    attempt("commits", () => http.get(`${GITHUB}/repos/${slug}/commits?per_page=1`, headers)),
    attempt("contributors", () => http.get(`${GITHUB}/repos/${slug}/contributors?per_page=1&anon=true`, headers)),
  ])
  const meta = obj(repo?.body)
  const openPullRequests = num(obj(pulls?.body).total_count)
  const openAndPulls = num(meta.open_issues_count)
  const firstCommit = obj(arr(commits?.body)[0])
  const facts: GithubFacts = {
    stars: num(meta.stargazers_count),
    openIssues: openAndPulls !== null && openPullRequests !== null ? Math.max(0, openAndPulls - openPullRequests) : null,
    openPullRequests,
    lastCommit: str(obj(obj(firstCommit.commit).committer).date),
    contributors: contributors ? (lastPage(contributors.link) ?? arr(contributors.body).length) : null,
    archived: bool(meta.archived),
  }
  return { facts, failures }
}
