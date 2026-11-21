import { lstatSync, readdirSync, realpathSync, type Stats, statSync } from "node:fs"
import { readText } from "./read.ts"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { LANGUAGES, type Language } from "./types.ts"

export const SKIP_DIRS = new Set([".git", "node_modules", "dist", "target", ".venv", "venv", "__pycache__"])

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
    for (const [marker, language] of MARKER_LANGUAGE) if (lstatOrNull(join(root, marker)) !== null) found.add(language)
  }
  return LANGUAGES.filter((l) => found.has(l))
}

/** Whether `abs` is the root or below it. Both must already be real paths. */
function inside(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const outside = (pattern: string): Error => new Error(`challenge_scan: path is outside the root: ${pattern}`)

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Collect regular files below `dir`; symlinks are skipped, never followed. */
function walk(dir: string, root: string, out: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), root, out)
    } else out.add(relative(root, join(dir, entry.name)))
  }
}

/**
 * Expand files, directories and globs into existing root-relative files. `root` is a real
 * path. A named path or a glob that leaves the root is an error; a symlink met while walking
 * or globbing that leaves it is skipped.
 */
export function expandFiles(root: string, patterns: readonly string[]): string[] {
  const found = new Set<string>()
  for (const pattern of patterns) {
    const isGlob = /[*?[{]/.test(pattern)
    if (isGlob && (isAbsolute(pattern) || pattern.split("/").includes(".."))) throw outside(pattern)
    const abs = resolve(root, pattern)
    if (!isGlob) {
      if (!inside(root, abs)) throw outside(pattern)
      const real = realOrNull(abs)
      if (real === null) continue
      if (!inside(root, real)) throw outside(pattern)
      if (statSync(real).isDirectory()) walk(real, root, found)
      else found.add(relative(root, real))
      continue
    }
    for (const match of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      if (match.split("/").some((part) => SKIP_DIRS.has(part))) continue
      const real = realOrNull(join(root, match))
      if (real !== null && inside(root, real)) found.add(relative(root, real))
    }
  }
  return [...found].sort()
}

/** Why a recipe's repo marker is missing, or null. A marker is `file` or `file:needle` (the file must contain it). */
export function missingMarker(root: string, markers: readonly string[] | undefined): string | null {
  if (!markers) return null
  for (const spec of markers) {
    const [name = "", needle] = spec.split(":")
    const read = readText(join(root, name), MAX_MARKER_BYTES)
    // Absent, a symlink, a FIFO or an oversized file all count as no marker.
    if (read.kind !== "text") continue
    if (needle === undefined || read.text.includes(needle)) return null
  }
  return `no ${markers.map((m) => m.replace(":", " containing ")).join(" or ")} in the repository`
}

export const MAX_MARKER_BYTES = 1024 * 1024

/** `lstat` that follows no symlink and returns null when nothing is there. */
export function lstatOrNull(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null
}

/** Files git lists as tracked or untracked-but-not-ignored (NUL separated), as root-relative paths. */
export function parseListing(stdout: string): string[] {
  return stdout.split("\0").filter((f) => f !== "")
}
