/** The shape `challenge_lib_facts` returns: facts only, no judgement. `null` marks a fact no source gave. */

export const ECOSYSTEMS = ["npm", "pypi", "crates", "go"] as const
export type Ecosystem = (typeof ECOSYSTEMS)[number]

export type PackageRequest = { name: string; version?: string }

export type PackageFacts = {
  name: string
  requestedVersion: string | null
  latest: { version: string; publishedAt: string | null } | null
  releases: { last12Months: number; last24Months: number; monthsSinceLast: number | null } | null
  deprecated: boolean | null
  yanked: boolean | null
  /** SPDX ids of the latest version. */
  licence: string[] | null
  downloads: { lastWeek: number | null; lastMonth: number | null; last90Days: number | null } | null
  dependents: number | null
  repo: {
    url: string
    stars: number | null
    openIssues: number | null
    openPullRequests: number | null
    lastCommit: string | null
    contributors: number | null
    archived: boolean | null
  } | null
  dependencies: { direct: number; transitive: number } | null
  size: { unpackedBytes: number | null; downloadBytes: number | null } | null
  /** Bundled type declarations: npm `types` or `exports.types`, PyPI `Typing :: Typed`. `null` where it does not apply. */
  types: boolean | null
  /** npm only, read from `type`, `module`, `main` and `exports`. */
  modules: "esm" | "cjs" | "dual" | null
  /** OSV ids, fetched fresh on every call. `requested` is `null` when no version was asked for. */
  vulnerabilities: { latest: string[]; requested: string[] | null } | null
  gates: {
    /** The latest version still carries an OSV advisory. */
    unpatchedCve: boolean | null
    /** The licence is outside the permissive and weak-copyleft allowlist. */
    licenceNotAllowed: boolean | null
    failed: string[]
  }
  /** Each source or field group that failed, as `<source>: <reason>`. */
  missing: string[]
}

export type LibFacts = { ecosystem: Ecosystem; fetchedAt: string; packages: PackageFacts[] }
