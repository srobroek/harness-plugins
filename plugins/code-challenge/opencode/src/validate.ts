import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Context } from "@opencode/plugin/promise/plugin"
import { type BoundedBytes, readBoundedBytes } from "@srobroek/opencode-lib/bounded-read"
import { type Schema, validate } from "./json-schema.ts"
import { sessionDirectory } from "./session-directory.ts"

export const VALIDATE_TOOL = "challenge_validate"

// A report with a few dozen findings is tens of KiB; 1 MiB bounds a hostile or runaway file.
export const MAX_RUN_FILE_BYTES = 1024 * 1024

export const VALIDATE_DESCRIPTION =
  "Validate a code-challenge run's report.json and decisions.jsonl against the shipped JSON Schemas.\n" +
  "Takes the absolute run directory, which must sit directly under <git-dir>/code-challenge/ of the session's repository. " +
  "Reads only those two regular files (at most 1 MiB each), lists every error as file, path and message, and " +
  "reports ok=false when a file is missing, oversized or invalid."

export const VALIDATE_INPUT = {
  type: "object",
  properties: { run_dir: { type: "string", description: "Absolute path of the run directory" } },
  required: ["run_dir"],
  additionalProperties: false,
} as const

// The shipped references: `src/` and the bundled `dist/` both sit one level below `skills/`.
const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "code-challenge", "references")

const load = (name: string) => JSON.parse(readBoundedText(join(SCHEMAS, name))) as Schema

// Why a bounded read failed, in words that keep the fs error code (ENOENT, EACCES).
function failure(read: Exclude<BoundedBytes, { kind: "bytes" }>): string {
  if (read.kind === "absent") return "ENOENT: no such file or directory"
  if (read.reason === "not-regular") return "not a regular file"
  if (read.reason === "too-large") return `larger than ${MAX_RUN_FILE_BYTES} bytes`
  return `${read.code ?? "EIO"}: cannot be read`
}

function readBoundedText(path: string): string {
  const read = readBoundedBytes(path, MAX_RUN_FILE_BYTES)
  if (read.kind !== "bytes") throw new Error(`${path}: ${failure(read)}`)
  return read.bytes.toString("utf8")
}

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Errors of one run directory, each prefixed with its file (and line, for decisions.jsonl). Empty when valid. */
export function validateRun(runDir: string): string[] {
  const errors: string[] = []
  const read = (name: string): string | undefined => {
    const result = readBoundedBytes(join(runDir, name), MAX_RUN_FILE_BYTES)
    if (result.kind === "bytes") return result.bytes.toString("utf8")
    errors.push(`${name}: ${failure(result)}`)
    return undefined
  }
  const report = read("report.json")
  if (report !== undefined) {
    try {
      for (const error of validate(load("report.schema.json"), JSON.parse(report))) errors.push(`report.json ${error}`)
    } catch (cause) {
      errors.push(`report.json: ${reason(cause)}`)
    }
  }
  const decisions = read("decisions.jsonl")
  if (decisions !== undefined) {
    const schema = load("decisions.schema.json")
    const lines = decisions.split("\n")
    lines.forEach((text, index) => {
      if (text.trim() === "") return
      try {
        for (const error of validate(schema, JSON.parse(text))) errors.push(`decisions.jsonl:${index + 1} ${error}`)
      } catch (cause) {
        errors.push(`decisions.jsonl:${index + 1}: ${reason(cause)}`)
      }
    })
    if (lines.every((text) => text.trim() === "")) errors.push("decisions.jsonl: has no lines")
  }
  return errors
}

/** The real `<git-dir>/code-challenge` roots of the repository at `directory` (the worktree's own and the common one). */
function runRoots(directory: string): string[] {
  const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  })
  const roots = new Set<string>()
  for (const gitDir of out.split("\n").filter(Boolean)) {
    try {
      roots.add(join(realpathSync(gitDir), "code-challenge"))
    } catch {
      // A missing git directory contributes no root.
    }
  }
  return [...roots]
}

/**
 * The real path of a run directory, or the reason it is refused. It must be absolute, hold no `..`, and after
 * `realpath` sit directly inside `<git-dir>/code-challenge/`, so a symlinked directory cannot lead elsewhere.
 */
export function resolveRunDir(directory: string, runDir: unknown): { path: string } | { error: string } {
  const inside = `${VALIDATE_TOOL}: run_dir must be inside <git-dir>/code-challenge/ of the session's repository`
  if (typeof runDir !== "string" || !isAbsolute(runDir)) return { error: `${VALIDATE_TOOL}: run_dir must be an absolute path` }
  if (runDir.split(/[\\/]/).includes("..")) return { error: inside }
  let roots: string[]
  let real: string
  try {
    roots = runRoots(directory)
    real = realpathSync(runDir)
  } catch (cause) {
    return { error: `${VALIDATE_TOOL}: cannot resolve run_dir: ${reason(cause).split(",")[0]}` }
  }
  const direct = (root: string) => {
    const rel = relative(root, real)
    return rel !== "" && !rel.startsWith("..") && !rel.includes(sep) && !isAbsolute(rel)
  }
  return roots.some(direct) ? { path: real } : { error: inside }
}

/** Register `challenge_validate`. Dispose the returned registration with the plugin's other cleanups. */
export function registerValidateTool(ctx: Context) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: VALIDATE_TOOL,
      description: VALIDATE_DESCRIPTION,
      input: VALIDATE_INPUT,
      execute: async (input, context) => {
        const keys = Object.keys((input ?? {}) as object)
        if (keys.length !== 1 || keys[0] !== "run_dir")
          return { content: `${VALIDATE_TOOL}: expected exactly { run_dir }`, metadata: { ok: false } }
        const directory = await sessionDirectory(ctx, context.sessionID, VALIDATE_TOOL)
        const resolved = resolveRunDir(directory, (input as { run_dir?: unknown }).run_dir)
        if ("error" in resolved) return { content: resolved.error, metadata: { ok: false } }
        const errors = validateRun(resolved.path)
        return {
          content: errors.length === 0 ? "report.json and decisions.jsonl are valid" : errors.join("\n"),
          metadata: { ok: errors.length === 0, errors },
        }
      },
    })
  })
}
