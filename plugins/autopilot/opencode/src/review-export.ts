/**
 * Export one review round for reviewers that cannot run git: the diff, a diffstat and the changed
 * files at the head commit, written under `<run dir>/review/<head-sha>/<manifest-hash>/`. A reviewer
 * cannot run git while a run is armed (shell asks are denied), so the lead calls this tool and
 * hands the reviewer the directory.
 *
 * Git runs here as an argument array (no shell). Revisions are checked and resolved to full SHAs
 * before anything else runs, so a caller-supplied string never reaches git as an option.
 *
 * The directory is writable by a model: the permission grant covers the directory and the host's
 * `edit` rules may allow writes. Integrity therefore comes from `manifest.json`, which holds the
 * SHA-256 of every exported file, and from the manifest's own hash, which the caller keeps in
 * plugin storage. {@link verifyExport} checks a directory against that stored hash.
 */

import { createHash, randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, sep } from "node:path"
import { readBoundedBytes } from "@srobroek/opencode-lib/bounded-read"
import { SAFE_GIT_ARGS } from "@srobroek/opencode-lib/safe-git"
import type { Run } from "./rundir.ts"

export const REVIEW_DIR = "review"
export const MANIFEST = "manifest.json"

export type ReviewLimits = {
  /** Most changed files at head one export may hold. */
  files: number
  /** Largest `round.diff`, in bytes. */
  diffBytes: number
  /** Largest single file; a bigger one is skipped and listed. */
  fileBytes: number
  /** Most file content in all, in bytes. */
  totalBytes: number
}

export const DEFAULT_LIMITS: ReviewLimits = { files: 300, diffBytes: 4 * 1024 * 1024, fileBytes: 512 * 1024, totalBytes: 8 * 1024 * 1024 }

export type ExportedFile = { path: string; bytes: number; sha256: string }
export type SkippedFile = { path: string; reason: string }
export type Manifest = {
  version: 1
  base: string
  head: string
  mergeBase: string
  diff: { sha256: string; bytes: number }
  diffstat: { sha256: string; bytes: number }
  files: ExportedFile[]
  skipped: SkippedFile[]
}
export type ExportResult =
  | { ok: true; dir: string; base: string; head: string; mergeBase: string; diff: string; diffstat: string; manifest: string; manifestHash: string; files: ExportedFile[]; skipped: SkippedFile[] }
  | { ok: false; reason: string }

const MAX_REV = 200
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHA256 = /^[0-9a-f]{64}$/
const GIT_TIMEOUT_MS = 60_000

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex")

/** Where plugin storage keeps the manifest hash of the export reviewed for one PR head. */
export const reviewManifestKey = (pr: number | string, head: string): string => `review/${pr}@${head}`
/** Where plugin storage keeps the export a run made last. */
export const reviewCurrentKey = (runId: string): string => `review-current/${runId}`

/** The directory of one export, or `undefined` when `head` or `manifestHash` is not what an export would be named. */
export function exportDirFor(runDir: string, head: string, manifestHash: string): string | undefined {
  return FULL_OBJECT_ID.test(head) && SHA256.test(manifestHash) ? join(runDir, REVIEW_DIR, head, manifestHash) : undefined
}

/** Why `rev` may not be handed to git as a revision, or `undefined`. Never lets a leading `-` through. */
export function revRefusal(name: string, rev: unknown): string | undefined {
  if (typeof rev !== "string") return `${name} must be a string`
  if (rev === "") return `${name} must not be empty`
  if (rev.length > MAX_REV) return `${name} is longer than ${MAX_REV} characters`
  if (rev.startsWith("-")) return `${name} must not start with "-"`
  for (const char of rev) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) return `${name} must not contain whitespace or control characters`
  }
  return undefined
}

/**
 * `path` when it is a repository-relative path that stays inside a directory it is joined to:
 * no empty, `.`, `..` or `.git` segment, no leading `/`, no backslash or NUL. Otherwise `undefined`.
 */
