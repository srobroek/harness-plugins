import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import {
  installFormulas,
  journeysWrites,
  readIndexParams,
  runJourneys,
} from "../shared/journeys-tool.ts"

const within = (base: string, path: string) => (isAbsolute(path) ? path : resolve(base, path))

export default function (pi: ExtensionAPI): void {
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url))
  const asset = (path: string) => {
    const common = resolve(packageRoot, "common/skills", path)
    const harness = resolve(packageRoot, "pi/skills", path)
    if (existsSync(common)) return common
    if (existsSync(harness)) return harness
    return common
  }
  const journeysScript = asset("journey-init/scripts/journeys.py")
  const formulasDir = asset("journey-verify/formulas")

  pi.registerTool({
    name: "journeys_index",
    label: "Index Journeys",
    description: "Index, structurally lint or prune a user-journeys directory with the bundled journeys.py helper. Lint is structural, not semantic readiness. index rewrites INDEX.md; prune is a dry run unless yes=true. Every prune invocation is confirmed because it may delete runs.",
    parameters: Type.Object({
      command: Type.Union([Type.Literal("index"), Type.Literal("lint"), Type.Literal("prune")]),
      journeysDir: Type.String({ description: "Path to the journeys directory" }),
      keep: Type.Optional(Type.Integer({ minimum: 0, description: "prune: keep the newest N runs (default 20)" })),
      yes: Type.Optional(Type.Boolean({ description: "prune: actually delete (default dry run)" })),
      journey: Type.Optional(Type.String({ description: "prune: the journey directory name; omit only for an authorized directory-wide prune" })),
    }, { required: ["command", "journeysDir"], additionalProperties: false }),
    async execute(_id, raw, signal, _update, ctx) {
      const params = readIndexParams(raw)
      if (typeof params === "string") return { content: [{ type: "text", text: `journeys_index: ${params}` }], details: { ok: false } }
      const resolved = { ...params, journeysDir: within(ctx.cwd, params.journeysDir) }
      if ((resolved.command === "prune" || journeysWrites(resolved)) && !ctx.hasUI)
        return { content: [{ type: "text", text: `journeys_index: ${resolved.command} refused because confirmation UI is unavailable` }], details: { ok: false } }
      if (resolved.command === "prune" || journeysWrites(resolved)) {
        const action = resolved.command === "index"
          ? `write INDEX.md in ${resolved.journeysDir}`
          : resolved.yes === true
            ? `delete selected runs in ${resolved.journeysDir}`
            : `show prune candidates in ${resolved.journeysDir}`
        if (!(await ctx.ui.confirm("Confirm journeys write", action)))
          return { content: [{ type: "text", text: "journeys_index: write cancelled" }], details: { ok: false } }
      }
      try {
        const result = await runJourneys(ctx.cwd, resolved, signal, undefined, undefined, journeysScript)
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
    description: "Copy the journeys plugin's formula TOMLs into a Beads workspace's .beads/formulas/. Identical copies stay; divergent destinations are refused unless force=true; symlinked paths are always refused.",
    parameters: Type.Object({
      repoRoot: Type.String({ description: "Repository root containing .beads/" }),
      force: Type.Optional(Type.Boolean({ description: "Overwrite divergent destination files" })),
    }, { required: ["repoRoot"], additionalProperties: false }),
    async execute(_id, raw, _signal, _update, ctx) {
      const { repoRoot, force } = raw as { repoRoot?: unknown; force?: unknown }
      if (typeof repoRoot !== "string" || repoRoot === "")
        return { content: [{ type: "text", text: "journey_install_formulas: repoRoot is required" }], details: { ok: false } }
      if (!ctx.hasUI) return { content: [{ type: "text", text: "journey_install_formulas: write refused because confirmation UI is unavailable" }], details: { ok: false } }
      const target = within(ctx.cwd, repoRoot)
      if (!(await ctx.ui.confirm("Confirm formula install", `Copy journey formulas into ${target}/.beads/formulas/?`)))
        return { content: [{ type: "text", text: "journey_install_formulas: write cancelled" }], details: { ok: false } }
      const result = installFormulas(repoRoot, force === true, ctx.cwd, formulasDir)
      return { content: [{ type: "text", text: result.text }], details: { ok: result.ok, copied: result.copied, unchanged: result.unchanged } }
    },
  })
}
