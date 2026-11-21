import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join, resolve } from "node:path"
import { readText } from "./read.ts"
import { type Exec, MAX_STDERR_BYTES, MAX_STDOUT_BYTES, spawnTool } from "./exec.ts"
import { detectLanguages, expandFiles, lstatOrNull, missingMarker } from "./files.ts"
import { type GitState, gitListing, gitState, type Listing } from "./git.ts"
import { OutputError, parseOutput } from "./parsers.ts"
import { pinOf } from "./pins.ts"
import { probeFor } from "./probes.ts"
import { RECIPES } from "./recipes.ts"
import { ensureDir, writeFileNoFollow } from "./safe.ts"
import {
  type Candidate,
  type CoverageEntry,
  type Depth,
  type Hit,
  type Language,
  LENSES,
  type Lens,
  type Recipe,
  type ScanInput,
  type ScanReport,
  type Timing,
} from "./types.ts"

export { detectLanguages, expandFiles } from "./files.ts"
export type { Exec }

export type ScanDeps = {
  exec?: Exec
  /** Path of an executable on PATH, or null. */
  which?: (binary: string) => string | null
  /** Directory holding the `tool-dir` recipes' node_modules. */
  toolsDir?: string
  now?: () => number
  /**
   * The caller consented to run recipes that execute repository or downloaded code for this
   * root. Without it those recipes are coverage gaps. It is host-side only: tool input cannot set it.
   */
  consent?: boolean
}

const DEFAULT_TIMEOUT_SECONDS = 120
/** No caller can hold an analyzer longer than this. */
export const MAX_TIMEOUT_SECONDS = 900

/** A run id is one path segment: a word character first, then word characters, dots and dashes, at most 64. */
export function validRunId(runId: string): boolean {
  return /^\w[\w.-]{0,63}$/.test(runId)
}

type Resolved = { prefix: string[]; oneOff: boolean } | { gap: string }

/** The command prefix that runs a recipe's tool, or why it cannot run. Never installs anything. */
export function resolveTool(recipe: Recipe, which: (b: string) => string | null, toolsDir: string): Resolved {
  if (recipe.install === "tool-dir") {
    // Without a git directory there is no private place to provision tools; never look in a shared one.
    if (toolsDir === "") return { gap: `${recipe.tool} needs a tools directory under the git dir, and the root is not a git repository` }
    const bin = join(toolsDir, "node_modules", ".bin", recipe.binary)
    return existsSync(bin)
      ? { prefix: [bin], oneOff: false }
      : {
          gap: `${recipe.tool} is not provisioned; run "bun add eslint@${pinOf("eslint")} @e18e/eslint-plugin@${pinOf("@e18e/eslint-plugin")}" in ${toolsDir}`,
        }
  }
  const local = which(recipe.binary)
  if (local) return { prefix: [local], oneOff: false }
  const pkg = recipe.package ?? recipe.binary
  if (recipe.install === "bunx") {
    const bunx = which("bunx")
    if (bunx) return { prefix: [bunx, "-p", `${pkg}@${pinOf(pkg)}`, recipe.binary], oneOff: true }
  } else if (recipe.install === "uvx") {
    const uvx = which("uvx")
    if (uvx) return { prefix: [uvx, "--from", `${pkg}==${pinOf(pkg)}`, recipe.binary], oneOff: true }
  } else if (recipe.install === "go-run") {
    const go = which("go")
    if (go) return { prefix: [go, "run", `${recipe.subpath ? `${pkg}/${recipe.subpath}` : pkg}@${pinOf(pkg)}`], oneOff: true }
  }
  const runner = recipe.install === "local" ? "" : ` and no ${recipe.install} runner is on PATH`
  return { gap: `${recipe.binary} is not installed${runner}` }
}

const RUNNER_NAME = { bunx: "bunx", uvx: "uvx", "go-run": "go run" } as const

/** What running this recipe would execute or write beyond static analysis; empty when nothing. */
function risksOf(recipe: Recipe, resolved: { prefix: string[]; oneOff: boolean }): string[] {
  const risks: string[] = []
  if (recipe.executes) risks.push(recipe.executes)
  if (resolved.oneOff && recipe.install !== "local" && recipe.install !== "tool-dir") {
    const pkg = recipe.package ?? recipe.binary
    const spec = recipe.install === "uvx" ? `${pkg}==${pinOf(pkg)}` : `${pkg}@${pinOf(pkg)}`
    risks.push(`downloads and runs ${spec} with ${RUNNER_NAME[recipe.install]}; writes the package cache`)
  }
  return risks
}

