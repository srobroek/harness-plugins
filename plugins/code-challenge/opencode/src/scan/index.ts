import { realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { sessionDirectory } from "../session-directory.ts"
import type { ToolCall, ToolOutcome } from "../tool-call.ts"
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
  "packages. Those recipes run only after the user approves them (staticOnly skips them without asking). " +
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
    staticOnly: { type: "boolean", description: "Run only analyzers that execute no repo or downloaded code; ask nothing" },
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
    staticOnly: input.staticOnly === true ? true : undefined,
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

/** The resource a consent is bound to: the canonical root and the exact set of risky recipes. */
export function planResource(root: string, risks: readonly Risk[]): string {
  return `${root} [${risks.map((r) => r.recipe).sort().join(", ")}]`
}

/** What the user is asked to approve: a scan of `root` that would run the listed risky recipes. */
export type ScanConsent = { root: string; depth: string; risks: Risk[]; resource: string }

/** A host's consent prompt; it returns once the user approved and throws to refuse. */
export type AskConsent = (consent: ScanConsent) => Promise<void>

/** The consent prompt text: where the scan runs, that nothing is sandboxed, and each risky recipe with its reasons. */
export function consentMessage(root: string, recipes: readonly Risk[]): string {
  return (
    `challenge_scan in ${root} will run code that is not static analysis. ` +
    "There is no sandbox: these recipes run with your user's permissions. Approving covers exactly these recipes; " +
    "pass staticOnly to scan without them.\n" +
    recipes.map((r) => `- ${r.recipe}: ${r.reasons.join("; ")}`).join("\n")
  )
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
  evaluation.message = consentMessage(String(evaluation.metadata?.root ?? evaluation.resources.join(", ")), recipes)
}

/**
 * `challenge_scan` for any host. A scan whose plan holds a risky recipe runs only after `consent`
 * returns, and then with exactly those recipes approved; staticOnly plans none and asks nothing.
 */
export async function runScanTool(raw: unknown, call: ToolCall & { consent: AskConsent }, deps: ScanDeps = {}): Promise<ToolOutcome> {
  // The session's directory, not the plugin's: a default or relative root means the project being worked on.
  const base = await call.directory()
  const parsed = readScanInput(raw, base)
  if (typeof parsed === "string") return { content: `${SCAN_TOOL}: ${parsed}`, metadata: { ok: false } }
  let input: ScanInput
  let risks: Risk[]
  try {
    // Consent is per canonical root, so a symlink or a relative path cannot dodge or widen it.
    input = { ...parsed, root: realpathSync(parsed.root ?? base) }
    risks = parsed.staticOnly ? [] : await consentRisks(input, deps, call.signal)
  } catch (error) {
    return { content: `${SCAN_TOOL}: ${(error as Error).message}`, metadata: { ok: false } }
  }
  // The approved set is exactly the recipes that were listed. Nothing is approved for a plan
  // with no risk, so a recipe that turns risky before the run is a gap, not a free pass.
  let approved = deps.approved ?? new Set<string>()
  if (risks.length > 0 && deps.approved === undefined) {
    const root = input.root ?? base
    // A refusal propagates as the host defines it; a user who wants the scan without these
    // recipes passes staticOnly instead.
    await call.consent({ root, depth: input.depth ?? "standard", risks, resource: planResource(root, risks) })
    approved = new Set(risks.map((r) => r.recipe))
  }
  try {
    const report = await runScan(input, { ...deps, approved }, call.signal)
    return { content: formatScan(report), metadata: { ok: true, candidates: report.candidates.length, coverage: report.coverage } }
  } catch (error) {
    return { content: `${SCAN_TOOL}: ${(error as Error).message}`, metadata: { ok: false } }
  }
}

/** Register `challenge_scan`; the returned function disposes the registrations. */
export async function registerScanTool(ctx: Context, deps: ScanDeps = {}): Promise<() => Promise<void>> {
  const registrations: Array<{ dispose: () => Promise<void> }> = []
  const cleanup = async () => {
    for (const registration of registrations.reverse()) await registration.dispose()
  }
  try {
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: SCAN_TOOL,
          description: SCAN_DESCRIPTION,
          input: SCAN_INPUT as never,
          execute: (raw, context) =>
            runScanTool(
              raw,
              {
                directory: () => sessionDirectory(ctx, context.sessionID, SCAN_TOOL),
                signal: context.signal,
                consent: async ({ root, depth, risks, resource }) => {
                  await ctx.permission.assert({
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, id: context.id },
                    action: SCAN_TOOL,
                    resources: [resource],
                    save: [resource],
                    metadata: { root, depth, recipes: risks },
                  } as never)
                },
              },
              deps,
            ),
        })
      }),
    )
    registrations.push(await ctx.permission.hook("evaluate", confirmScan as never))
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}
