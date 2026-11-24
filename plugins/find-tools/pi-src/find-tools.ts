import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { evaluationKind, MESSAGES } from "../shared/install-gate.js"
import type { LocalInventory } from "../shared/scan.js"
import { renderScan, SOURCES, scanSources } from "../shared/scan.js"


/** Read the agent-directory package declarations and discover skill metadata without writes. */
export async function readPiInventory(agentDirOverride?: string): Promise<{ packages: unknown[]; skills: unknown[]; mcp: unknown[] }> {
  const agentDir = agentDirOverride ?? getAgentDir()
  let packages: unknown[] = []
  try {
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown }
    if (Array.isArray(settings.packages)) packages = settings.packages
  } catch {
    // Missing or invalid settings leave the package inventory empty.
  }
  const skills: Array<{ name: string; description?: string }> = []
  const root = join(agentDir, "skills")
  const visit = async (dir: string): Promise<void> => {
    let entries: Dirent<string>[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name))
        continue
      }
      if (entry.name !== "SKILL.md") continue
      try {
        const text = await readFile(join(dir, entry.name), "utf8")
        const frontmatter = /^---\s*\n([\s\S]*?)\n---/u.exec(text)?.[1] ?? ""
        const name = /^name:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim()
        if (!name) continue
        const description = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim()
        skills.push({ name, ...(description ? { description } : {}) })
      } catch {
        // Ignore unreadable skill files; inventory must remain read-only and best-effort.
      }
    }
  }
  await visit(root)
  let mcp: unknown[] = []
  try {
    const config = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8")) as unknown
    const rawServers = config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).mcpServers ?? (config as Record<string, unknown>).servers ?? (config as Record<string, unknown>).mcp
      : undefined
    if (rawServers && typeof rawServers === "object" && !Array.isArray(rawServers)) mcp = Object.values(rawServers as Record<string, unknown>)
  } catch {
    // Missing or invalid MCP config leaves its inventory empty.
  }
  return { packages, skills, mcp }
}

export async function readOmpInventory(exec: (command: string, args: string[]) => Promise<{ stdout: string; code: number }>): Promise<{ plugins: unknown[] }> {
  const result = await exec("omp", ["plugin", "list", "--json"])
  if (result.code !== 0) throw new Error("omp plugin list failed")
  const data = JSON.parse(result.stdout) as { marketplace?: unknown; npm?: unknown }
  const marketplace = Array.isArray(data.marketplace) ? data.marketplace.flatMap((group) => {
    if (!group || typeof group !== "object") return []
    const value = group as { id?: unknown; entries?: unknown }
    const entries = Array.isArray(value.entries) ? value.entries : []
    const active = entries.some((entry) => entry && typeof entry === "object" && (entry as { enabled?: unknown }).enabled !== false)
    return active && typeof value.id === "string" ? [{ id: value.id }] : []
  }) : []
  const npm = Array.isArray(data.npm) ? data.npm.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const plugin = item as { name?: unknown; enabled?: unknown }
    return plugin.enabled !== false && typeof plugin.name === "string" ? [{ id: plugin.name }] : []
  }) : []
  return { plugins: [...marketplace, ...npm] }
}

export function isOmpHost(pi: ExtensionAPI): boolean {
  return (pi as ExtensionAPI & { runtime?: unknown }).runtime !== undefined
}

export function ompInventory(exec: (command: string, args: string[]) => Promise<{ stdout: string; code: number }>): LocalInventory {
  return { plugins: async () => (await readOmpInventory(exec)).plugins }
}

const piInventory = (agentDir: string): LocalInventory => ({
  pi: () => readPiInventory(agentDir),
})

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "find_tools_scan",
    label: "Find tools",
    description:
      "Read-only discovery of plugins, skills and MCP servers for a capability. Sources run in parallel, 10 s each: local (installed host plugins and skills; MCP as counts only), catalog (harness-plugins marketplace and configured skill catalogs), mcp_registry, npm, github (gh api), awesome_opencode (unvetted), smithery (needs SMITHERY_API_KEY), skills_cli (reported gap, never run). Each source reports ok, empty, partial, skipped or failed, with gaps and coverage. Install hints are shown, never run.",
    parameters: Type.Object(
      {
        query: Type.String({ description: "The capability to find, in a few words" }),
        sources: Type.Optional(
          Type.Array(Type.String({ enum: [...SOURCES] }), {
            description: "Optional subset of sources; all by default",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal) {
      try {
        const ompHost = isOmpHost(pi)
        const inventory = ompHost
          ? ompInventory(async (command, args) => pi.exec(command, args, { signal, timeout: 10_000, maxBuffer: 1_000_000 }))
          : piInventory(getAgentDir())
        const report = await scanSources(params, {
          signal,
          local: inventory,
          harness: ompHost ? "omp" : "pi",
        })
        return { content: [{ type: "text", text: renderScan(report) }], details: report }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: "text", text: `find_tools_scan error: ${message}` }],
          details: { results: [], gaps: [], coverage: { answered: 0, empty: 0, partial: 0, unavailable: 0, failed: 0 }, error: message },
          isError: true,
        }
      }
    },
  })

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return
    const kind = evaluationKind([event.input.command], { command: event.input.command })
    if (!kind) return
    if (!ctx.hasUI) return { block: true, reason: `find-tools blocked guarded install without UI: ${MESSAGES[kind]}` }
    const confirmed = await ctx.ui.confirm("find-tools: guarded install", MESSAGES[kind])
    if (!confirmed) return { block: true, reason: `find-tools blocked guarded install: ${MESSAGES[kind]}` }
  })
}
