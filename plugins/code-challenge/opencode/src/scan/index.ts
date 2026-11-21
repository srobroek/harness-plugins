import { realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { consentRisks, type Risk, runScan, type ScanDeps, validRunId } from "./run.ts"
import { DEPTHS, LANGUAGES, LENSES, type ScanInput, type ScanReport } from "./types.ts"

export { spawnTool } from "./exec.ts"
export { parseOutput } from "./parsers.ts"
export { RECIPES } from "./recipes.ts"
export type { Exec, ScanDeps } from "./run.ts"
export { consentRisks, detectLanguages, expandFiles, resolveTool, runScan } from "./run.ts"
export * from "./types.ts"

export const SCAN_TOOL = "challenge_scan"

/** Longest candidate list returned inline; the full list is in the raw output directory when a runId is given. */
export const MAX_INLINE_CANDIDATES = 500

export const SCAN_DESCRIPTION =
  "Run existing static analyzers in a lens profile and return normalised code-challenge candidates.\n" +
  "Not read-only: clippy builds the crate (build scripts, proc macros; writes target/), golangci-lint and deadcode " +
  "compile Go, knip and import-linter load repo config code, and one-off bunx/uvx/go runs download and run pinned " +
  "packages. Those recipes run only after the user approves the root; otherwise they are coverage gaps. " +
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
  if (input.runId !== undefined && (typeof input.runId !== "string" || !validRunId(input.runId))) {
    return "runId must be 1-64 characters of letters, digits, underscore, dot or dash, starting with a letter, digit or underscore"
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

type Evaluation = {
  action: string
  resources: ReadonlyArray<string>
  metadata?: Record<string, unknown>
  effect: string
  message?: string
}

/**
 * Turn an allowed scan that would run repository or downloaded code into a prompt. The default
 * policy allows every action, so without this the consent would never be asked.
 */
export function confirmScan(evaluation: Evaluation): void {
  if (evaluation.action !== SCAN_TOOL || evaluation.effect !== "allow") return
  const recipes = (evaluation.metadata?.recipes ?? []) as Risk[]
  if (!Array.isArray(recipes) || recipes.length === 0) return
  evaluation.effect = "ask"
  evaluation.message =
    `challenge_scan in ${evaluation.resources.join(", ")} will run code that is not static analysis. ` +
    "There is no sandbox: these recipes run with your user's permissions. Recipes that are not approved are skipped as coverage gaps.\n" +
    recipes.map((r) => `- ${r.recipe}: ${r.reasons.join("; ")}`).join("\n")
}

/** Register `challenge_scan`; the returned function disposes the registrations. */
export async function registerScanTool(ctx: Context, deps: ScanDeps = {}): Promise<() => Promise<void>> {
  const base = ctx.location.directory as string
  const registrations: Array<{ dispose: () => Promise<void> }> = []
  registrations.push(
    await ctx.tool.transform((editor) => {
      editor.add({
        name: SCAN_TOOL,
        description: SCAN_DESCRIPTION,
        input: SCAN_INPUT as never,
        execute: async (raw, context) => {
          const parsed = readScanInput(raw, base)
          if (typeof parsed === "string") return { content: `${SCAN_TOOL}: ${parsed}`, metadata: { ok: false } }
          try {
            // Consent is per canonical root, so a symlink or a relative path cannot dodge or widen it.
            const root = realpathSync(parsed.root ?? base)
            const input = { ...parsed, root }
            const risks = await consentRisks(input, deps)
            let consent = deps.consent ?? false
            if (risks.length > 0 && !consent) {
              consent = await ctx.permission
                .assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                  action: SCAN_TOOL,
                  resources: [root],
                  save: [root],
                  metadata: { depth: input.depth ?? "standard", recipes: risks },
                } as never)
                .then(
                  () => true,
                  () => false,
                )
            } else if (risks.length === 0) consent = true
            const report = await runScan(input, { ...deps, consent }, context.signal)
            return { content: formatScan(report), metadata: { ok: true, candidates: report.candidates.length, coverage: report.coverage } }
          } catch (error) {
            return { content: `${SCAN_TOOL}: ${(error as Error).message}`, metadata: { ok: false } }
          }
        },
      })
    }),
  )
  registrations.push(await ctx.permission.hook("evaluate", confirmScan as never))
  return async () => {
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}