function expandArgs(recipe: Recipe, cfg: string, out: string, files: readonly string[], root: string): string[] {
  return recipe.args.flatMap((arg) => {
    // Absolute paths never start with "-", so a file name cannot pass for an option.
    if (arg === "{files}") return files.length > 0 ? files.map((f) => join(root, f)) : ["."]
    return [arg.replaceAll("{cfg}", cfg).replaceAll("{out}", out)]
  })
}

function lensOf(recipe: Recipe, rule: string): Lens {
  for (const [pattern, lens] of recipe.lensRules ?? []) if (pattern.test(rule)) return lens
  return recipe.lenses[0] ?? "simplification"
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 200) ?? ""
const slug = (id: string): string => id.replace(/[^\w.-]/g, "_")

type Prepared = {
  root: string
  exec: Exec
  which: (b: string) => string | null
  now: () => number
  depth: Depth
  lenses: readonly Lens[]
  timeoutMs: number
  files: string[]
  languages: Language[]
  git: GitState
  toolsDir: string
  hasGitignore: boolean
  /** The file list matched nothing. */
  emptySelection: boolean
  /** Non-ignored files git knows (tracked or untracked), computed once. */
  listing: () => Promise<Listing>
  /** Set when explicit files were named and the repository's ignore files could not be applied to them. */
  ignoreError: string | null
  signal?: AbortSignal
}

