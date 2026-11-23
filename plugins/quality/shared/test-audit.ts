import { opencodeTempDir, PathError, readReportFile, reportRoots } from "./audit-util.ts"
import { type CoverageFormat, compareCoverage, formatCoverage, parseCoverage } from "./coverage.ts"
import { parseJunitReport } from "./junit.ts"
import { compareMutation, formatMutation, type MutationFormat, parseMutation } from "./mutation.ts"
import { formatSummary, type RunRecord, summarizeRuns } from "./test-repeat.ts"
export const TEST_SUMMARIZE_TOOL = "quality_test_summarize"
export const TEST_COMPARE_TOOL = "quality_test_compare"
export const MAX_REPORTS = 50

export type TestAuditOptions = { enabled: true } | undefined

/** `testAudit: false` turns both tools off. */
export function parseTestAuditOptions(options: Readonly<Record<string, unknown>>): TestAuditOptions {
  return options.testAudit === false ? undefined : { enabled: true }
}

export type SummarizeInput = { reports: string[]; exitCodes?: Array<number | null>; modes?: string[]; noisyStderrLines?: number; noisyFileBytes?: number }

export const MAX_MODE_LENGTH = 60

/** Validate the tool input; a string result is the error to return. */
export function parseSummarizeInput(input: unknown): SummarizeInput | string {
  const raw = (input ?? {}) as Record<string, unknown>
  const { reports, exitCodes, modes, noisyStderrLines, noisyFileBytes } = raw
  if (!Array.isArray(reports) || reports.length < 1 || reports.length > MAX_REPORTS || reports.some((r) => typeof r !== "string" || r === ""))
    return `reports must be 1 to ${MAX_REPORTS} non-empty paths`
  if (exitCodes !== undefined) {
    if (!Array.isArray(exitCodes) || exitCodes.length !== reports.length || exitCodes.some((c) => c !== null && !Number.isInteger(c)))
      return "exitCodes must be integers or null, one per report"
  }
  if (modes !== undefined) {
    if (!Array.isArray(modes) || modes.length !== reports.length || modes.some((m) => typeof m !== "string" || m.trim() === "" || m.length > MAX_MODE_LENGTH))
      return `modes must be non-empty strings of at most ${MAX_MODE_LENGTH} characters, one per report`
  }
  for (const [name, value] of [["noisyStderrLines", noisyStderrLines], ["noisyFileBytes", noisyFileBytes]] as const)
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1)) return `${name} must be a positive integer`
  return {
    reports: reports as string[],
    exitCodes: exitCodes as Array<number | null> | undefined,
    modes: modes as string[] | undefined,
    noisyStderrLines: noisyStderrLines as number | undefined,
    noisyFileBytes: noisyFileBytes as number | undefined,
  }
}

/** Read and summarize one JUnit report per run, in run order. Pure apart from reading the files. */
export function summarizeReports(root: string, raw: unknown, temporaryDirectory = opencodeTempDir()): { content: string; metadata: Record<string, unknown> } {
  const fail = (message: string) => ({ content: `${TEST_SUMMARIZE_TOOL}: ${message}`, metadata: { error: message } })
  const input = parseSummarizeInput(raw)
  if (typeof input === "string") return fail(input)
  const roots = reportRoots(root, temporaryDirectory)
  const records: RunRecord[] = []
  for (const [i, path] of input.reports.entries()) {
    const record: RunRecord = { run: i + 1, exitCode: input.exitCodes?.[i], mode: input.modes?.[i], report: "unreadable", cases: [] }
    try {
      const text = readReportFile(root, path, roots)
      record.fileBytes = Buffer.byteLength(text)
      const parsed = parseJunitReport(text)
      record.cases = parsed.cases
      record.stderrLines = parsed.stderrLines
      record.report = "used"
    } catch (error) {
      if (error instanceof PathError) return fail(`refused: ${error.message}`)
      record.reason = error instanceof Error ? error.message : String(error)
    }
    records.push(record)
  }
  const summary = summarizeRuns(records, { noisyStderrLines: input.noisyStderrLines, noisyFileBytes: input.noisyFileBytes })
  return { content: formatSummary(summary), metadata: { ...summary } }
}

type CompareInput = { kind?: unknown; baseline?: unknown; candidate?: unknown; format?: unknown }
const COVERAGE_FORMATS = ["lcov", "cobertura", "gocover"]
const MUTATION_FORMATS = ["mutation-testing", "cargo-mutants", "gremlins"]

/** Compare two reports; returns the text and structured summary, or an error text. Pure apart from reading the two files. */
export function compareReports(root: string, input: CompareInput, temporaryDirectory = opencodeTempDir()): { content: string; metadata: Record<string, unknown> } {
  const fail = (message: string) => ({ content: `${TEST_COMPARE_TOOL}: ${message}`, metadata: { error: message } })
  if (input.kind !== "coverage" && input.kind !== "mutation") return fail("kind must be coverage or mutation")
  if (typeof input.baseline !== "string" || typeof input.candidate !== "string") return fail("baseline and candidate must be paths")
  const allowed = input.kind === "coverage" ? COVERAGE_FORMATS : MUTATION_FORMATS
  if (input.format !== undefined && !allowed.includes(input.format as string))
    return fail(`format for ${input.kind} must be one of ${allowed.join(", ")}`)
  try {
    const roots = reportRoots(root, temporaryDirectory)
    const baseText = readReportFile(root, input.baseline, roots)
    const candText = readReportFile(root, input.candidate, roots)
    if (input.kind === "coverage") {
      const format = input.format as CoverageFormat | undefined
      const result = compareCoverage(parseCoverage(baseText, format, root), parseCoverage(candText, format, root))
      return { content: formatCoverage(result), metadata: { ...result } }
    }
    const format = input.format as MutationFormat | undefined
    const result = compareMutation(parseMutation(baseText, format), parseMutation(candText, format))
    const cap = <T>(list: T[]) => list.slice(0, 200)
    return {
      content: formatMutation(result),
      metadata: {
        ...result,
        lostProtection: cap(result.lostProtection),
        newlyKilled: cap(result.newlyKilled),
        onlyInBaseline: cap(result.onlyInBaseline),
        onlyInCandidate: cap(result.onlyInCandidate),
        lostProtectionCount: result.lostProtection.length,
      },
    }
  } catch (error) {
    if (error instanceof PathError) return fail(`refused: ${error.message}`)
    return fail(error instanceof Error ? error.message : String(error))
  }
}
