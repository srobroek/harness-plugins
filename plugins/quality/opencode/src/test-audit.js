import { PathError, readReportFile, reportRoots } from "./audit-util.ts";
import { compareCoverage, formatCoverage, parseCoverage } from "./coverage.ts";
import { parseJunitReport } from "./junit.ts";
import { compareMutation, formatMutation, parseMutation } from "./mutation.ts";
import { formatSummary, summarizeRuns } from "./test-repeat.ts";
export const TEST_SUMMARIZE_TOOL = "quality_test_summarize";
export const TEST_COMPARE_TOOL = "quality_test_compare";
export const MAX_REPORTS = 50;
/** `testAudit: false` turns both tools off. */
export function parseTestAuditOptions(options) {
    return options.testAudit === false ? undefined : { enabled: true };
}
export const MAX_MODE_LENGTH = 60;
/** Validate the tool input; a string result is the error to return. */
export function parseSummarizeInput(input) {
    const raw = (input ?? {});
    const { reports, exitCodes, modes, noisyStderrLines, noisyFileBytes } = raw;
    if (!Array.isArray(reports) || reports.length < 1 || reports.length > MAX_REPORTS || reports.some((r) => typeof r !== "string" || r === ""))
        return `reports must be 1 to ${MAX_REPORTS} non-empty paths`;
    if (exitCodes !== undefined) {
        if (!Array.isArray(exitCodes) || exitCodes.length !== reports.length || exitCodes.some((c) => c !== null && !Number.isInteger(c)))
            return "exitCodes must be integers or null, one per report";
    }
    if (modes !== undefined) {
        if (!Array.isArray(modes) || modes.length !== reports.length || modes.some((m) => typeof m !== "string" || m.trim() === "" || m.length > MAX_MODE_LENGTH))
            return `modes must be non-empty strings of at most ${MAX_MODE_LENGTH} characters, one per report`;
    }
    for (const [name, value] of [["noisyStderrLines", noisyStderrLines], ["noisyFileBytes", noisyFileBytes]])
        if (value !== undefined && (!Number.isInteger(value) || value < 1))
            return `${name} must be a positive integer`;
    return {
        reports: reports,
        exitCodes: exitCodes,
        modes: modes,
        noisyStderrLines: noisyStderrLines,
        noisyFileBytes: noisyFileBytes,
    };
}
/** Read and summarize one JUnit report per run, in run order. Pure apart from reading the files. */
export function summarizeReports(root, raw) {
    const fail = (message) => ({ content: `${TEST_SUMMARIZE_TOOL}: ${message}`, metadata: { error: message } });
    const input = parseSummarizeInput(raw);
    if (typeof input === "string")
        return fail(input);
    const roots = reportRoots(root);
    const records = [];
    for (const [i, path] of input.reports.entries()) {
        const record = { run: i + 1, exitCode: input.exitCodes?.[i], mode: input.modes?.[i], report: "unreadable", cases: [] };
        try {
            const text = readReportFile(root, path, roots);
            record.fileBytes = Buffer.byteLength(text);
            const parsed = parseJunitReport(text);
            record.cases = parsed.cases;
            record.stderrLines = parsed.stderrLines;
            record.report = "used";
        }
        catch (error) {
            if (error instanceof PathError)
                return fail(`refused: ${error.message}`);
            record.reason = error instanceof Error ? error.message : String(error);
        }
        records.push(record);
    }
    const summary = summarizeRuns(records, { noisyStderrLines: input.noisyStderrLines, noisyFileBytes: input.noisyFileBytes });
    return { content: formatSummary(summary), metadata: { ...summary } };
}
const COVERAGE_FORMATS = ["lcov", "cobertura", "gocover"];
const MUTATION_FORMATS = ["mutation-testing", "cargo-mutants", "gremlins"];
/** Compare two reports; returns the text and structured summary, or an error text. Pure apart from reading the two files. */
export function compareReports(root, input) {
    const fail = (message) => ({ content: `${TEST_COMPARE_TOOL}: ${message}`, metadata: { error: message } });
    if (input.kind !== "coverage" && input.kind !== "mutation")
        return fail("kind must be coverage or mutation");
    if (typeof input.baseline !== "string" || typeof input.candidate !== "string")
        return fail("baseline and candidate must be paths");
    const allowed = input.kind === "coverage" ? COVERAGE_FORMATS : MUTATION_FORMATS;
    if (input.format !== undefined && !allowed.includes(input.format))
        return fail(`format for ${input.kind} must be one of ${allowed.join(", ")}`);
    try {
        const roots = reportRoots(root);
        const baseText = readReportFile(root, input.baseline, roots);
        const candText = readReportFile(root, input.candidate, roots);
        if (input.kind === "coverage") {
            const format = input.format;
            const result = compareCoverage(parseCoverage(baseText, format, root), parseCoverage(candText, format, root));
            return { content: formatCoverage(result), metadata: { ...result } };
        }
        const format = input.format;
        const result = compareMutation(parseMutation(baseText, format), parseMutation(candText, format));
        const cap = (list) => list.slice(0, 200);
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
        };
    }
    catch (error) {
        if (error instanceof PathError)
            return fail(`refused: ${error.message}`);
        return fail(error instanceof Error ? error.message : String(error));
    }
}
/** Register both read-only tools unless the options turn them off. Returns the disposer. */
export async function setupTestAudit(ctx, options) {
    if (options === undefined)
        return async () => { };
    const root = ctx.location.directory;
    const tools = await ctx.tool.transform((editor) => {
        editor.add({
            name: TEST_SUMMARIZE_TOOL,
            description: "Read-only: summarize JUnit XML reports from repeated test runs; flaky, always-failing and slow tests.\n" +
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
        });
        editor.add({
            name: TEST_COMPARE_TOOL,
            description: "Read-only: compare a baseline and a candidate coverage or mutation report to show lost test protection.\n" +
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
            execute: async (raw) => compareReports(root, raw),
        });
    });
    return async () => {
        await tools.dispose();
    };
}