export function safeRepoPath(path: string): string | undefined {
  if (path === "" || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return undefined
  const bad = path.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git")
  return bad ? undefined : path
}

type TreeEntry = { type: string; size: number | undefined }
type Refusal = { ok: false; reason: string }

/** `git ls-tree -z -l` output as a map from path to type and size (`-` sizes are `undefined`). */
function parseLsTree(stdout: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>()
  for (const record of stdout.split("\0")) {
    const match = /^\d+ (\w+) [0-9a-f]+ +(\d+|-)\t([\s\S]*)$/.exec(record)
    if (match) entries.set(match[3] as string, { type: match[1] as string, size: match[2] === "-" ? undefined : Number(match[2]) })
  }
  return entries
}

const refuse = (reason: string): Refusal => ({ ok: false, reason })
const diagnostic = (stderr: string) => stderr.trim().slice(0, 300)

/** The full object id `rev` names as a commit, or a refusal. */
async function resolveCommit(run: Run, cwd: string, name: string, rev: string): Promise<{ ok: true; sha: string } | Refusal> {
  const result = await run(cwd, "git", [...SAFE_GIT_ARGS, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], GIT_TIMEOUT_MS)
  const sha = result.stdout.trim()
  if (!result.ok || !FULL_OBJECT_ID.test(sha)) return refuse(`${name} "${rev}" is not a commit in this repository`)
  return { ok: true, sha }
}

/** The tree entries of `paths` at `head`, or a refusal carrying git's diagnostic. Literal pathspecs: a file named like a pathspec (":(top)x") is a name here, not magic. */
async function listTree(run: Run, cwd: string, head: string, paths: string[]): Promise<{ ok: true; tree: Map<string, TreeEntry> } | Refusal> {
  if (paths.length === 0) return { ok: true, tree: new Map() }
  const listed = await run(cwd, "git", [...SAFE_GIT_ARGS, "--literal-pathspecs", "ls-tree", "-z", "-l", head, "--", ...paths], GIT_TIMEOUT_MS)
  return listed.ok ? { ok: true, tree: parseLsTree(listed.stdout) } : refuse(`git ls-tree failed: ${diagnostic(listed.stderr)}`)
}

// --no-ext-diff and --no-textconv: a repository's config and attributes must not run programs here.
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv"]

export type ExportInput = {
  run: Run
  /** The run's repository (or any worktree of it). */
  cwd: string
  /** The run directory; the export goes to `<runDir>/review/<head-sha>/<manifest-hash>/`. */
  runDir: string
  base: unknown
  head: unknown
  limits?: Partial<ReviewLimits>
}

/**
 * Export `base...head` for review. `round.diff` is the three-dot diff: what `head` changed since it
 * left `base`, the same view a pull request shows, so work that landed on `base` meanwhile is not in
 * it. `files/` holds the files the diff touches (deleted ones excluded), as they are at `head`, at
 * their repository-relative paths, and `manifest.json` records the SHA-256 of every file, of the
 * diff and of the diffstat. Binary files, files above the per-file cap, submodules and other
 * non-regular tree entries are skipped and listed. Text is read as UTF-8, so a file in another
 * encoding is exported with replacement characters; `round.diff` is authoritative. Any cap on the
 * whole export refuses it before anything is written.
 *
 * Exports are immutable: the directory is named by the manifest hash and a published one is never
 * deleted or overwritten. Exporting identical content again returns the existing directory when it
 * still verifies, and otherwise moves the damaged one aside and publishes a fresh one.
 */
export async function exportReview(input: ExportInput): Promise<ExportResult> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits }
  const { run, cwd } = input
  const refusal = revRefusal("base", input.base) ?? revRefusal("head", input.head)
  if (refusal !== undefined) return refuse(refusal)
  const base = await resolveCommit(run, cwd, "base", input.base as string)
  if (!base.ok) return base
  const head = await resolveCommit(run, cwd, "head", input.head as string)
  if (!head.ok) return head

  const merge = await run(cwd, "git", [...SAFE_GIT_ARGS, "merge-base", base.sha, head.sha], GIT_TIMEOUT_MS)
  const mergeBase = merge.stdout.trim()
  if (!merge.ok || !FULL_OBJECT_ID.test(mergeBase)) return refuse(`base ${base.sha} and head ${head.sha} have no merge base`)

  const range = `${base.sha}...${head.sha}`
  const names = await run(cwd, "git", [...SAFE_GIT_ARGS, "diff", "--name-only", "-z", "--diff-filter=d", ...DIFF_FLAGS, range, "--"], GIT_TIMEOUT_MS)
  if (!names.ok) return refuse(`git diff failed: ${diagnostic(names.stderr)}`)
  const changed = names.stdout.split("\0").filter((name) => name !== "")
  if (changed.length > limits.files) return refuse(`${changed.length} changed files, above the cap of ${limits.files}; review a smaller range`)

  const diff = await run(cwd, "git", [...SAFE_GIT_ARGS, "diff", ...DIFF_FLAGS, range, "--"], GIT_TIMEOUT_MS)
  if (!diff.ok) return refuse(`git diff failed: ${diagnostic(diff.stderr)}`)
  const diffBytes = Buffer.byteLength(diff.stdout)
  if (diffBytes > limits.diffBytes) return refuse(`diff is ${diffBytes} bytes, above the cap of ${limits.diffBytes}; review a smaller range`)
  const stat = await run(cwd, "git", [...SAFE_GIT_ARGS, "diff", "--stat=160,120", ...DIFF_FLAGS, range, "--"], GIT_TIMEOUT_MS)
  if (!stat.ok) return refuse(`git diff --stat failed: ${diagnostic(stat.stderr)}`)

  const skipped: SkippedFile[] = []
  const wanted: { path: string; size: number }[] = []
  const safe = changed.filter((path) => {
    if (safeRepoPath(path) !== undefined) return true
    skipped.push({ path, reason: "unsafe path" })
    return false
  })
  const listed = await listTree(run, cwd, head.sha, safe)
  if (!listed.ok) return listed
  for (const path of safe) {
    const entry = listed.tree.get(path)
    if (entry === undefined) skipped.push({ path, reason: "not found at head" })
    else if (entry.type !== "blob" || entry.size === undefined) skipped.push({ path, reason: entry.type === "commit" ? "submodule" : `tree entry of type ${entry.type}` })
    else if (entry.size > limits.fileBytes) skipped.push({ path, reason: `${entry.size} bytes, above the per-file cap of ${limits.fileBytes}` })
    else wanted.push({ path, size: entry.size })
  }
  const total = wanted.reduce((sum, file) => sum + file.size, 0)
  if (total > limits.totalBytes) return refuse(`file content is ${total} bytes, above the cap of ${limits.totalBytes}; review a smaller range`)

  const contents: { path: string; text: string }[] = []
  for (const { path } of wanted) {
    const shown = await run(cwd, "git", [...SAFE_GIT_ARGS, "show", "--no-textconv", `${head.sha}:${path}`], GIT_TIMEOUT_MS)
    if (!shown.ok) return refuse(`git show failed for ${path}: ${diagnostic(shown.stderr)}`)
    if (shown.stdout.includes("\0")) skipped.push({ path, reason: "binary" })
    else contents.push({ path, text: shown.stdout })
  }
  contents.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const files: ExportedFile[] = contents.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.text), sha256: sha256(file.text) }))
  const manifest: Manifest = {
    version: 1,
    base: base.sha,
    head: head.sha,
    mergeBase,
    diff: { sha256: sha256(diff.stdout), bytes: diffBytes },
    diffstat: { sha256: sha256(stat.stdout), bytes: Buffer.byteLength(stat.stdout) },
    files,
    skipped,
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const manifestHash = sha256(manifestText)

  let dir: string
  try {
    dir = publish(join(input.runDir, REVIEW_DIR), head.sha, manifestHash, { manifestText, diff: diff.stdout, stat: stat.stdout, contents })
  } catch (error) {
    return refuse(`could not write the export: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { ok: true, dir, base: base.sha, head: head.sha, mergeBase, diff: join(dir, "round.diff"), diffstat: join(dir, "diffstat.txt"), manifest: join(dir, MANIFEST), manifestHash, files, skipped }
}

const lstatOrUndefined = (path: string) => {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/** Create `path` as a real directory, or accept one that already is; a symlink or a file there throws. */
function ensureDirectory(path: string): void {
  const found = lstatOrUndefined(path)
  if (found === undefined) mkdirSync(path)
  else if (!found.isDirectory()) throw new Error(`${path} is not a plain directory`)
}

type Parts = { manifestText: string; diff: string; stat: string; contents: { path: string; text: string }[] }

/**
 * Write the export to a temporary directory and move it to `<review>/<head>/<manifest hash>`. A
 * published export is never removed or written into: when the target exists and still verifies it
 * is reused; when it does not, it is renamed aside (kept as evidence) before the fresh one lands.
 */
function publish(reviewRoot: string, head: string, manifestHash: string, parts: Parts): string {
  mkdirSync(dirname(reviewRoot), { recursive: true })
  ensureDirectory(reviewRoot)
  const headDir = join(reviewRoot, head)
  ensureDirectory(headDir)
  const target = join(headDir, manifestHash)
  const temporary = join(headDir, `.tmp-${randomUUID()}`)
  mkdirSync(temporary)
  try {
    writeFileSync(join(temporary, MANIFEST), parts.manifestText, { flag: "wx" })
    writeFileSync(join(temporary, "round.diff"), parts.diff, { flag: "wx" })
    writeFileSync(join(temporary, "diffstat.txt"), parts.stat, { flag: "wx" })
    const filesDir = join(temporary, "files")
    mkdirSync(filesDir)
    for (const file of parts.contents) {
      const path = join(filesDir, file.path)
      if (!path.startsWith(`${filesDir}${sep}`)) throw new Error(`${file.path} would leave the export directory`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.text, { flag: "wx" })
    }
    if (lstatOrUndefined(target) !== undefined) {
      if (verifyExport(target, manifestHash).ok) {
        rmSync(temporary, { recursive: true, force: true })
        return target
      }
      renameSync(target, join(headDir, `.rejected-${randomUUID()}`))
    }
    renameSync(temporary, target)
    return target
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

// --- verification ------------------------------------------------------------------------------

export type VerifyResult = { ok: true; manifest: Manifest; manifestHash: string } | Refusal

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const isHash = (value: unknown): value is string => typeof value === "string" && SHA256.test(value)
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0

/** The manifest when `value` has exactly the shape {@link exportReview} writes, else a reason. */
function readManifest(value: unknown): { ok: true; manifest: Manifest } | Refusal {
  if (!isObject(value) || value.version !== 1) return refuse("manifest is not a version 1 manifest")
  const { base, head, mergeBase, diff, diffstat, files, skipped } = value
  if (![base, head, mergeBase].every((id) => typeof id === "string" && FULL_OBJECT_ID.test(id))) return refuse("manifest base, head or mergeBase is not a full object id")
  for (const [name, part] of [["diff", diff], ["diffstat", diffstat]] as const) if (!isObject(part) || !isHash(part.sha256) || !isCount(part.bytes)) return refuse(`manifest ${name} entry is malformed`)
  if (!Array.isArray(files) || !Array.isArray(skipped)) return refuse("manifest files or skipped is not a list")
  const seen = new Set<string>()
  for (const file of files) {
    if (!isObject(file) || typeof file.path !== "string" || safeRepoPath(file.path) === undefined || !isHash(file.sha256) || !isCount(file.bytes)) return refuse("manifest holds a malformed file entry")
    if (seen.has(file.path)) return refuse(`manifest lists ${file.path} twice`)
    seen.add(file.path)
  }
  return { ok: true, manifest: value as unknown as Manifest }
}

/** A manifest this large is not one `exportReview` wrote: 300 files at a few hundred bytes each. */
const MAX_MANIFEST_BYTES = 1024 * 1024

/**
 * The bytes of `name` at `path`, read through the shared bounded reader: a FIFO, device or symlink is
 * refused without being opened, and a file above `maxBytes` is refused before any buffer is allocated.
 * The directory is model-writable, so neither a blocking open nor a huge allocation may be possible.
 */
function readExact(path: string, name: string, maxBytes: number): { ok: true; bytes: Buffer } | Refusal {
  const read = readBoundedBytes(path, maxBytes)
  if (read.kind === "bytes") return { ok: true, bytes: read.bytes }
  if (read.kind === "absent") return refuse(`${name} is missing`)
  return refuse(read.reason === "too-large" ? `${name} is larger than the ${maxBytes} bytes allowed` : `${name} is not a regular file`)
}

/**
 * Check that the export in `dir` is exactly what was recorded. `recordedHash` is the manifest hash
 * kept in plugin storage when the export was made; it is the trust anchor, because the whole
 * directory is model-writable. Refuses when: the directory or anything in it is a symlink or not a
 * regular file or directory; `manifest.json` does not hash to `recordedHash` or is malformed; the
 * directory is not named `<head>/<manifest hash>` as the manifest says; a file, the diff or the
 * diffstat differs from its recorded SHA-256 or size; or there is any file or directory the
 * manifest does not list, or a listed file is missing. Call it immediately before a reviewer reads
 * the export; it cannot stop a write that happens after it returns.
 */
export function verifyExport(dir: string, recordedHash: string): VerifyResult {
  if (!SHA256.test(recordedHash)) return refuse("the recorded manifest hash is not a lowercase SHA-256")
  const root = lstatOrUndefined(dir)
  if (root === undefined) return refuse(`${dir} does not exist`)
  if (!root.isDirectory()) return refuse(`${dir} is not a plain directory (a symlink or a file)`)
  const manifestRead = readExact(join(dir, MANIFEST), MANIFEST, MAX_MANIFEST_BYTES)
  if (!manifestRead.ok) return manifestRead
  const manifestBytes = manifestRead.bytes
  if (sha256(manifestBytes) !== recordedHash) return refuse("manifest hash differs from the recorded one: the export was changed or replaced")
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"))
  } catch {
    return refuse("manifest is not JSON")
  }
  const read = readManifest(parsed)
  if (!read.ok) return read
  const { manifest } = read
  if (basename(dir) !== recordedHash || basename(dirname(dir)) !== manifest.head) return refuse(`${dir} is not named <head>/<manifest hash> as its manifest says`)

  const expectedDirs = new Set<string>()
  for (const file of manifest.files) {
    const parts = file.path.split("/")
    for (let end = 1; end < parts.length; end++) expectedDirs.add(parts.slice(0, end).join("/"))
  }
  const listed = new Map(manifest.files.map((file) => [file.path, file]))
  const top = new Set<string>([MANIFEST, "round.diff", "diffstat.txt", "files"])
  for (const name of readdirSync(dir)) if (!top.has(name)) return refuse(`unexpected entry ${name}`)
  for (const name of top) if (lstatOrUndefined(join(dir, name)) === undefined) return refuse(`${name} is missing`)

  for (const [name, recorded] of [["round.diff", manifest.diff], ["diffstat.txt", manifest.diffstat]] as const) {
    const read = readExact(join(dir, name), name, recorded.bytes)
    if (!read.ok) return read
    const { bytes } = read
    if (bytes.length !== recorded.bytes || sha256(bytes) !== recorded.sha256) return refuse(`${name} differs from its recorded SHA-256`)
  }

  const filesRoot = join(dir, "files")
  if (!lstatOrUndefined(filesRoot)?.isDirectory()) return refuse("files is not a plain directory")
  const found = new Set<string>()
  const walk = (absolute: string, relative: string): Refusal | undefined => {
    for (const name of readdirSync(absolute)) {
      const path = relative === "" ? name : `${relative}/${name}`
      const stat = lstatSync(join(absolute, name))
      if (stat.isSymbolicLink()) return refuse(`${path} is a symlink`)
      if (stat.isDirectory()) {
        if (!expectedDirs.has(path)) return refuse(`unexpected directory ${path}`)
        const inner = walk(join(absolute, name), path)
        if (inner) return inner
      } else if (stat.isFile()) {
        if (!listed.has(path)) return refuse(`unexpected file ${path}`)
        found.add(path)
      } else return refuse(`${path} is not a regular file`)
    }
    return undefined
  }
  const walked = walk(filesRoot, "")
  if (walked) return walked
  for (const file of manifest.files) {
    if (!found.has(file.path)) return refuse(`missing file ${file.path}`)
    const read = readExact(join(filesRoot, file.path), file.path, file.bytes)
    if (!read.ok) return read
    const { bytes } = read
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) return refuse(`${file.path} differs from its recorded SHA-256`)
  }
  return { ok: true, manifest, manifestHash: recordedHash }
}
