import { isAbsolute, resolve } from "node:path"
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { applyBump, researchProject, validOperands } from "@srobroek/opencode-lib/dep-bump"
import { appendResultText } from "@srobroek/opencode-lib/shell-result"
import { shellCommand } from "@srobroek/opencode-lib/tool-targets"
import { Type } from "typebox"
import { persistentScannerInstall, SCANNER_ADVISORY } from "../opencode/src/scanner-install.ts"
import { formatScan } from "../shared/scan.ts"

function projectDir(base: string, path: string | undefined): string {
  if (!path) return base
  return isAbsolute(path) ? path : resolve(base, path)
}

const scanParameters = Type.Object(
  { path: Type.Optional(Type.String({ description: "Project root to scan; defaults to the session directory" })) },
  { additionalProperties: false },
)
const applyParameters = Type.Object(
  {
    ecosystem: Type.String({ description: "pypi, npm, cargo, or go" }),
    name: Type.String({ description: "Package name" }),
    version: Type.String({ description: "Exact target version to pin" }),
    path: Type.Optional(Type.String({ description: "Project root; defaults to the session directory" })),
  },
  { required: ["ecosystem", "name", "version"], additionalProperties: false },
)

export type ApplyContext = { cwd: string; hasUI: boolean; ui: { confirm: (title: string, message: string, options?: { signal?: AbortSignal }) => Promise<boolean> } }

export async function applyApprovedBump(params: { ecosystem: string; name: string; version: string; path?: string }, signal: AbortSignal | undefined, ctx: ApplyContext) {
  const root = projectDir(ctx.cwd, params.path)
  if (!validOperands(params.ecosystem, params.name, params.version)) {
    return { text: "dep_apply: unsupported ecosystem, package name, or exact version; no process started", exit: 2 }
  }
  if (signal?.aborted) return { text: "dep_apply stopped before it started; no changes made.", exit: 1 }
  if (!ctx.hasUI) return { text: "dep_apply requires an interactive UI to approve this exact bump; no changes made.", exit: 1 }
  const resource = `${params.name}@${params.version}`
  const approved = await ctx.ui.confirm(
    "Apply dependency bump?",
    `Apply ${params.ecosystem} bump ${resource} in ${root}? A failed or cancelled package-manager run can leave partial changes.`,
    { signal },
  )
  if (!approved) return { text: `dep_apply cancelled; ${resource} was not applied.`, exit: 1 }
  return applyBump(params.ecosystem, params.name, params.version, root, { signal })
}
/** Append the scanner-install advisory to successful shell results. */
export function scannerInstallResult(event: ToolResultEvent): ToolResultEvent["content"] | undefined {
  if (event.isError) return undefined
  const command = shellCommand(event.toolName, event.input)
  if (command === undefined || persistentScannerInstall(command) === undefined) return undefined
  const appended = appendResultText({ content: event.content.filter((part) => part.type === "text") }, SCANNER_ADVISORY)
  if (typeof appended.content === "string") return [...event.content, { type: "text", text: appended.content }]
  const advisory = appended.content?.at(-1)
  return advisory?.type === "text" ? [...event.content, { type: "text", text: advisory.text }] : undefined
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dep_scan",
    label: "Dependency Scan",
    description:
      "Read-only: classify a project's dependency bumps as PATCH-SAFE, MINOR-CHECK or MAJOR-ADVISORY. Enumerates declared dependencies and queries PyPI/npm for latest versions. A stopped scan returns an incomplete report with unchecked dependencies. Rust and Go deps are advisory-only.",
    parameters: scanParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const dir = projectDir(ctx.cwd, params.path)
      const { exit, records, stderr, complete } = await researchProject(dir, undefined, signal)
      if (exit !== 0) {
        return { content: [{ type: "text", text: `dep_scan failed (exit ${exit}):\n${stderr}` }], details: { exit } }
      }
      const { text, summary } = formatScan(records, stderr)
      return { content: [{ type: "text", text }], details: { records, complete, summary } }
    },
  })

  pi.registerTool({
    name: "dep_apply",
    label: "Apply Dependency Bump",
    description:
      "Apply one exact dependency bump with the ecosystem package manager after explicit user approval. The run is bounded to 10 minutes; failure or cancellation can leave partial changes.",
    parameters: applyParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await applyApprovedBump(params, signal, ctx)
      return { content: [{ type: "text", text: result.text }], details: { exit: result.exit } }
    },
  })

  pi.on("tool_result", (event) => {
    const content = scannerInstallResult(event)
    return content === undefined ? undefined : { content }
  })
}
