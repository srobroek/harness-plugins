import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join, relative, resolve } from "node:path"
import { type SupervisedRun, supervise } from "@srobroek/opencode-lib/subprocess"
import { parseOutput } from "./parsers.ts"
import { pinOf } from "./pins.ts"
import { RECIPES } from "./recipes.ts"
import {
  type Candidate,
  type CoverageEntry,
  type Depth,
  type Hit,
  LANGUAGES,
  type Language,
  LENSES,
  type Lens,
  type Recipe,
  type ScanInput,
  type ScanReport,
  type Timing,
} from "./types.ts"

export type Exec = (
  argv: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<SupervisedRun>

/** Run one analyzer in its own process group so a timeout ends the tool and its children only. */
export const spawnTool: Exec = async (argv, { cwd, timeoutMs, signal }) => {
  try {
    const child = Bun.spawn(argv, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      detached: true,
    })
    return await supervise(child, { timeoutMs, signal, group: true })
  } catch (error) {
    return { kind: "exited", exitCode: 127, signalCode: null, stdout: "", stderr: String(error) }
  }
}

export type ScanDeps = {
  exec?: Exec
  /** Path of an executable on PATH, or null. */
  which?: (binary: string) => string | null
  /** Directory holding the `tool-dir` recipes' node_modules. */
  toolsDir?: string
  now?: () => number
}

const DEFAULT_TIMEOUT_SECONDS = 120
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "target", ".venv", "venv", "__pycache__"])

const EXTENSION_LANGUAGE: Record<string, Language> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
}

const MARKER_LANGUAGE: ReadonlyArray<readonly [string, Language]> = [
  ["package.json", "ts"],
  ["tsconfig.json", "ts"],
  ["pyproject.toml", "python"],
  ["setup.py", "python"],
  ["requirements.txt", "python"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
]

/** Languages of a file list, or of the marker files at the root when no files are given. */
export function detectLanguages(root: string, files: readonly string[]): Language[] {
  const found = new Set<Language>()
  if (files.length > 0) {
    for (const file of files) {
      const language = EXTENSION_LANGUAGE[extname(file)]
      if (language) found.add(language)
    }
  } else {
    for (const [marker, language] of MARKER_LANGUAGE) if (existsSync(join(root, marker))) found.add(language)
  }
  return LANGUAGES.filter((l) => found.has(l))
}

function walk(dir: string, root: string, out: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), root, out)
    } else out.add(relative(root, join(dir, entry.name)))
  }
}

/** Expand files, directories and globs (relative to root) into existing root-relative files. */
export function expandFiles(root: string, patterns: readonly string[]): string[] {
  const found = new Set<string>()
  for (const pattern of patterns) {
    const abs = resolve(root, pattern)
    if (existsSync(abs)) {
      if (statSync(abs).isDirectory()) walk(abs, root, found)
      else found.add(relative(root, abs))
      continue
    }
    for (const match of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      if (!match.split("/").some((part) => SKIP_DIRS.has(part))) found.add(match)
    }
  }
  return [...found].sort()
}

/** Why a recipe's repo marker is missing, or null. A marker is `file` or `file:needle` (the file must contain it). */
function missingMarker(root: string, markers: readonly string[] | undefined): string | null {
  if (!markers) return null
  for (const spec of markers) {
    const [name = "", needle] = spec.split(":")
    const path = join(root, name)
    if (!existsSync(path)) continue
    if (needle === undefined || readFileSync(path, "utf8").includes(needle)) return null
  }
  return `no ${markers.map((m) => m.replace(":", " containing ")).join(" or ")} in the repository`
}

type Resolved = { prefix: string[] } | { gap: string }

