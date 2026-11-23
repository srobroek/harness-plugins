import { realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { sessionDirectory } from "../session-directory.ts"
import type { ToolCall, ToolOutcome } from "../tool-call.ts"
import { runScan, type ScanDeps, validRunId } from "./run.ts"
import { DEPTHS, LANGUAGES, LENSES, type ScanInput, type ScanReport } from "./types.ts"

export { spawnTool } from "./exec.ts"
export { parseOutput } from "./parsers.ts"
export { RECIPES } from "./recipes.ts"
export type { Exec, ScanDeps } from "./run.ts"
export { detectLanguages, expandFiles, resolveTool, runScan } from "./run.ts"
export * from "./types.ts"

export const SCAN_TOOL = "challenge_scan"

/** Longest candidate list returned inline; the full list is in the raw output directory when a runId is given. */
export const MAX_INLINE_CANDIDATES = 500

export const SCAN_DESCRIPTION =
  "Run existing static analyzers in a lens profile and return normalised code-challenge candidates.\n" +
  "By default only recipes that execute no repository or downloaded code run; the others are coverage gaps that " +
  "name what they would run. allowCode=true also runs them: clippy builds the crate (build scripts, proc macros; " +
  "writes target/), golangci-lint and deadcode compile Go, knip and import-linter load repo config code, and one-off " +
  "bunx/uvx/go runs download and run pinned packages. Pass allowCode only for a repository the user trusts. " +
  "Hits carry lens, tool, rule, file, line, message, ruleEnabledInRepo. Quick depth skips build-backed analyzers. " +
  "With runId, raw output goes to <git-dir>/code-challenge/<runId>/scan/."

export const SCAN_INPUT = {
  type: "object",
  properties: {
    root: { type: "string", description: "Target root; defaults to the session directory" },
    files: { type: "array", items: { type: "string" }, description: "Files, directories or globs to scope the scan" },
    languages: { type: "array", items: { enum: [...LANGUAGES] }, description: "Languages; auto-detected by default" },
    lenses: { type: "array", items: { enum: [...LENSES] }, description: "Lenses to keep; all by default" },
    depth: { enum: [...DEPTHS], description: "quick skips analyzers that need a build; default standard" },
    timeoutSeconds: { type: "number", maximum: 900, description: "Per-analyzer timeout in seconds; default 120, at most 900" },
    runId: { type: "string", description: "Run id; raw outputs go to <git-dir>/code-challenge/<runId>/scan/" },
    allowCode: { type: "boolean", description: "Also run analyzers that execute repo or downloaded code; only for a trusted repo" },
  },
  additionalProperties: false,
} as const

/** The allowed values of a list input; an unknown one is a reason string, never dropped (that would widen the scan). */
function pick<T extends string>(name: string, value: unknown, allowed: readonly T[]): T[] | undefined | string {
  if (value === undefined) return undefined
  const known = (v: unknown): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v)
  if (!Array.isArray(value) || !value.every(known)) return `${name} must be a list of: ${allowed.join(", ")}`
  return value
}

/** Validate the tool input; a string is the reason it is unusable. */
export function readScanInput(raw: unknown, base: string): ScanInput | string {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const root = typeof input.root === "string" && input.root !== "" ? input.root : base
  const timeout = input.timeoutSeconds
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) return "timeoutSeconds must be a positive number"
  if (input.runId !== undefined && (typeof input.runId !== "string" || !validRunId(input.runId))) {
    return "runId must be 1-64 characters of letters, digits, underscore, dot or dash, starting with a letter, digit or underscore"
  }
  if (input.depth !== undefined && !(DEPTHS as readonly unknown[]).includes(input.depth)) return `depth must be one of ${DEPTHS.join(", ")}`
  if (input.allowCode !== undefined && typeof input.allowCode !== "boolean") return "allowCode must be a boolean"
  const languages = pick("languages", input.languages, LANGUAGES)
  if (typeof languages === "string") return languages
  const lenses = pick("lenses", input.lenses, LENSES)
  if (typeof lenses === "string") return lenses
  const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === "string") : undefined
  return {
    root: isAbsolute(root) ? root : resolve(base, root),
    files,
    languages,
    lenses,
    depth: input.depth as ScanInput["depth"],
    timeoutSeconds: timeout as number | undefined,
    runId: input.runId as string | undefined,
    allowCode: input.allowCode === true ? true : undefined,
  }
}

/** The tool result text: the report as JSON, with the candidate list capped. */
export function formatScan(report: ScanReport): string {
  const truncated = report.candidates.length > MAX_INLINE_CANDIDATES
  const shown = truncated ? report.candidates.slice(0, MAX_INLINE_CANDIDATES) : report.candidates
  return JSON.stringify({ ...report, candidates: shown, candidateCount: report.candidates.length, truncated }, null, 1)
}

/**
 * `challenge_scan` for any host. Without allowCode, a recipe that executes repository or downloaded code
 * is a coverage gap; with it, every planned recipe runs. Nothing is asked: the host's own approval of the
 * tool call is the only gate.
 */
export async function runScanTool(raw: unknown, call: ToolCall, deps: ScanDeps = {}): Promise<ToolOutcome> {
  // The session's directory, not the plugin's: a default or relative root means the project being worked on.
  const base = await call.directory()
  const parsed = readScanInput(raw, base)
  if (typeof parsed === "string") return { content: `${SCAN_TOOL}: ${parsed}`, metadata: { ok: false } }
  try {
    const report = await runScan({ ...parsed, root: realpathSync(parsed.root ?? base) }, deps, call.signal)
    return { content: formatScan(report), metadata: { ok: true, candidates: report.candidates.length, coverage: report.coverage } }
  } catch (error) {
    return { content: `${SCAN_TOOL}: ${(error as Error).message}`, metadata: { ok: false } }
  }
}

/** Register `challenge_scan`; the returned function disposes the registration. */
export async function registerScanTool(ctx: Context, deps: ScanDeps = {}): Promise<() => Promise<void>> {
  const registration = await ctx.tool.transform((editor) => {
    editor.add({
      name: SCAN_TOOL,
      description: SCAN_DESCRIPTION,
      input: SCAN_INPUT as never,
      execute: (raw, context) =>
        runScanTool(raw, { directory: () => sessionDirectory(ctx, context.sessionID, SCAN_TOOL), signal: context.signal }, deps),
    })
  })
  return () => registration.dispose()
}
