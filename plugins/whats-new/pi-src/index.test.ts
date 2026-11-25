import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import registerWhatsNew from "./index.js"
import { REPORT_ONLY_REASON } from "./report-only-gate.js"

describe("whats-new pi extension", () => {
  test("registers version_gap_scan and returns the scratch npm project's gaps", async () => {
    const project = mkdtempSync(join(tmpdir(), "whats-new-pi-"))
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown>; parameters: unknown }>()
    try {
      writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { leftpad: "1.3.0" } }))
      const pi = {
        registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown>; parameters: unknown }) {
          tools.set(tool.name, tool)
        },
        on() {},
        getSessionName() { return undefined },
      }
      registerWhatsNew(pi as never)
      const tool = tools.get("version_gap_scan")
      expect(tool).toBeDefined()
      const result = await tool?.execute("call", {}, undefined, undefined, { cwd: project }) as {
        content: Array<{ text: string }>
        details: { count: number }
      }
      expect(result.details.count).toBe(1)
      expect(result.content[0]?.text).toContain("npm\tleftpad\t1.3.0\t?\tdirect")
      expect(tool?.parameters).toMatchObject({ properties: { path: { type: "string" } }, additionalProperties: false })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("registered report-only gate blocks a child manifest write", () => {
    let toolCall: ((event: { toolName: string; input: unknown }, ctx: unknown) => unknown) | undefined
    const pi = {
      registerTool() {},
      on(event: string, handler: (...args: unknown[]) => unknown) {
        if (event === "tool_call") toolCall = handler as typeof toolCall
      },
      getSessionName() { return "whats-new: research" },
    }
    registerWhatsNew(pi as never)
    const blocked = toolCall?.(
      { toolName: "write", input: { path: "/tmp/package.json" } },
      {
        getSystemPrompt: () => '<active_agent name="whats-new"/>',
        sessionManager: { getHeader: () => ({ parentSession: "/tmp/parent.jsonl" }) },
      },
    )
    expect(blocked).toMatchObject({ block: true, reason: REPORT_ONLY_REASON })
  })
})
