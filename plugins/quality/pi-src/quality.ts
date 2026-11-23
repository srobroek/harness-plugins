import { mkdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { compareReports, MAX_MODE_LENGTH, MAX_REPORTS, summarizeReports, TEST_COMPARE_TOOL, TEST_SUMMARIZE_TOOL } from "../shared/test-audit.ts"

const PI_REPORTS_TEMP_DIR = join(realpathSync(tmpdir()), "pi", "quality-test-audit")

mkdirSync(PI_REPORTS_TEMP_DIR, { recursive: true })
function result(output: { content: string; metadata: Record<string, unknown> }) {
  return { content: [{ type: "text" as const, text: output.content }], details: output.metadata }
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: TEST_SUMMARIZE_TOOL,
    label: "Summarize test runs",
    description:
      "Read-only: summarize JUnit XML reports from repeated test runs; flaky, always-failing and slow tests.\n" +
      "Run the test command several times through the shell, writing one JUnit report per run, then pass the paths in run " +
      "order. Add modes (default, shuffle-files, shuffle-tests) to split order-dependent from flaky tests. Reports timeout vs " +
      "assertion failures, file size and stderr lines. Reads pytest, Vitest, bun test, gotestsum and cargo-nextest JUnit. " +
      "Paths must be in the session or Pi's temporary directory.",
    parameters: Type.Object({
      reports: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_REPORTS, description: "JUnit XML paths, one per run, in run order" }),
      exitCodes: Type.Optional(Type.Array(Type.Union([Type.Integer(), Type.Null()]), { description: "Exit code of each run, same length as reports; null when unknown" })),
      noisyStderrLines: Type.Optional(Type.Integer({ minimum: 1, description: "Flag a run above this many stderr lines; default 1000" })),
      noisyFileBytes: Type.Optional(Type.Integer({ minimum: 1, description: "Flag a run whose report passes this many bytes; default 5000000" })),
      modes: Type.Optional(Type.Array(Type.String({ maxLength: MAX_MODE_LENGTH }), { description: "Order mode of each run, same length as reports: default, shuffle-files, shuffle-tests or free text" })),
    }, { required: ["reports"], additionalProperties: false }),
    async execute(_id, raw, _signal, _update, ctx) {
      return result(summarizeReports(ctx.cwd, raw, PI_REPORTS_TEMP_DIR))
    },
  })

  pi.registerTool({
    name: TEST_COMPARE_TOOL,
    label: "Compare test protection",
    description:
      "Read-only: compare a baseline and a candidate coverage or mutation report to show lost test protection.\n" +
      "Coverage: LCOV, Cobertura XML, Go cover profile. Mutation: Stryker/mutation-testing-report JSON, cargo-mutants " +
      "outcomes.json, Gremlins JSON. Both paths must be in the session or Pi's temporary directory.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("coverage"), Type.Literal("mutation")], { description: "Report kind" }),
      baseline: Type.String({ description: "Report before the change; relative to the session directory or absolute" }),
      candidate: Type.String({ description: "Report after the change; same rules" }),
      format: Type.Optional(Type.Union([
        Type.Literal("lcov"), Type.Literal("cobertura"), Type.Literal("gocover"),
        Type.Literal("mutation-testing"), Type.Literal("cargo-mutants"), Type.Literal("gremlins"),
      ], { description: "Report format; detected when omitted" })),
    }, { required: ["kind", "baseline", "candidate"], additionalProperties: false }),
    async execute(_id, raw, _signal, _update, ctx) {
      return result(compareReports(ctx.cwd, raw, PI_REPORTS_TEMP_DIR))
    },
  })
}
