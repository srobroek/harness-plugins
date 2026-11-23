import type { Context } from "@opencode/plugin/promise/plugin";
import { compareReports, MAX_MODE_LENGTH, MAX_REPORTS, summarizeReports, TEST_COMPARE_TOOL, TEST_SUMMARIZE_TOOL, type TestAuditOptions } from "../../shared/test-audit.ts";

export type { SummarizeInput, TestAuditOptions } from "../../shared/test-audit.ts";
export { compareReports, MAX_MODE_LENGTH, MAX_REPORTS, parseSummarizeInput, parseTestAuditOptions, summarizeReports, TEST_COMPARE_TOOL, TEST_SUMMARIZE_TOOL } from "../../shared/test-audit.ts";

const COVERAGE_FORMATS = ["lcov", "cobertura", "gocover"]
const MUTATION_FORMATS = ["mutation-testing", "cargo-mutants", "gremlins"]

/** Register both read-only tools unless the options turn them off. Returns the disposer. */
export async function setupTestAudit(ctx: Context, options: TestAuditOptions): Promise<() => Promise<void>> {
  if (options === undefined) return async () => {}
  const root = ctx.location.directory
  const tools = await ctx.tool.transform((editor) => {
    editor.add({
      name: TEST_SUMMARIZE_TOOL,
      description:
        "Read-only: summarize JUnit XML reports from repeated test runs; flaky, always-failing and slow tests.\n" +
        "Run the test command several times through the shell, writing one JUnit report per run, then pass the paths in run " +
        "order. Add modes (default, shuffle-files, shuffle-tests) to split order-dependent from flaky tests. Reports timeout vs " +
        "assertion failures, file size and stderr lines. Reads pytest, Vitest, bun test, gotestsum and cargo-nextest JUnit. " +
        "Paths must be in the session or OpenCode temp directory.",
      input: {
        type: "object",
        properties: {
          reports: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_REPORTS,
            description: "JUnit XML paths, one per run, in run order",
          },
          exitCodes: {
            type: "array",
            items: { type: ["integer", "null"] },
            description: "Exit code of each run, same length as reports; null when unknown",
          },
          noisyStderrLines: { type: "integer", minimum: 1, description: "Flag a run above this many stderr lines; default 1000" },
          noisyFileBytes: { type: "integer", minimum: 1, description: "Flag a run whose report passes this many bytes; default 5000000" },
          modes: {
            type: "array",
            items: { type: "string", maxLength: MAX_MODE_LENGTH },
            description: "Order mode of each run, same length as reports: default, shuffle-files, shuffle-tests or free text",
          },
        },
        required: ["reports"],
        additionalProperties: false,
      },
      execute: async (raw) => summarizeReports(root, raw),
    })
    editor.add({
      name: TEST_COMPARE_TOOL,
      description:
        "Read-only: compare a baseline and a candidate coverage or mutation report to show lost test protection.\n" +
        "Coverage: LCOV, Cobertura XML, Go cover profile. Mutation: Stryker/mutation-testing-report JSON, cargo-mutants " +
        "outcomes.json, Gremlins JSON. Both paths must be in the session or OpenCode temp directory.",
      input: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["coverage", "mutation"], description: "Report kind" },
          baseline: { type: "string", description: "Report before the change; relative to the session directory or absolute" },
          candidate: { type: "string", description: "Report after the change; same rules" },
          format: {
            type: "string",
            enum: [...COVERAGE_FORMATS, ...MUTATION_FORMATS],
            description: "Report format; detected when omitted",
          },
        },
        required: ["kind", "baseline", "candidate"],
        additionalProperties: false,
      },
      execute: async (raw) => compareReports(root, raw as Parameters<typeof compareReports>[1]),
    })
  })
  return async () => {
    await tools.dispose()
  }
}