/** The command prefix that runs a recipe's tool, or why it cannot run. Never installs anything. */
export function resolveTool(recipe: Recipe, which: (b: string) => string | null, toolsDir: string): Resolved {
  if (recipe.install === "tool-dir") {
    const bin = join(toolsDir, "node_modules", ".bin", recipe.binary)
    return existsSync(bin)
      ? { prefix: [bin] }
      : {
          gap: `${recipe.tool} is not provisioned; run "bun add eslint@${pinOf("eslint")} @e18e/eslint-plugin@${pinOf("@e18e/eslint-plugin")}" in ${toolsDir}`,
        }
  }
  const local = which(recipe.binary)
  if (local) return { prefix: [local] }
  const pkg = recipe.package ?? recipe.binary
  if (recipe.install === "bunx") {
    const bunx = which("bunx")
    if (bunx) return { prefix: [bunx, "-p", `${pkg}@${pinOf(pkg)}`, recipe.binary] }
  } else if (recipe.install === "uvx") {
    const uvx = which("uvx")
    if (uvx) return { prefix: [uvx, "--from", `${pkg}==${pinOf(pkg)}`, recipe.binary] }
  } else if (recipe.install === "go-run") {
    const go = which("go")
    if (go) return { prefix: [go, "run", `${recipe.subpath ? `${pkg}/${recipe.subpath}` : pkg}@${pinOf(pkg)}`] }
  }
  const runner = recipe.install === "local" ? "" : ` and no ${recipe.install} runner is on PATH`
  return { gap: `${recipe.binary} is not installed${runner}` }
}

function expandArgs(recipe: Recipe, cfg: string, out: string, files: readonly string[]): string[] {
  return recipe.args.flatMap((arg) => {
    if (arg === "{files}") return files.length > 0 ? [...files] : ["."]
    return [arg.replaceAll("{cfg}", cfg).replaceAll("{out}", out)]
  })
}

function lensOf(recipe: Recipe, rule: string): Lens {
  for (const [pattern, lens] of recipe.lensRules ?? []) if (pattern.test(rule)) return lens
  return recipe.lenses[0] ?? "simplification"
}

type Probe = (hits: readonly Hit[]) => Promise<(rule: string) => boolean>

/** Repo-config checks that one query of the tool answers; every other tool reports null. */
function enabledProbe(recipe: Recipe, prefix: string[], root: string, exec: Exec, timeoutMs: number): Probe | null {
  if (recipe.tool === "ruff") {
    return async (hits) => {
      const file = hits[0]?.file ?? "."
      const run = await exec([...prefix, "check", "--show-settings", file], { cwd: root, timeoutMs })
      const enabled = new Set<string>()
      if (run.kind === "exited") for (const m of run.stdout.matchAll(/\(([A-Z]+[0-9]+)\)/g)) enabled.add(m[1] ?? "")
      return (rule) => enabled.has(rule)
    }
  }
  if (recipe.tool === "golangci-lint") {
    return async () => {
      const run = await exec([...prefix, "linters", "--json"], { cwd: root, timeoutMs })
      const enabled = new Set<string>()
      if (run.kind === "exited") {
        try {
          const parsed = JSON.parse(run.stdout) as { Enabled?: Array<{ name?: string }> }
          for (const linter of parsed.Enabled ?? []) if (linter.name) enabled.add(linter.name)
        } catch {
          // an unreadable answer leaves every rule reported as not enabled
        }
      }
      return (rule) => enabled.has(rule)
    }
  }
  return null
}

async function gitDir(root: string, exec: Exec, which: (b: string) => string | null): Promise<string | null> {
  const git = which("git")
  if (!git) return null
  const run = await exec([git, "rev-parse", "--absolute-git-dir"], { cwd: root, timeoutMs: 10_000 })
  return run.kind === "exited" && run.exitCode === 0 ? run.stdout.trim() : null
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 200) ?? ""
const slug = (id: string): string => id.replace(/[^\w.-]/g, "_")