async function prepare(input: ScanInput, deps: ScanDeps, signal?: AbortSignal): Promise<Prepared> {
  // Analyzers report real paths, so a symlinked root (macOS /var -> /private/var) is resolved first.
  const root = realpathSync(resolve(input.root ?? process.cwd()))
  if (!statSync(root).isDirectory()) throw new Error(`challenge_scan: root is not a directory: ${root}`)
  const exec = deps.exec ?? spawnTool
  const which = deps.which ?? ((b: string) => Bun.which(b))
  if (input.runId !== undefined && !validRunId(input.runId)) throw new Error(`challenge_scan: invalid runId "${input.runId}"`)
  const requested = input.files !== undefined && input.files.length > 0
  let files = requested ? expandFiles(root, input.files ?? []) : []
  const nothing = requested && files.length === 0
  const git: GitState = nothing ? { kind: "none" } : await gitState(root, exec, which, signal)
  let listed: Promise<Listing> | undefined
  const listing = (): Promise<Listing> => {
    listed ??= gitListing(root, git, exec, which, signal)
    return listed
  }
  // Pass the repo's ignore files through to tools that would lint an explicitly named, git-ignored file.
  let ignoreError: string | null = null
  if (files.length > 0) {
    const known = await listing()
    if (known.kind === "files") {
      const set = new Set(known.files)
      files = files.filter((f) => set.has(f))
    } else if (known.kind === "error") ignoreError = known.reason
  }
  return {
    root,
    exec,
    which,
    now: deps.now ?? Date.now,
    depth: input.depth ?? "standard",
    lenses: input.lenses && input.lenses.length > 0 ? input.lenses : LENSES,
    timeoutMs: Math.min(input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000,
    files,
    languages: input.languages && input.languages.length > 0 ? input.languages : detectLanguages(root, files),
    git,
    toolsDir: deps.toolsDir ?? (git.kind === "repo" ? join(git.dir, "code-challenge", "tools") : ""),
    hasGitignore: lstatOrNull(join(root, ".gitignore"))?.isFile() === true,
    emptySelection: requested && files.length === 0,
    listing,
    ignoreError,
    signal,
  }
}

type PlanItem =
  | { recipe: Recipe; status: "ready"; resolved: { prefix: string[]; oneOff: boolean }; scoped: string[]; risks: string[] }
  | { recipe: Recipe; status: "skipped" | "gap"; reason: string }

/** Decide, per recipe, whether it runs, is skipped or is a gap, before anything executes. */
function plan(p: Prepared): PlanItem[] {
  const items: PlanItem[] = []
  for (const recipe of RECIPES) {
    if (recipe.language !== "any" && !p.languages.includes(recipe.language)) continue
    if (recipe.language === "any" && p.languages.length === 0) continue
    const skip = (reason: string) => items.push({ recipe, status: "skipped", reason })
    if (!recipe.lenses.some((l) => p.lenses.includes(l))) {
      skip("serves none of the requested lenses")
      continue
    }
    if (p.depth === "quick" && recipe.needsBuild) {
      skip("needs a build; skipped at quick depth")
      continue
    }
    const missing = missingMarker(p.root, recipe.requiresMarker)
    if (missing) {
      skip(missing)
      continue
    }
    let scoped: string[] = []
    if (recipe.scope === "files" && p.files.length > 0) {
      if (p.ignoreError) {
        items.push({ recipe, status: "gap", reason: `the repository's ignore files could not be applied to the named files: ${p.ignoreError}` })
        continue
      }
      scoped = p.files.filter((f) => !recipe.extensions || recipe.extensions.includes(extname(f)))
      if (scoped.length === 0) {
        skip("no matching files in the file list")
        continue
      }
    }
    const resolved = resolveTool(recipe, p.which, p.toolsDir)
    if ("gap" in resolved) {
      items.push({ recipe, status: "gap", reason: resolved.gap })
      continue
    }
    items.push({ recipe, status: "ready", resolved, scoped, risks: risksOf(recipe, resolved) })
  }
  return items
}

export type Risk = { recipe: string; tool: string; reasons: string[] }

/** The recipes this scan would run that execute repository or downloaded code, and what each runs and writes. */
export async function consentRisks(input: ScanInput, deps: ScanDeps = {}, signal?: AbortSignal): Promise<Risk[]> {
  const prepared = await prepare(input, deps, signal)
  if (prepared.emptySelection) return []
  return plan(prepared).flatMap((item) =>
    item.status === "ready" && item.risks.length > 0 ? [{ recipe: item.recipe.id, tool: item.recipe.tool, reasons: item.risks }] : [],
  )
}

/** The eslint tools directory, validated one real directory at a time like every other output path. */
function ensureToolsDir(p: Prepared): string {
  return p.git.kind === "repo" && p.toolsDir === join(p.git.dir, "code-challenge", "tools")
    ? ensureDir(p.git.dir, "code-challenge", "tools")
    : ensureDir(p.toolsDir)
}

const MiB = 1024 * 1024
/** Room left on a command line (macOS ARG_MAX is 1 MiB) after the environment and fixed arguments. */
export const MAX_ARGV_BYTES = 256 * 1024

/** Read a tool's report file: a regular file under the size cap, else the reason it cannot be used. */
function readReport(path: string, name: string): { text: string } | { gap: string } {
  const read = readText(path, MAX_STDOUT_BYTES)
  if (read.kind === "text") return { text: read.text }
  // readText folds "too big" and "not a regular file" together; absent is the common case.
  return {
    gap:
      read.kind === "absent"
        ? `the report file ${name} was not written`
        : `the report file ${name} is not a regular file under ${MAX_STDOUT_BYTES / MiB} MiB`,
  }
}

/** Run the recipes selected by the input and normalise their hits. */
export async function runScan(input: ScanInput, deps: ScanDeps = {}, signal?: AbortSignal): Promise<ScanReport> {
  const p = await prepare(input, deps, signal)
  const { root, exec, depth } = p
  if (p.emptySelection) {
    const coverage: CoverageEntry[] = [
      { recipe: "*", tool: "-", language: "-", status: "skipped", reason: "the file list matched no files" },
    ]
    return { root, languages: [], depth, candidates: [], coverage, timings: [], rawDir: null }
  }
  if (input.runId !== undefined && p.git.kind !== "repo") {
    throw new Error(`challenge_scan: runId needs a git repository for the output directory${p.git.kind === "error" ? ` (${p.git.reason})` : ""}`)
  }
  const base =
    input.runId !== undefined && p.git.kind === "repo"
      ? ensureDir(p.git.dir, "code-challenge", input.runId, "scan")
      : mkdtempSync(join(tmpdir(), "code-challenge-scan-"))
  const rawDir = input.runId !== undefined && p.git.kind === "repo" ? base : null
  const fileSet = new Set(p.files)

  const coverage: CoverageEntry[] = []
  const timings: Timing[] = []
  const candidates: Candidate[] = []

  try {
    for (const item of plan(p)) {
      const { recipe } = item
      const entry = (status: CoverageEntry["status"], reason?: string): void => {
        coverage.push({ recipe: recipe.id, tool: recipe.tool, language: recipe.language, status, ...(reason ? { reason } : {}) })
      }
      if (item.status !== "ready") {
        entry(item.status, item.reason)
        continue
      }
      if (item.risks.length > 0 && deps.consent !== true) {
        entry("gap", `not run without consent: ${item.risks.join("; ")}`)
        continue
      }
      if (signal?.aborted) {
        entry("skipped", "scan aborted")
        continue
      }

      const name = slug(recipe.id)
      // A repo config that overrides --config-path means running from the config directory on explicit files.
      const fromConfigDir = (recipe.repoConfigNames ?? []).some((n) => lstatOrNull(join(root, n)) !== null)
      let files = item.scoped
      if (fromConfigDir) {
        // Isolated mode names the files itself, so the repo's ignore files must be applied here: a listing
        // that failed is a gap, and only a directory that is not a repository is walked unfiltered.
        const known = await p.listing()
        if (known.kind === "error") {
          entry("gap", `the repository's ignore files could not be applied: ${known.reason}`)
          continue
        }
        const all = known.kind === "files" ? known.files : expandFiles(root, ["."])
        files = p.files.length > 0 ? item.scoped : all.filter((f) => !recipe.extensions || recipe.extensions.includes(extname(f)))
        if (files.length === 0) {
          entry("skipped", "no matching files outside the repo's ignore files")
          continue
        }
        if (files.reduce((n, f) => n + root.length + f.length + 2, 0) > MAX_ARGV_BYTES) {
          entry("gap", `too many files to name on one command line in isolated mode (${files.length}); pass a narrower file list`)
          continue
        }
      }
      // eslint resolves its plugin from the config's own location, so that config sits in the tools directory.
      const cfg = recipe.install === "tool-dir" ? ensureToolsDir(p) : ensureDir(base, "cfg", name)
      const out = ensureDir(base, "out", name)
      for (const [file, content] of Object.entries(
        recipe.configFiles?.({ root, hasGitignore: p.hasGitignore, toolsDir: p.toolsDir, fromConfigDir }) ?? {},
      )) {
        writeFileNoFollow(join(cfg, file), content)
      }
      const argv = [...item.resolved.prefix, ...expandArgs(recipe, cfg, out, files, root)]
      const started = p.now()
      const run = await exec(argv, { cwd: fromConfigDir ? cfg : root, timeoutMs: p.timeoutMs, signal })
      timings.push({ recipe: recipe.id, tool: recipe.tool, ms: p.now() - started, exitCode: run.kind === "exited" ? run.exitCode : null })
      writeFileNoFollow(join(base, `${name}.stdout`), run.stdout)
      writeFileNoFollow(join(base, `${name}.stderr`), run.stderr)

      if (run.kind === "timeout") {
        entry("gap", `timed out after ${p.timeoutMs / 1000}s`)
        continue
      }
      if (run.kind === "aborted") {
        entry("skipped", "scan aborted")
        continue
      }
      if (run.kind === "overflow") {
        const cap = run.stream === "stdout" ? MAX_STDOUT_BYTES : MAX_STDERR_BYTES
        entry("gap", `${run.stream} exceeded ${cap / MiB} MiB; the tool was ended`)
        continue
      }
      if (run.kind === "lost") {
        entry("gap", "the process vanished without an exit status")
        continue
      }
      if (!recipe.acceptedExitCodes.includes(run.exitCode)) {
        entry("gap", `exit ${run.exitCode}: ${firstLine(run.stderr || run.stdout)}`)
        continue
      }

      let text = run.stdout
      if (recipe.outputFile) {
        const report = readReport(join(out, recipe.outputFile), recipe.outputFile)
        if ("gap" in report) {
          entry("gap", report.gap)
          continue
        }
        text = report.text
      }
      let hits: Hit[]
      try {
        hits = parseOutput(recipe.parser, text, { root, cwd: root })
      } catch (error) {
        if (!(error instanceof OutputError)) throw error
        entry("gap", `unparseable output: ${error.message}`)
        continue
      }
      if (fileSet.size > 0 && recipe.scope === "repo") hits = hits.filter((h) => h.file !== null && fileSet.has(h.file))
      const probe = hits.length > 0 ? probeFor(recipe, { root, prefix: item.resolved.prefix, exec, timeoutMs: p.timeoutMs, signal }) : null
      const enabled = probe ? await probe(hits) : null
      for (const hit of hits) {
        const lens = lensOf(recipe, hit.rule)
        if (!p.lenses.includes(lens)) continue
        candidates.push({
          lens,
          tool: recipe.tool,
          rule: hit.rule,
          file: hit.file,
          line: hit.line,
          message: hit.message,
          ruleEnabledInRepo: enabled ? enabled(hit) : null,
        })
      }
      entry("ran")
    }
  } finally {
    if (rawDir === null) rmSync(base, { recursive: true, force: true })
  }

  const byFile = (a: Candidate, b: Candidate): number =>
    (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule)
  candidates.sort(byFile)
  return { root, languages: p.languages, depth, candidates, coverage, timings, rawDir }
}
