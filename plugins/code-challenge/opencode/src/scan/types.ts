/** Shared types for the challenge_scan tool: recipes, normalised candidates and the report. */

export const LENSES = [
  "simplification",
  "over-engineering",
  "optimisation",
  "performance",
  "efficiency",
  "stability",
  "hand-rolled-stdlib",
  "hand-rolled-lib",
  "dead-code",
  "observability",
  "structure",
  "tests",
] as const
export type Lens = (typeof LENSES)[number]

export const LANGUAGES = ["ts", "python", "go", "rust"] as const
export type Language = (typeof LANGUAGES)[number]

export const DEPTHS = ["quick", "standard", "deep"] as const
export type Depth = (typeof DEPTHS)[number]

/** One normalised analyzer hit. `file` is relative to the target root. */
export type Candidate = {
  lens: Lens
  tool: string
  rule: string
  /** Root-relative path; null when the analyzer's module could not be mapped to a file. */
  file: string | null
  line: number | null
  message: string
  /** Whether the repo's own config enables the rule; null when that is not cheap to tell. */
  ruleEnabledInRepo: boolean | null
}

/** What a parser extracts before lens and repo-config tagging. */
export type Hit = { rule: string; file: string | null; line: number | null; message: string }

export type ParserId =
  | "biome-json"
  | "oxlint-json"
  | "eslint-json"
  | "knip-json"
  | "jscpd-json"
  | "depcruise-json"
  | "ruff-json"
  | "vulture-text"
  | "import-linter-text"
  | "golangci-json"
  | "deadcode-json"
  | "clippy-json"
  | "machete-text"
  | "lizard-csv"

/**
 * How a recipe's binary is found.
 * - `local`: a binary on PATH only.
 * - `bunx`, `uvx`, `go-run`: the local binary when present, else a one-off run of `package`.
 * - `tool-dir`: a binary under the scan tools directory (eslint needs its plugin beside it).
 * Nothing is ever installed globally; an unavailable tool is reported as a coverage gap.
 */
export type InstallKind = "local" | "bunx" | "uvx" | "go-run" | "tool-dir"

export type RecipeContext = { root: string; hasGitignore: boolean; toolsDir: string }

export type Recipe = {
  id: string
  tool: string
  /** `any` runs once for the whole scan, whatever languages were selected. */
  language: Language | "any"
  lenses: readonly Lens[]
  /** Lens for a rule, first match wins; `lenses[0]` otherwise. */
  lensRules?: ReadonlyArray<readonly [RegExp, Lens]>
  /** The binary name looked up on PATH (or in the tools directory). */
  binary: string
  install: InstallKind
  /** Package for a one-off run (bunx -p, uvx --from, go run); its exact version is in pins.ts. */
  package?: string
  /** Path inside a Go module to run (`go run <module>/<subpath>@<version>`). */
  subpath?: string
  /**
   * Arguments. Tokens: `{cfg}` the isolated config directory, `{files}` the scoped files
   * (or `.`), `{out}` a per-run output directory.
   */
  args: readonly string[]
  /** Files written into the isolated config directory before the run. */
  configFiles?: (ctx: RecipeContext) => Record<string, string>
  /** The recipe reads this file under `{out}` instead of stdout. */
  outputFile?: string
  /**
   * Set when the tool executes repository code or writes build output: what it runs and writes.
   * Such a recipe only runs after the caller consented for the root.
   */
  executes?: string
  /** Quick depth skips recipes that need a build or type-check. */
  needsBuild: boolean
  acceptedExitCodes: readonly number[]
  parser: ParserId
  /** `files`: scoped files are passed as arguments. `repo`: runs on the whole repo and hits are filtered. */
  scope: "files" | "repo"
  /** Extensions a `files` recipe accepts. */
  extensions?: readonly string[]
  /** Run only when the root holds one of these files (a repo config marker). */
  requiresMarker?: readonly string[]
}

export type CoverageStatus = "ran" | "skipped" | "gap"
export type CoverageEntry = { recipe: string; tool: string; language: string; status: CoverageStatus; reason?: string }
export type Timing = { recipe: string; tool: string; ms: number; exitCode: number | null }

export type ScanInput = {
  root?: string
  files?: string[]
  languages?: Language[]
  lenses?: Lens[]
  depth?: Depth
  timeoutSeconds?: number
  runId?: string
}

export type ScanReport = {
  root: string
  languages: Language[]
  depth: Depth
  candidates: Candidate[]
  coverage: CoverageEntry[]
  timings: Timing[]
  rawDir: string | null
}
