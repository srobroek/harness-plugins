import { isAbsolute, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { runScan, type ScanDeps } from "./run.ts"
import { DEPTHS, LANGUAGES, LENSES, type ScanInput, type ScanReport } from "./types.ts"

export { parseOutput } from "./parsers.ts"
export { RECIPES } from "./recipes.ts"
export type { Exec, ScanDeps } from "./run.ts"
export { spawnTool } from "./exec.ts"
export { detectLanguages, expandFiles, resolveTool, runScan } from "./run.ts"
export * from "./types.ts"

export const SCAN_TOOL = "challenge_scan"

/** Longest candidate list returned inline; the full list is in the raw output directory when a runId is given. */
export const MAX_INLINE_CANDIDATES = 500

export const SCAN_DESCRIPTION =
  "Run existing static analyzers in a lens profile and return normalised code-challenge candidates.\n" +
  "Languages are detected from the root or file list. Each hit carries lens, tool, rule, file, line, message and " +
  "ruleEnabledInRepo (null when unknown). Coverage lists every analyzer as ran, skipped or gap (missing tool, " +
  "timeout, bad exit); timings are per tool. Quick depth skips analyzers that need a build. With runId, raw output " +
  "goes to <git-dir>/code-challenge/<runId>/scan/. Read-only; one-off bunx/uvx/go runs fetch packages, never installs globally."

export const SCAN_INPUT = {
  type: "object",
  properties: {
    root: { type: "string", description: "Target root; defaults to the session directory" },
    files: { type: "array", items: { type: "string" }, description: "Files, directories or globs to scope the scan" },
    languages: { type: "array", items: { enum: [...LANGUAGES] }, description: "Languages; auto-detected by default" },
    lenses: { type: "array", items: { enum: [...LENSES] }, description: "Lenses to keep; all by default" },
    depth: { enum: [...DEPTHS], description: "quick skips analyzers that need a build; default standard" },
    timeoutSeconds: { type: "number", description: "Per-analyzer timeout in seconds; default 120" },
    runId: { type: "string", description: "Run id; raw outputs go to <git-dir>/code-challenge/<runId>/scan/" },
  },
  additionalProperties: false,
} as const

function pick<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v))
}

/** Validate the tool input; a string is the reason it is unusable. */
export function readScanInput(raw: unknown, base: string): ScanInput | string {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const root = typeof input.root === "string" && input.root !== "" ? input.root : base
  const timeout = input.timeoutSeconds
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) return "timeoutSeconds must be a positive number"
  if (input.runId !== undefined && (typeof input.runId !== "string" || !/^[\w.-]+$/.test(input.runId))) {
    return "runId may only hold letters, digits, dot, underscore and dash"
  }
  if (input.depth !== undefined && !(DEPTHS as readonly unknown[]).includes(input.depth)) return `depth must be one of ${DEPTHS.join(", ")}`
  const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === "string") : undefined
  return {
    root: isAbsolute(root) ? root : resolve(base, root),
    files,
    languages: pick(input.languages, LANGUAGES),
    lenses: pick(input.lenses, LENSES),
    depth: input.depth as ScanInput["depth"],
    timeoutSeconds: timeout as number | undefined,
    runId: input.runId as string | undefined,
  }
}

/** The tool result text: the report as JSON, with the candidate list capped. */
export function formatScan(report: ScanReport): string {
  const truncated = report.candidates.length > MAX_INLINE_CANDIDATES
  const shown = truncated ? report.candidates.slice(0, MAX_INLINE_CANDIDATES) : report.candidates
  return JSON.stringify({ ...report, candidates: shown, candidateCount: report.candidates.length, truncated }, null, 1)
}

/** Register `challenge_scan`; the returned function disposes the registration. */
export async function registerScanTool(ctx: Context, deps: ScanDeps = {}): Promise<() => Promise<void>> {
  const base = ctx.location.directory as string
  const registration = await ctx.tool.transform((editor) => {
    editor.add({
      name: SCAN_TOOL,
      description: SCAN_DESCRIPTION,
      input: SCAN_INPUT as never,
      execute: async (raw, context) => {
        const input = readScanInput(raw, base)
        if (typeof input === "string") return { content: `${SCAN_TOOL}: ${input}`, metadata: { ok: false } }
        // One-off runners download and run analyzer packages, so the scan asks once per root.
        await ctx.permission.assert({
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
          action: SCAN_TOOL,
          resources: [input.root ?? base],
          save: [input.root ?? base],
          metadata: { depth: input.depth ?? "standard" },
        } as never)
        try {
          const report = await runScan(input, deps, context.signal)
          return { content: formatScan(report), metadata: { ok: true, candidates: report.candidates.length, coverage: report.coverage } }
        } catch (error) {
          return { content: `${SCAN_TOOL}: ${(error as Error).message}`, metadata: { ok: false } }
        }
      },
    })
  })
  return () => registration.dispose()
}
