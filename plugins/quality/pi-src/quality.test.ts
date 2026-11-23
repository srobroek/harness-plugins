import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFakeContext } from "@srobroek/opencode-lib/testing";
import { parseTestAuditOptions, setupTestAudit } from "../opencode/src/test-audit.ts";
import qualityPi from "./quality.ts";

type Output = { content: string; metadata: Record<string, unknown> }
type OpenCodeTool = { execute(input: unknown, context: unknown): Promise<Output> }
type PiTool = {
  name: string
  execute(...args: unknown[]): Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>
}

const JUNIT = `<testsuites><testsuite name="suite"><testcase classname="sample" name="passes" time="0.1"/><testcase classname="sample" name="fails" time="0.2"><failure message="expected true">expected true</failure></testcase></testsuite></testsuites>`
const COVERAGE_BASELINE = "TN:\nSF:src/a.ts\nDA:1,1\nDA:2,1\nend_of_record\n"
const COVERAGE_CANDIDATE = "TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n"

async function callOpenCode(directory: string, name: string, input: unknown): Promise<Output> {
  const fake = createFakeContext({ directory })
  const cleanup = await setupTestAudit(fake.context, parseTestAuditOptions({}))
  try {
    const tool = fake.tools.get(name) as OpenCodeTool | undefined
    if (!tool) throw new Error(`OpenCode did not register ${name}`)
    return await tool.execute(input, { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal })
  } finally {
    await cleanup()
  }
}

async function callPi(directory: string, name: string, input: unknown) {
  const registered = new Map<string, PiTool>()
  qualityPi({ registerTool(tool: unknown) { const value = tool as PiTool; registered.set(value.name, value) } } as unknown as ExtensionAPI)
  const tool = registered.get(name)
  if (!tool) throw new Error(`pi did not register ${name}`)
  return tool.execute("call_1", input, undefined, undefined, { cwd: directory })
}

function comparable(output: Awaited<ReturnType<typeof callPi>>): Output {
  return { content: output.content.find((part) => part.type === "text")?.text ?? "", metadata: output.details }
}

describe("quality pi tools", () => {
  test("execute summarize and compare with OpenCode-equivalent output without a model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "quality-pi-parity-"))
    try {
      writeFileSync(join(directory, "run.xml"), JUNIT)
      writeFileSync(join(directory, "baseline.info"), COVERAGE_BASELINE)
      writeFileSync(join(directory, "candidate.info"), COVERAGE_CANDIDATE)
      const cases = [
        ["quality_test_summarize", { reports: ["run.xml"], exitCodes: [1], modes: ["default"] }],
        ["quality_test_compare", { kind: "coverage", baseline: "baseline.info", candidate: "candidate.info", format: "lcov" }],
      ] as const
      for (const [name, input] of cases) {
        const expected = await callOpenCode(directory, name, input)
        expect(comparable(await callPi(directory, name, input))).toEqual(expected)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
