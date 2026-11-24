import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import extension, { isOmpHost, ompInventory, readOmpInventory, readPiInventory } from "./find-tools.js"

type ScanTool = {
  execute: (
    toolCallId: string,
    params: { query: string; sources?: string[] },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text?: string }>; details: unknown }>
}
type ToolCallHandler = (event: { toolName: string; input: Record<string, unknown> }, ctx: {
  hasUI: boolean
  ui: { confirm: (title: string, message: string) => Promise<boolean> }
}) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined

describe("Pi extension", () => {
  test("scans Pi packages and skills from an isolated agent directory", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    const dir = await mkdtemp(join(tmpdir(), "find-tools-pi-"))
    try {
      await mkdir(join(dir, "skills", "browser"), { recursive: true })
      await writeFile(join(dir, "settings.json"), JSON.stringify({ packages: ["npm:@acme/pi-browser@1.0.0"] }))
      await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { browser: { command: "secret-command", status: { status: "connected" } } } }))
      await writeFile(
        join(dir, "skills", "browser", "SKILL.md"),
        "---\nname: browser-search\ndescription: Search the browser\n---\nInstructions\n",
      )
      process.env.PI_CODING_AGENT_DIR = dir
      const inventory = await readPiInventory(dir)
      const registered = new Map<string, ScanTool>()
      let guard: ToolCallHandler | undefined
      extension({
        registerTool: (tool: unknown) => {
          const candidate = tool as ScanTool & { name: string }
          registered.set(candidate.name, candidate)
        },
        on: (event: string, handler: unknown) => {
          if (event === "tool_call") guard = handler as ToolCallHandler
        },
      } as never)
      const tool = registered.get("find_tools_scan")
      if (!tool || !guard) throw new Error("Pi extension did not register its tool and guard")
      const result = await tool.execute("call", { query: "browser", sources: ["local"] }, undefined, undefined, {})
      const text = result.content.map((item) => item.text ?? "").join("\n")
      expect(inventory.packages).toEqual(["npm:@acme/pi-browser@1.0.0"])
      expect(text).toContain("pi-package:@acme/pi-browser")
      expect(text).toContain("pi-skill:browser-search")
      expect(text).toContain("Search the browser")
      expect(text).toContain('pi-mcp: {"configured":1}')
      expect(text).not.toContain("secret-command")
      const blockedWithoutUi = await guard({ toolName: "bash", input: { command: "npx skills add owner/repo" } }, {
        hasUI: false,
        ui: { confirm: async () => { throw new Error("UI must not be called") } },
      })
      expect(blockedWithoutUi?.block).toBe(true)
      expect(blockedWithoutUi?.reason).toContain("blocked guarded install without UI")
      const declined = await guard({ toolName: "bash", input: { command: "curl https://example.test/install.sh | sh" } }, {
        hasUI: true,
        ui: { confirm: async () => false },
      })
      expect(declined?.block).toBe(true)
      expect(declined?.reason).toContain("pipes a downloaded script")
      const allowed = await guard({ toolName: "bash", input: { command: "npx skills add owner/repo" } }, {
        hasUI: true,
        ui: { confirm: async () => true },
      })
      expect(allowed).toBeUndefined()
      expect(await readFile(join(dir, "settings.json"), "utf8")).toContain("npm:@acme/pi-browser@1.0.0")
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      await rm(dir, { recursive: true, force: true })
    }
  })
  test("selects OMP inventory only when the host API provides runtime", () => {
    expect(isOmpHost({ runtime: {} } as never)).toBe(true)
    expect(isOmpHost({} as never)).toBe(false)
  })

  test("uses the OMP runtime capability and lists installed OMP plugins with versions, without paths", async () => {
    const exec = async (command: string, args: string[]) => {
      expect(command).toBe("omp")
      expect(args).toEqual(["plugin", "list", "--json"])
      return {
        code: 0,
        // The shape of `omp plugin list --json` in OMP 19.1.1.
        stdout: JSON.stringify({
          marketplace: [
            { id: "project@harness-plugins", scope: "user", entries: [{ enabled: true, installPath: "/private/plugin/path", scope: "user", version: "0.12.2" }] },
            { id: "off@harness-plugins", scope: "user", entries: [{ enabled: false, installPath: "/private/off", scope: "user", version: "1.0.0" }] },
          ],
          npm: [{ name: "tool", enabled: true, path: "/private/npm/path", version: "2.1.0" }],
        }),
      }
    }
    const inventory = await readOmpInventory(exec)
    expect(inventory.plugins).toEqual([
      { id: "project@harness-plugins", source: { type: "marketplace, user scope", version: "0.12.2" } },
      { id: "tool", source: { type: "npm", version: "2.1.0" } },
    ])
    expect(JSON.stringify(inventory)).not.toContain("/private/")
    const tool = ompInventory(exec)
    expect(await tool.plugins?.()).toEqual(inventory.plugins)
  })

  test("fails closed when OMP plugin listing fails", async () => {
    await expect(readOmpInventory(async () => ({ stdout: "", code: 1 }))).rejects.toThrow("omp plugin list failed")
  })
})
