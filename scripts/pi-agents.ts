// The Pi agents this repository ships: `plugins/<name>/common/agents/<id>.pi.md`, which
// harness-kit copies to `plugins/<name>/pi/agents/<id>.md` without translation.

import { readFileSync } from "node:fs"
import path from "node:path"
import { isPiAgentFile } from "./agent-files.ts"

export type PiAgent = {
  plugin: string
  id: string
  /** The `tools` allowlist: tool names, `mcp:` selectors and extension paths. */
  tools: string[]
  /** `subagentOnlyExtensions`: `npm:<package>` or a path relative to the shipped `pi/agents/` file. */
  extensions: string[]
  body: string
  /** `acceptanceRole`: `read-only` keeps pi-subagents from asking the child for a writer's acceptance report. */
  acceptanceRole: string | undefined
}

/** pi-web-access 0.48's tools; on Pi they stand in for OpenCode's webfetch and websearch. */
export const PI_WEB_TOOLS: readonly string[] = ["web_search", "fetch_content", "get_search_content", "source_check"]

/** pi-lens 4.5's code-intelligence tools that agents name. */
export const PI_LENS_TOOLS: readonly string[] = [
  "symbol_search",
  "module_report",
  "project_report",
  "read_symbol",
  "read_enclosing",
  "ast_grep_search",
  "ast_grep_outline",
  "ast_grep_replace",
  "lens_diagnostics",
  "pi_lens_activate_tools",
  "lsp_navigation",
]

/** A frontmatter list: pi-subagents takes a comma-separated string or a YAML list. */
function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== "string") return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Every Pi agent under `plugins`, sorted by plugin and id. */
export function piAgents(plugins: string): PiAgent[] {
  return [...new Bun.Glob("*/common/agents/*.md").scanSync(plugins)]
    .filter((file) => isPiAgentFile(path.basename(file)))
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(plugins, file), "utf8")
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
      const data = (Bun.YAML.parse(match?.[1] ?? "") ?? {}) as Record<string, unknown>
      return {
        plugin: file.split("/")[0] as string,
        id: path.basename(file, ".pi.md"),
        tools: list(data.tools),
        extensions: list(data.subagentOnlyExtensions),
        body: text.slice(match?.[0].length ?? 0),
        acceptanceRole: typeof data.acceptanceRole === "string" ? data.acceptanceRole : undefined,
      }
    })
}
