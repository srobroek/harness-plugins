import { isAbsolute, resolve } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { DepRow } from "../../../lib/src/dep-detect.js"
import { detectProject } from "../../../lib/src/dep-detect.js"

const DESCRIPTION =
  "List a project's root dependencies with declared and locked versions, offline and read-only.\n" +
  "Reads npm (package.json + package-lock.json), " +
  "Python (pyproject.toml or requirements.txt + uv.lock/poetry.lock), Cargo.toml, go.mod, Gemfile, composer.json. " +
  "One tab-separated row per dependency: ecosystem, name, declared spec, resolved lockfile version ('?' when " +
  "unlocked), direct|transitive. Use resolved as the installed version when present. Input for what's-new research."

export const versionGapScanParameters = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "Project root to scan; defaults to the session directory" })),
  },
  { additionalProperties: false },
)

export async function scanVersionGaps(target: string): Promise<{
  text: string
  details: { deps: DepRow[]; coverage: { gaps: string[] }; count: number }
}> {
  const { exit, rows, stderr, coverage } = await detectProject(target)
  if (exit !== 0) throw new Error(`version_gap_scan failed (exit ${exit}):\n${stderr}`)
  const deps = rows.map(({ ecosystem, name, declared, resolved, direct }) => ({ ecosystem, name, declared, resolved, direct }))
  const lines = rows.map(({ ecosystem, name, declared, resolved, direct }) =>
    [ecosystem, name, declared, resolved ?? "?", direct ? "direct" : "transitive"].join("\t"),
  )
  return {
    text: [lines.join("\n"), stderr.trim()].filter(Boolean).join("\n"),
    details: { deps, coverage, count: deps.length },
  }
}

export default function registerVersionGapScan(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "version_gap_scan",
    label: "Version gap scan",
    description: DESCRIPTION,
    parameters: versionGapScanParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = params.path === undefined
        ? ctx.cwd
        : isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path)
      const { text, details } = await scanVersionGaps(target)
      return { content: [{ type: "text", text }], details }
    },
  })
}
