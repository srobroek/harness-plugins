import type { Http } from "./http.ts"
import { licenceBlocked } from "./licence.ts"
import {
  canonicalName,
  depsDevDependencies,
  depsDevDependents,
  depsDevProject,
  depsDevVersion,
  depsDevVersions,
  downloadStats,
  githubFacts,
  githubSlug,
  osvVulnerabilities,
  type RegistryFacts,
  registryFacts,
  type VersionEntry,
} from "./sources.ts"
import type { Ecosystem, PackageFacts, PackageRequest } from "./types.ts"

export type Collector = { http: Http; token: () => Promise<string | undefined>; now: () => Date }

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000

/** Releases in the last 12 and 24 months and the months since the newest, from deps.dev publish dates. */
export function cadence(versions: readonly VersionEntry[], now: Date): PackageFacts["releases"] {
  const times = versions.flatMap((v) => (v.publishedAt ? [Date.parse(v.publishedAt)] : [])).filter(Number.isFinite)
  if (times.length === 0) return null
  const within = (months: number) => times.filter((t) => now.getTime() - t <= months * MONTH_MS).length
  return {
    last12Months: within(12),
    last24Months: within(24),
    monthsSinceLast: Math.round(((now.getTime() - Math.max(...times)) / MONTH_MS) * 10) / 10,
  }
}

/** The default version, else the newest published. */
export function pickLatest(versions: readonly VersionEntry[]): VersionEntry | undefined {
  return (
    versions.find((v) => v.isDefault) ??
    [...versions].sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? "")).at(0)
  )
}

/** Gather every fact for one package. A failed source adds a `missing` entry and leaves its fields `null`. */
export async function collectPackage(
  ecosystem: Ecosystem,
  request: PackageRequest,
  collector: Collector,
): Promise<PackageFacts> {
  const { http } = collector
  const name = canonicalName(ecosystem, request.name)
  const requested = request.version ?? null
  const missing: string[] = []
  const attempt = async <T>(source: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run()
    } catch (error) {
      missing.push(`${source}: ${error instanceof Error ? error.message : "failed"}`)
      return undefined
    }
  }

  const [versions, registry] = await Promise.all([
    attempt("deps.dev packages", () => depsDevVersions(http, ecosystem, name)),
    attempt("registry", () => registryFacts(http, ecosystem, name)),
  ])
  const newest = versions ? pickLatest(versions) : undefined
  const version = newest?.version || registry?.version || null
  const publishedAt = newest?.publishedAt ?? registry?.publishedAt ?? null

  if (version === null) {
    return {
      ...blank(request.name, requested),
      missing: [...missing, "latest version unknown: nothing else could be looked up"],
      gates: { unpatchedCve: null, licenceNotAllowed: null, failed: [] },
    }
  }

  const [detail, dependencies, dependents, stats, osv] = await Promise.all([
    attempt("deps.dev version", () => depsDevVersion(http, ecosystem, name, version)),
    attempt("deps.dev dependencies", () => depsDevDependencies(http, ecosystem, name, version)),
    attempt("deps.dev dependents", () => depsDevDependents(http, ecosystem, name, version)),
    attempt("download stats", () => downloadStats(http, ecosystem, name)),
    attempt("osv", () => osvVulnerabilities(http, ecosystem, name, requested ? [version, requested] : [version])),
  ])

  const repoUrl = detail?.repo ?? registry?.repo ?? null
  const slug = githubSlug(repoUrl)
  const repo = slug ? await repoFacts(slug, collector, attempt, missing) : null

  const licence = detail && detail.licences.length > 0 ? detail.licences : registry?.licence ? [registry.licence] : null
  const vulnerabilities = osv ? { latest: osv[0] ?? [], requested: requested ? (osv[1] ?? []) : null } : null
  const unpatchedCve = vulnerabilities ? vulnerabilities.latest.length > 0 : null
  const licenceNotAllowed = licenceBlocked(licence)
  const downloads = stats ?? registry?.downloads ?? null

  return {
    name: request.name,
    requestedVersion: requested,
    latest: { version, publishedAt },
    releases: versions ? cadence(versions, collector.now()) : null,
    deprecated: newest ? newest.isDeprecated || registry?.deprecated === true : (registry?.deprecated ?? null),
    yanked: registry?.yanked ?? null,
    licence,
    downloads,
    dependents: dependents ?? null,
    repo: repo && repoUrl ? { url: repoUrl, ...repo } : null,
    dependencies: dependencies ?? null,
    size: registry ? sizeOf(registry) : null,
    types: registry?.types ?? null,
    modules: registry?.modules ?? null,
    vulnerabilities,
    gates: {
      unpatchedCve,
      licenceNotAllowed,
      failed: [...(unpatchedCve ? ["unpatched-cve"] : []), ...(licenceNotAllowed ? ["licence-not-allowed"] : [])],
    },
    missing,
  }
}

const sizeOf = (r: RegistryFacts) =>
  r.unpackedBytes === null && r.downloadBytes === null ? null : { unpackedBytes: r.unpackedBytes, downloadBytes: r.downloadBytes }

async function repoFacts(
  slug: string,
  collector: Collector,
  attempt: <T>(source: string, run: () => Promise<T>) => Promise<T | undefined>,
  missing: string[],
): Promise<Omit<NonNullable<PackageFacts["repo"]>, "url">> {
  const token = await collector.token()
  const github = await githubFacts(collector.http, slug, token)
  missing.push(...github.failures)
  const facts = github.facts
  if (facts.stars !== null && facts.openIssues !== null) return facts
  // GitHub gave no counts: deps.dev mirrors stars and open issues (issues and PRs together).
  const fallback = await attempt("deps.dev project", () => depsDevProject(collector.http, `github.com/${slug}`))
  return { ...facts, stars: facts.stars ?? fallback?.stars ?? null, openIssues: facts.openIssues ?? fallback?.openIssues ?? null }
}

function blank(name: string, requestedVersion: string | null): Omit<PackageFacts, "gates" | "missing"> {
  return {
    name,
    requestedVersion,
    latest: null,
    releases: null,
    deprecated: null,
    yanked: null,
    licence: null,
    downloads: null,
    dependents: null,
    repo: null,
    dependencies: null,
    size: null,
    types: null,
    modules: null,
    vulnerabilities: null,
  }
}
