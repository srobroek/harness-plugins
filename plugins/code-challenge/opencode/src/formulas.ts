import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type FormulaInstallResult, installFormulas as installShipped } from "@srobroek/opencode-lib/formulas"
import type { ToolCall, ToolOutcome } from "./tool-call.ts"

export const SETUP_TOOL = "challenge_setup"

export const SETUP_DESCRIPTION =
  "Copy the code-challenge beads formulas into a beads workspace's .beads/formulas/.\n" +
  "Covers the code-challenge full run and the mol-challenge-<phase> formulas, so bd mol pour finds them. Identical " +
  "copies stay; divergent ones are refused unless force=true; symlinked paths are always refused."

export const SETUP_INPUT = {
  type: "object",
  properties: {
    workspace: { type: "string", description: "Beads workspace root (contains .beads/); default the session directory" },
    force: { type: "boolean", description: "Overwrite code-challenge formulas that differ from the shipped ones" },
  },
  additionalProperties: false,
} as const

/** The full run, then one `mol-` formula per phase. */
export const FORMULAS = [
  "code-challenge",
  "mol-challenge-intake",
  "mol-challenge-scan",
  "mol-challenge-challenge",
  "mol-challenge-lens",
  "mol-challenge-research",
  "mol-challenge-refute",
  "mol-challenge-decide",
  "mol-challenge-deliver",
] as const

/** The shipped `formulas/` directory: `src/` and the bundled `dist/` both sit one level below it. */
export const FORMULAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "formulas")

const USAGE = [
  "Pour a full run with: bd mol pour code-challenge --var target=<paths> --var run_id=<run-id>",
  "Bond one lens scout with: bd mol bond mol-challenge-lens <step-id> --var lens=<lens> --var target=<paths> --var run_id=<run-id>",
  "Pour one phase with: bd mol pour mol-challenge-<phase> --var target=<paths> --var run_id=<run-id> --var depth=<depth> --var mode=<mode>",
]

/** Copy the code-challenge formulas into `<workspace>/.beads/formulas/`; see the shared installer for the refusals. */
export function installFormulas(workspace: string, cwd: string, force = false): FormulaInstallResult {
  const result = installShipped({ workspace, cwd, force, names: FORMULAS, sourceDir: FORMULAS_DIR })
  return result.ok ? { ...result, text: [result.text, ...USAGE].join("\n") } : result
}

/** A host's permission check for the resolved workspace; it throws to refuse. OMP gates the tool natively instead. */
export type AuthorizeSetup = (workspace: string, force: boolean) => Promise<void>

/** `challenge_setup` for any host: check the input, resolve the workspace against the session directory, install. */
export async function runSetup(input: unknown, call: ToolCall, authorize?: AuthorizeSetup): Promise<ToolOutcome> {
  const { workspace, force } = (input ?? {}) as { workspace?: unknown; force?: unknown }
  if (workspace !== undefined && (typeof workspace !== "string" || workspace === ""))
    return { content: `${SETUP_TOOL}: workspace must be a non-empty string`, metadata: { ok: false } }
  const cwd = await call.directory()
  const target = resolve(cwd, typeof workspace === "string" ? workspace : ".")
  await authorize?.(target, force === true)
  const result = installFormulas(target, cwd, force === true)
  return {
    content: result.ok ? result.text : `${SETUP_TOOL}: ${result.text}`,
    metadata: { ok: result.ok, copied: result.copied, unchanged: result.unchanged },
  }
}
