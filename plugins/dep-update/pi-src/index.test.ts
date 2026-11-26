import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { formatScan } from "../shared/scan.ts"
import { applyApprovedBump, confirmSetting, default as extension, scannerInstallResult } from "./index.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-dep-update-"))
}

type ToolResult = { content: Array<{ type: string; text?: string }>; details: { complete?: boolean } }
type Tool = { name: string; parameters: unknown; execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, context: unknown) => Promise<ToolResult> }
function fakePi(): { api: ExtensionAPI; tools: Tool[] } {
  const tools: Tool[] = []
  const api = {
    registerTool: (tool: Tool) => tools.push(tool),
    on: () => undefined,
  } as unknown as ExtensionAPI
  return { api, tools }
}

describe("dep-update pi extension", () => {
  test("registers both tools and scans an exact npm dependency", async () => {
    const project = tmp()
    const fixtures = tmp()
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }))
    writeFileSync(join(fixtures, "npm_left-pad.json"), JSON.stringify({ "dist-tags": { latest: "1.3.1" }, versions: { "1.3.0": {}, "1.3.1": {} } }))
    const previous = process.env.DEP_UPDATE_FIXTURE_DIR
    process.env.DEP_UPDATE_FIXTURE_DIR = fixtures
    try {
      const pi = fakePi()
      extension(pi.api)
      expect(pi.tools.map((tool) => tool.name)).toEqual(["dep_scan", "dep_apply"])
      const scan = pi.tools[0]
      expect(scan).toBeDefined()
      if (!scan) throw new Error("dep_scan was not registered")
      const result = await scan.execute("call", {}, undefined, undefined, { cwd: project, hasUI: false })
      expect(result.content.at(0)?.text).toContain("PATCH-SAFE")
      expect(result.content.at(0)?.text).toContain("left-pad")
      expect(result.details.complete).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.DEP_UPDATE_FIXTURE_DIR
      else process.env.DEP_UPDATE_FIXTURE_DIR = previous
      rmSync(project, { recursive: true, force: true })
      rmSync(fixtures, { recursive: true, force: true })
    }
  })

  test("confirm is on only when the dep-update setting sets it to true", () => {
    const dir = tmp()
    const path = join(dir, "settings.json")
    try {
      expect(confirmSetting(path)).toBe(false)
      writeFileSync(path, JSON.stringify({ "dep-update": { confirm: true } }))
      expect(confirmSetting(path)).toBe(true)
      writeFileSync(path, JSON.stringify({ "dep-update": { confirm: "yes" } }))
      expect(confirmSetting(path)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("with confirm on, apply fails closed without UI and does not change a manifest", async () => {
    const project = tmp()
    const manifest = join(project, "package.json")
    const original = JSON.stringify({ dependencies: { leftpad: "1.3.0" } }, null, 2)
    writeFileSync(manifest, original)
    try {
      const ui = { confirm: async () => true }
      const result = await applyApprovedBump({ ecosystem: "npm", name: "leftpad", version: "1.3.1" }, undefined, { cwd: project, hasUI: false, ui }, true)
      expect(result.text).toContain("requires an interactive UI")
      expect(readFileSync(manifest, "utf8")).toBe(original)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("with confirm on, approval names the exact bump and decline leaves the manifest unchanged", async () => {
    const project = tmp()
    const manifest = join(project, "package.json")
    const original = JSON.stringify({ dependencies: { leftpad: "1.3.0" } }, null, 2)
    writeFileSync(manifest, original)
    let prompt = ""
    const controller = new AbortController()
    const context = {
      cwd: project,
      hasUI: true,
      ui: {
        confirm: async (_title: string, message: string, options?: { signal?: AbortSignal }) => {
          prompt = message
          expect(options?.signal).toBe(controller.signal)
          return false
        },
      },
    }
    try {
      const result = await applyApprovedBump({ ecosystem: "npm", name: "leftpad", version: "1.3.1" }, controller.signal, context, true)
      expect(prompt).toContain("npm bump leftpad@1.3.1")
      expect(result.text).toContain("leftpad@1.3.1 was not applied")
      expect(readFileSync(manifest, "utf8")).toBe(original)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("scan formatter preserves classification report", () => {
    const report = formatScan(
      [{ ecosystem: "npm", name: "left-pad", installed: "1.3.0", latest: "1.3.1", status: "OK", class: "PATCH-SAFE" }],
      "registry queried",
    )
    expect(report.text).toContain("PATCH-SAFE")
    expect(report.summary).toEqual({ upgradable: 1, skipped: 0, unchecked: 0 })
  })

  test("scanner advisory modifies successful install results only", () => {
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call",
      input: { command: "pipx install pip-audit" },
      content: [{ type: "text", text: "installed" }],
      isError: false,
      details: undefined,
    } as unknown as ToolResultEvent
    expect(scannerInstallResult(event)?.[0]?.type).toBe("text")
    expect(scannerInstallResult(event)?.at(-1)?.type).toBe("text")
    expect(scannerInstallResult({ ...event, toolName: "read" } as ToolResultEvent)).toBeUndefined()
    expect(scannerInstallResult({ ...event, isError: true })).toBeUndefined()
  })
})
