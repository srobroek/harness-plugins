// Checks every shipped Pi agent against how pi-subagents runs a child session: the child
// gets only the tools its `tools` list names, a foreground child loads none of its parent's
// extensions, and a child without `write` or `edit` hands a file back only through the
// `output` option, which saves its final reply.

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { CONTEXT_MODE_TOOLS, PI_LENS_TOOLS, PI_WEB_TOOLS, type PiAgent, piAgents } from "./pi-agents.ts"

const PLUGINS = path.join(import.meta.dir, "..", "plugins")

/** Pi's built-in tools and the child tools pi-subagents adds; no extension provides them. */
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "subagent", "contact_supervisor"])

/** The tools of the third-party Pi packages the agents load. */
const THIRD_PARTY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "npm:context-mode": CONTEXT_MODE_TOOLS,
  "npm:pi-lens": PI_LENS_TOOLS,
  "npm:pi-web-access": PI_WEB_TOOLS,
}

/** Tools that change files. `lsp_navigation` applies renames and code actions. */
const WRITE_TOOLS = ["edit", "write", "ast_grep_replace", "lsp_navigation"]

/** The rule every agent without `write` or `edit` carries, word for word. */
const OUTPUT_FILE_RULE =
  "You have no write tool. When the task names an output file, your final reply becomes that file: pi-subagents saves it there. Never try to write the file yourself, even when told to; do not mention that you cannot, and do not wrap the reply in a code fence. When the task asks for a file but names no output path, return the full content for the caller to save."

/** The names a Pi extension bundle registers, read by running it against a host that records `registerTool`. */
async function registeredTools(bundle: string): Promise<string[]> {
  const names: string[] = []
  const host = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "registerTool" ? (tool: { name: string }) => void names.push(tool.name) : () => undefined,
    },
  )
  const mod = (await import(bundle)) as { default?: (pi: unknown) => unknown }
  await mod.default?.(host)
  return names
}

/** The bundles of the plugin whose Pi package is `name`. */
function packageBundles(name: string): string[] {
  for (const plugin of readdirSync(PLUGINS)) {
    const manifest = path.join(PLUGINS, plugin, "pi", "package.json")
    if (!existsSync(manifest) || (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name !== name) continue
    const dir = path.join(PLUGINS, plugin, "pi", "extensions")
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((file) => file.endsWith(".js"))
          .map((file) => path.join(dir, file))
      : []
  }
  return []
}

/** The tools one `subagentOnlyExtensions` entry of `agent` provides; undefined when the entry resolves to nothing. */
async function providedTools(agent: PiAgent, source: string): Promise<string[] | undefined> {
  const thirdParty = THIRD_PARTY_TOOLS[source]
  if (thirdParty !== undefined) return [...thirdParty]
  const bundles = source.startsWith("npm:")
    ? packageBundles(source.slice("npm:".length))
    : [path.resolve(PLUGINS, agent.plugin, "pi", "agents", source)].filter(existsSync)
  if (bundles.length === 0) return undefined
  return (await Promise.all(bundles.map(registeredTools))).flat()
}

const agents = piAgents(PLUGINS)
const label = (agent: PiAgent) => `${agent.plugin}/${agent.id}`

test("the scan finds the shipped Pi agents", () => {
  expect(agents.map(label)).toContain("architecture/architect")
  expect(agents.map(label)).toContain("journeys/journey-scribe")
})

describe("each tool a Pi agent names is a built-in or comes from an extension it loads", () => {
  test.each(agents.map((agent) => [label(agent), agent] as const))("%s", async (_name, agent) => {
    const provided = new Set<string>()
    for (const source of agent.extensions) {
      const tools = await providedTools(agent, source)
      expect({ source, resolves: tools !== undefined }).toEqual({ source, resolves: true })
      for (const tool of tools ?? []) provided.add(tool)
    }
    const unprovided = agent.tools.filter((tool) => !tool.startsWith("mcp:") && !BUILTIN_TOOLS.has(tool) && !provided.has(tool))
    expect(unprovided).toEqual([])
  })
})

describe("a Pi agent without write or edit hands files back through output", () => {
  const readOnly = agents.filter((agent) => !agent.tools.includes("write") && !agent.tools.includes("edit"))

  test("some shipped agents are read-only", () => {
    expect(readOnly.map(label)).toContain("architecture/architect")
  })

  test.each(readOnly.map((agent) => [label(agent), agent] as const))("%s", (_name, agent) => {
    expect({
      writes: agent.tools.filter((tool) => WRITE_TOOLS.includes(tool)),
      rule: agent.body.includes(OUTPUT_FILE_RULE),
      acceptanceRole: agent.acceptanceRole,
    }).toEqual({ writes: [], rule: true, acceptanceRole: "read-only" })
  })
})

test("every npm package a plugin's Pi agents load is a required companion of that plugin", () => {
  for (const [plugin, owned] of Map.groupBy(agents, (agent) => agent.plugin)) {
    const manifest = JSON.parse(readFileSync(path.join(PLUGINS, plugin, "package.json"), "utf8")) as {
      "agent-plugins"?: { companions?: { package: string; required?: boolean }[] }
    }
    const required = new Set(
      (manifest["agent-plugins"]?.companions ?? []).filter((companion) => companion.required).map((companion) => companion.package),
    )
    const own = (JSON.parse(readFileSync(path.join(PLUGINS, plugin, "pi", "package.json"), "utf8")) as { name: string }).name
    const loaded = new Set(
      owned.flatMap((agent) => agent.extensions.filter((source) => source.startsWith("npm:")).map((source) => source.slice("npm:".length))),
    )
    const missing = [...loaded].filter((name) => name !== own && !required.has(name))
    expect({ plugin, missing }).toEqual({ plugin, missing: [] })
  }
})
