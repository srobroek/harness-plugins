// Exact versions of every one-off analyzer package. Renovate moves them through the manager
// in renovate.json that reads this file; keep each pin on the line after its annotation.
export const PINS: Record<string, string> = {
  // renovate: datasource=npm depName=@biomejs/biome
  "@biomejs/biome": "2.6.9",
  // renovate: datasource=npm depName=oxlint
  oxlint: "1.94.0",
  // renovate: datasource=npm depName=knip
  knip: "6.48.0",
  // renovate: datasource=npm depName=dependency-cruiser
  "dependency-cruiser": "18.8.0",
  // renovate: datasource=npm depName=jscpd
  jscpd: "5.4.3",
  // renovate: datasource=npm depName=eslint
  eslint: "10.15.0",
  // renovate: datasource=npm depName=@e18e/eslint-plugin
  "@e18e/eslint-plugin": "0.8.1",
  // renovate: datasource=pypi depName=ruff
  ruff: "0.17.6",
  // renovate: datasource=pypi depName=vulture
  vulture: "2.16",
  // renovate: datasource=pypi depName=import-linter
  "import-linter": "2.17",
  // renovate: datasource=pypi depName=lizard
  lizard: "1.26.1",
  // renovate: datasource=go depName=golang.org/x/tools
  "golang.org/x/tools": "v0.53.0",
}

/** The pinned version of a package; a recipe naming an unpinned package is a programming error. */
export function pinOf(pkg: string): string {
  const version = PINS[pkg]
  if (version === undefined) throw new Error(`challenge_scan: no pinned version for ${pkg}`)
  return version
}