/** Run the recipes selected by the input and normalise their hits. */
export async function runScan(input: ScanInput, deps: ScanDeps = {}, signal?: AbortSignal): Promise<ScanReport> {
  // Analyzers report real paths, so a symlinked root (macOS /var -> /private/var) is resolved first.
  const root = realpathSync(resolve(input.root ?? process.cwd()))
  const exec = deps.exec ?? spawnTool
  const which = deps.which ?? ((b: string) => Bun.which(b))
  const now = deps.now ?? Date.now
  const depth: Depth = input.depth ?? "standard"
  const lenses: readonly Lens[] = input.lenses && input.lenses.length > 0 ? input.lenses : LENSES
  const timeoutMs = (input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
  if (input.runId !== undefined && !/^[\w.-]+$/.test(input.runId)) {
    throw new Error(`challenge_scan: invalid runId "${input.runId}"`)
  }

  const files = input.files && input.files.length > 0 ? expandFiles(root, input.files) : []
  const languages = input.languages && input.languages.length > 0 ? input.languages : detectLanguages(root, files)
  const git = await gitDir(root, exec, which)
  if (input.runId !== undefined && git === null) {
    throw new Error("challenge_scan: runId needs a git repository for the output directory")
  }
  const rawDir = input.runId !== undefined && git !== null ? join(git, "code-challenge", input.runId, "scan") : null
  const base = rawDir ?? mkdtempSync(join(tmpdir(), "code-challenge-scan-"))
  mkdirSync(base, { recursive: true })
  const toolsDir = deps.toolsDir ?? join(git ?? base, "code-challenge", "tools")
  const hasGitignore = existsSync(join(root, ".gitignore"))
  const fileSet = new Set(files)

  const coverage: CoverageEntry[] = []
  const timings: Timing[] = []
  const candidates: Candidate[] = []

  try {
    for (const recipe of RECIPES) {
      if (recipe.language !== "any" && !languages.includes(recipe.language)) continue
      if (recipe.language === "any" && languages.length === 0) continue
      const entry = (status: CoverageEntry["status"], reason?: string): void => {
        coverage.push({ recipe: recipe.id, tool: recipe.tool, language: recipe.language, status, ...(reason ? { reason } : {}) })
      }
      if (!recipe.lenses.some((l) => lenses.includes(l))) {
        entry("skipped", "serves none of the requested lenses")
        continue
      }
      if (depth === "quick" && recipe.needsBuild) {
        entry("skipped", "needs a build; skipped at quick depth")
        continue
      }
      const missing = missingMarker(root, recipe.requiresMarker)
      if (missing) {
        entry("skipped", missing)
        continue
      }
      let scoped: string[] = []
      if (recipe.scope === "files" && files.length > 0) {
        scoped = files.filter((f) => !recipe.extensions || recipe.extensions.includes(extname(f)))
        if (scoped.length === 0) {
          entry("skipped", "no matching files in the file list")
          continue
        }
      }
      const resolved = resolveTool(recipe, which, toolsDir)
      if ("gap" in resolved) {
        entry("gap", resolved.gap)
        continue
      }
      if (signal?.aborted) {
        entry("skipped", "scan aborted")
        continue
      }

      const name = slug(recipe.id)
      const cfg = join(base, "cfg", name)
      const out = join(base, "out", name)
      mkdirSync(cfg, { recursive: true })
      mkdirSync(out, { recursive: true })
      for (const [file, content] of Object.entries(recipe.configFiles?.({ root, hasGitignore }) ?? {})) {
        writeFileSync(join(cfg, file), content)
      }
      const argv = [...resolved.prefix, ...expandArgs(recipe, cfg, out, scoped)]
      const started = now()
      const run = await exec(argv, { cwd: root, timeoutMs, signal })
      const exitCode = run.kind === "exited" ? run.exitCode : null
      timings.push({ recipe: recipe.id, tool: recipe.tool, ms: now() - started, exitCode })
      writeFileSync(join(base, `${name}.stdout`), run.stdout)
      writeFileSync(join(base, `${name}.stderr`), run.stderr)

      if (run.kind === "timeout") {
        entry("gap", `timed out after ${timeoutMs / 1000}s`)
        continue
      }
      if (run.kind === "aborted") {
        entry("skipped", "scan aborted")
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
        const path = join(out, recipe.outputFile)
        text = existsSync(path) ? readFileSync(path, "utf8") : ""
      }
      let hits = parseOutput(recipe.parser, text, { root, cwd: root })
      if (fileSet.size > 0 && recipe.scope === "repo") hits = hits.filter((h) => fileSet.has(h.file))
      const probe = hits.length > 0 ? enabledProbe(recipe, resolved.prefix, root, exec, timeoutMs) : null
      const isEnabled = probe ? await probe(hits) : null
      for (const hit of hits) {
        const lens = lensOf(recipe, hit.rule)
        if (!lenses.includes(lens)) continue
        candidates.push({
          lens,
          tool: recipe.tool,
          rule: hit.rule,
          file: hit.file,
          line: hit.line,
          message: hit.message,
          ruleEnabledInRepo: isEnabled ? isEnabled(hit.rule) : null,
        })
      }
      entry("ran")
    }
  } finally {
    if (rawDir === null) rmSync(base, { recursive: true, force: true })
  }

  candidates.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule))
  return { root, languages, depth, candidates, coverage, timings, rawDir }
}
