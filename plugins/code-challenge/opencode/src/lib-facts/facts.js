import { licenceBlocked } from "./licence.ts";
import { canonicalName, depsDevDependencies, depsDevDependents, depsDevProject, depsDevVersion, depsDevVersions, downloadSources, githubFacts, githubSlug, osvVulnerabilities, registryFacts, } from "./sources.ts";
const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;
/** Releases in the last 12 and 24 months and the months since the newest, from deps.dev publish dates. */
export function cadence(versions, now) {
    const times = versions.flatMap((v) => (v.publishedAt ? [Date.parse(v.publishedAt)] : [])).filter(Number.isFinite);
    if (times.length === 0)
        return null;
    const within = (months) => times.filter((t) => now.getTime() - t <= months * MONTH_MS).length;
    return {
        last12Months: within(12),
        last24Months: within(24),
        monthsSinceLast: Math.round(((now.getTime() - Math.max(...times)) / MONTH_MS) * 10) / 10,
    };
}
/** The default version, else the newest published. */
export function pickLatest(versions) {
    return (versions.find((v) => v.isDefault) ??
        [...versions].sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? "")).at(0));
}
/** Gather every fact for one package. A failed source adds a `missing` entry and leaves its fields `null`. */
export async function collectPackage(ecosystem, request, collector) {
    const { http } = collector;
    const name = canonicalName(ecosystem, request.name);
    const requested = request.version ?? null;
    const missing = [];
    const attempt = async (source, run) => {
        try {
            return await run();
        }
        catch (error) {
            missing.push(`${source}: ${error instanceof Error ? error.message : "failed"}`);
            return undefined;
        }
    };
    const versions = await attempt("deps.dev packages", () => depsDevVersions(http, ecosystem, name));
    const newest = versions ? pickLatest(versions) : undefined;
    // Registry metadata describes one version. Ask for the version deps.dev calls latest, and drop a
    // reply for any other, so no field (the licence gate included) is read from a different release.
    let registry = await attempt("registry", () => registryFacts(http, ecosystem, name, newest?.version || null));
    if (registry && newest?.version && registry.version !== newest.version) {
        missing.push(`registry: describes ${registry.version ?? "no version"}, not ${newest.version}`);
        registry = undefined;
    }
    const version = newest?.version || registry?.version || null;
    const publishedAt = newest?.publishedAt ?? registry?.publishedAt ?? null;
    if (version === null) {
        return {
            ...blank(request.name, requested),
            missing: [...missing, "latest version unknown: nothing else could be looked up"],
            gates: { unpatchedCve: null, licenceNotAllowed: null, failed: [] },
        };
    }
    const [detail, dependencies, dependents, downloads, osv] = await Promise.all([
        attempt("deps.dev version", () => depsDevVersion(http, ecosystem, name, version)),
        attempt("deps.dev dependencies", () => depsDevDependencies(http, ecosystem, name, version)),
        attempt("deps.dev dependents", () => depsDevDependents(http, ecosystem, name, version)),
        collectDownloads(http, ecosystem, name, registry?.downloads ?? null, attempt),
        attempt("osv", () => osvVulnerabilities(http, ecosystem, name, requested ? [version, requested] : [version])),
    ]);
    const slug = githubSlug(detail?.repo ?? registry?.repo ?? null);
    const repo = slug ? await repoFacts(slug, collector, attempt, missing) : null;
    const licence = detail && detail.licences.length > 0 ? detail.licences : registry?.licence ? [registry.licence] : null;
    const vulnerabilities = osv ? { latest: osv[0] ?? [], requested: requested ? (osv[1] ?? []) : null } : null;
    const unpatchedCve = vulnerabilities ? vulnerabilities.latest.length > 0 : null;
    const licenceNotAllowed = licenceBlocked(licence);
    return {
        name: request.name,
        requestedVersion: requested,
        latest: { version, publishedAt },
        releases: versions ? cadence(versions, collector.now()) : null,
        deprecated: deprecation([detail?.isDeprecated, newest?.isDeprecated, registry?.deprecated]),
        yanked: registry?.yanked ?? null,
        licence,
        downloads: downloads ?? null,
        dependents: dependents ?? null,
        repo: repo && slug ? { url: `https://github.com/${slug.owner}/${slug.repo}`, ...repo } : null,
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
    };
}
/** Deprecated if any source says so, not deprecated if one says so and none disagrees, unknown if none can say. */
export function deprecation(answers) {
    const known = answers.filter((a) => typeof a === "boolean");
    return known.length === 0 ? null : known.some(Boolean);
}
/** Each download call runs and fails on its own; the figures that arrived are kept. */
async function collectDownloads(http, ecosystem, name, fromRegistry, attempt) {
    const parts = await Promise.all(downloadSources(http, ecosystem, name).map((s) => attempt(s.label, s.run)));
    const got = parts.filter((p) => p !== undefined);
    if (got.length === 0 && fromRegistry === null)
        return null;
    return Object.assign({ lastWeek: null, lastMonth: null, last90Days: null }, fromRegistry, ...got);
}
const sizeOf = (r) => r.unpackedBytes === null && r.downloadBytes === null ? null : { unpackedBytes: r.unpackedBytes, downloadBytes: r.downloadBytes };
async function repoFacts(slug, collector, attempt, missing) {
    const github = await githubFacts(collector.http, slug, await collector.token());
    missing.push(...github.failures);
    const facts = github.facts;
    if (facts.stars !== null && facts.openIssues !== null)
        return facts;
    // GitHub gave no counts. deps.dev mirrors stars and GitHub's open-issue count, which includes pull
    // requests; without the pull request count that number cannot be turned into an issue count.
    const fallback = await attempt("deps.dev project", () => depsDevProject(collector.http, slug));
    const openIssues = facts.openIssues ??
        (fallback?.openIssues != null && facts.openPullRequests !== null
            ? Math.max(0, fallback.openIssues - facts.openPullRequests)
            : null);
    return { ...facts, stars: facts.stars ?? fallback?.stars ?? null, openIssues };
}
function blank(name, requestedVersion) {
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
    };
}
