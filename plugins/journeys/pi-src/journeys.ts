import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { JOURNEYS_SCRIPT, journeysArgs, journeysWrites, runJourneys, type JourneysCommand, type JourneysIndexParams } from "../opencode/src/journeys-tool.ts"

const execFileAsync = promisify(execFile)
const COMMANDS: readonly JourneysCommand[] = ["index", "lint", "prune"]

function readParams(input: unknown): JourneysIndexParams | string {
  const value = (input ?? {}) as Record<string, unknown>
  const command = value.command as JourneysCommand
  if (!COMMANDS.includes(command)) return "command must be index, lint or prune"
  if (typeof value.journeysDir !== "string" || value.journeysDir === "") return "journeysDir is required"
  const params: JourneysIndexParams = { command, journeysDir: value.journeysDir }
  if (value.keep !== undefined) {
    if (typeof value.keep !== "number" || !Number.isSafeInteger(value.keep) || value.keep < 0) return "keep must be a nonnegative safe integer"
    params.keep = value.keep
  }
  if (value.yes !== undefined) params.yes = value.yes === true
  if (value.journey !== undefined) {
    if (typeof value.journey !== "string" || value.journey === "") return "journey must be a non-empty string"
    params.journey = value.journey
  }
  return params
}

const within = (base: string, path: string) => isAbsolute(path) ? path : resolve(base, path)

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "journeys_index",
    label: "Index Journeys",
    description: "Index, structurally lint, or prune a user-journeys directory with the bundled journeys.py helper. index rewrites INDEX.md; prune is a dry run unless yes=true. Writes require UI confirmation.",
    parameters: Type.Object({
      command: Type.Union([Type.Literal("index"), Type.Literal("lint"), Type.Literal("prune")]),
      journeysDir: Type.String({ description: "Path to the journeys directory" }),
      keep: Type.Optional(Type.Integer({ minimum: 0, description: "For prune, retain the newest N runs (default 20)" })),
      yes: Type.Optional(Type.Boolean({ description: "For prune, actually delete (default dry run)" })),
      journey: Type.Optional(Type.String({ description: "For prune, journey directory name; omit only for authorized directory-wide prune" })),
    }, { required: ["command", "journeysDir"], additionalProperties: false }),
    async execute(_id, raw, signal, _update, ctx) {
      const params = readParams(raw)
      if (typeof params === "string") return { content: [{ type: "text", text: `journeys_index: ${params}` }], details: { ok: false } }
      const resolved = { ...params, journeysDir: within(ctx.cwd, params.journeysDir) }
      if (journeysWrites(resolved)) {
        if (!ctx.hasUI) return { content: [{ type: "text", text: "journeys_index: write refused because confirmation UI is unavailable" }], details: { ok: false } }
        const action = resolved.command === "index" ? `write INDEX.md in ${resolved.journeysDir}` : `delete selected runs in ${resolved.journeysDir}`
        if (!(await ctx.ui.confirm("Confirm journeys write", action))) return { content: [{ type: "text", text: "journeys_index: write cancelled" }], details: { ok: false } }
      }
      try {
        const result = await runJourneys(ctx.cwd, resolved, signal)
        const output = result.stdout && result.stderr ? `${result.stdout}\n${result.stderr}` : result.stdout || result.stderr
        if ("unrun" in result) {
          const text = [`journeys.py ${params.command} did not finish: ${result.unrun}`, output].filter(Boolean).join("\n")
          return { content: [{ type: "text", text }], details: { ok: false, complete: false, command: params.command, unrun: result.unrun } }
        }
        return { content: [{ type: "text", text: output || `journeys.py ${params.command} exited ${result.exitCode}` }], details: { ok: result.exitCode === 0, complete: true, command: params.command, exitCode: result.exitCode } }
      } catch (error) {
        return { content: [{ type: "text", text: `journeys_index: ${error instanceof Error ? error.message : String(error)}` }], details: { ok: false } }
      }
    },
  })

  pi.registerTool({
    name: "journey_install_formulas",
    label: "Install Journey Formulas",
    description: "Copy package-owned journey formula TOMLs into a Beads workspace .beads/formulas/. Identical copies stay; divergent files are refused unless force=true; symlinked paths are refused. Requires UI confirmation.",
    parameters: Type.Object({
      repoRoot: Type.String({ description: "Repository root containing .beads/" }),
      force: Type.Optional(Type.Boolean({ description: "Overwrite divergent destination files" })),
    }, { required: ["repoRoot"], additionalProperties: false }),
    async execute(_id, { repoRoot, force }, _signal, _update, ctx) {
      if (!ctx.hasUI) return { content: [{ type: "text", text: "journey_install_formulas: write refused because confirmation UI is unavailable" }], details: { ok: false } }
      const target = within(ctx.cwd, repoRoot)
      if (!(await ctx.ui.confirm("Confirm formula install", `Copy journey formulas into ${target}/.beads/formulas/?`)))
        return { content: [{ type: "text", text: "journey_install_formulas: write cancelled" }], details: { ok: false } }
      const sources = resolve(JOURNEYS_SCRIPT, "../../journey-verify/formulas")
      const { installFormulas } = await import("../opencode/src/journeys-tool.ts")
      const result = installFormulas(target, force === true, ctx.cwd, sources)
      return { content: [{ type: "text", text: result.text }], details: { ok: result.ok, copied: result.copied, unchanged: result.unchanged } }
    },
  })
}
