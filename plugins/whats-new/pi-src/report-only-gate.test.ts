import { describe, expect, test } from "bun:test"
import { blocksWhatsNewToolCall, isWhatsNewWorkflow, REPORT_ONLY_REASON, reportOnlyBlockReason } from "./report-only-gate.js"

const activePrompt = '<active_agent name="whats-new"/>\nReport only.'

describe("report-only pi gate", () => {
  test("detects pi-subagents child identity using its active-agent prompt tag", () => {
    expect(isWhatsNewWorkflow(activePrompt, "worker: researching", true)).toBe(true)
    expect(isWhatsNewWorkflow("ordinary prompt", "whats-new: research", true)).toBe(true)
    expect(isWhatsNewWorkflow("ordinary prompt", "whats-new: research", false)).toBe(false)
    expect(isWhatsNewWorkflow("ordinary prompt", "worker: research", true)).toBe(false)
  })

  test("blocks manifest writes/edits and installers only in whats-new child workflow", () => {
    for (const toolName of ["write", "edit"]) {
      for (const field of ["path", "file_path"]) {
        expect(blocksWhatsNewToolCall({ toolName, input: { [field]: "/tmp/npm/package.json" } }, activePrompt, "whats-new: research", true)).toBe(true)
      }
    }
    expect(blocksWhatsNewToolCall({ toolName: "bash", input: { command: "sudo npm install zod" } }, activePrompt, "whats-new: research", true)).toBe(true)
    expect(blocksWhatsNewToolCall({ toolName: "bash", input: { command: "npm view zod versions --json" } }, activePrompt, "whats-new: research", true)).toBe(false)
    expect(blocksWhatsNewToolCall({ toolName: "write", input: { path: "/tmp/REPORT.md" } }, activePrompt, "whats-new: research", true)).toBe(false)
    expect(blocksWhatsNewToolCall({ toolName: "write", input: { path: "/tmp/package.json" } }, "ordinary prompt", "main", false)).toBe(false)
  })

  test("returns a clear denial reason for blocked calls", () => {
    expect(reportOnlyBlockReason({ toolName: "write", input: { path: "package.json" } })).toBe(REPORT_ONLY_REASON)
  })
})
