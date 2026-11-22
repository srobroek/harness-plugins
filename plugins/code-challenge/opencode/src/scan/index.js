import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { sessionDirectory } from "../session-directory.ts";
import { consentRisks, runScan, validRunId } from "./run.ts";
import { DEPTHS, LANGUAGES, LENSES } from "./types.ts";
export { spawnTool } from "./exec.ts";
export { parseOutput } from "./parsers.ts";
export { RECIPES } from "./recipes.ts";
export { consentRisks, detectLanguages, expandFiles, resolveTool, runScan } from "./run.ts";
export * from "./types.ts";
export const SCAN_TOOL = "challenge_scan";
/** Longest candidate list returned inline; the full list is in the raw output directory when a runId is given. */
export const MAX_INLINE_CANDIDATES = 500;
export const SCAN_DESCRIPTION = "Run existing static analyzers in a lens profile and return normalised code-challenge candidates.\n" +
    "Not read-only: clippy builds the crate (build scripts, proc macros; writes target/), golangci-lint and deadcode " +
    "compile Go, knip and import-linter load repo config code, and one-off bunx/uvx/go runs download and run pinned " +
    "packages. Those recipes run only after the user approves them (staticOnly skips them without asking). " +
    "Hits carry lens, tool, rule, file, line, message, ruleEnabledInRepo. Quick depth skips build-backed analyzers. " +
    "With runId, raw output goes to <git-dir>/code-challenge/<runId>/scan/.";
export const SCAN_INPUT = {
    type: "object",
    properties: {
        root: { type: "string", description: "Target root; defaults to the session directory" },
        files: { type: "array", items: { type: "string" }, description: "Files, directories or globs to scope the scan" },
        languages: { type: "array", items: { enum: [...LANGUAGES] }, description: "Languages; auto-detected by default" },
        lenses: { type: "array", items: { enum: [...LENSES] }, description: "Lenses to keep; all by default" },
        depth: { enum: [...DEPTHS], description: "quick skips analyzers that need a build; default standard" },
        timeoutSeconds: { type: "number", maximum: 900, description: "Per-analyzer timeout in seconds; default 120, at most 900" },
        runId: { type: "string", description: "Run id; raw outputs go to <git-dir>/code-challenge/<runId>/scan/" },
        staticOnly: { type: "boolean", description: "Run only analyzers that execute no repo or downloaded code; ask nothing" },
    },
    additionalProperties: false,
};
/** The allowed values of a list input; an unknown one is a reason string, never dropped (that would widen the scan). */
function pick(name, value, allowed) {
    if (value === undefined)
        return undefined;
    const known = (v) => typeof v === "string" && allowed.includes(v);
    if (!Array.isArray(value) || !value.every(known))
        return `${name} must be a list of: ${allowed.join(", ")}`;
    return value;
}
/** Validate the tool input; a string is the reason it is unusable. */
export function readScanInput(raw, base) {
    const input = (typeof raw === "object" && raw !== null ? raw : {});
    const root = typeof input.root === "string" && input.root !== "" ? input.root : base;
    const timeout = input.timeoutSeconds;
    if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0)))
        return "timeoutSeconds must be a positive number";
    if (input.runId !== undefined && (typeof input.runId !== "string" || !validRunId(input.runId))) {
        return "runId must be 1-64 characters of letters, digits, underscore, dot or dash, starting with a letter, digit or underscore";
    }
    if (input.depth !== undefined && !DEPTHS.includes(input.depth))
        return `depth must be one of ${DEPTHS.join(", ")}`;
    const languages = pick("languages", input.languages, LANGUAGES);
    if (typeof languages === "string")
        return languages;
    const lenses = pick("lenses", input.lenses, LENSES);
    if (typeof lenses === "string")
        return lenses;
    const files = Array.isArray(input.files) ? input.files.filter((f) => typeof f === "string") : undefined;
    return {
        root: isAbsolute(root) ? root : resolve(base, root),
        files,
        languages,
        lenses,
        depth: input.depth,
        timeoutSeconds: timeout,
        runId: input.runId,
        staticOnly: input.staticOnly === true ? true : undefined,
    };
}
/** The tool result text: the report as JSON, with the candidate list capped. */
export function formatScan(report) {
    const truncated = report.candidates.length > MAX_INLINE_CANDIDATES;
    const shown = truncated ? report.candidates.slice(0, MAX_INLINE_CANDIDATES) : report.candidates;
    return JSON.stringify({ ...report, candidates: shown, candidateCount: report.candidates.length, truncated }, null, 1);
}
/** The resource a consent is bound to: the canonical root and the exact set of risky recipes. */
export function planResource(root, risks) {
    return `${root} [${risks.map((r) => r.recipe).sort().join(", ")}]`;
}
/**
 * Turn an allowed scan that would run repository or downloaded code into a prompt. The default
 * policy allows every action, so without this the consent would never be asked.
 */
export function confirmScan(evaluation) {
    if (evaluation.action !== SCAN_TOOL || evaluation.effect !== "allow")
        return;
    const recipes = (evaluation.metadata?.recipes ?? []);
    if (!Array.isArray(recipes) || recipes.length === 0)
        return;
    evaluation.effect = "ask";
    evaluation.message =
        `challenge_scan in ${String(evaluation.metadata?.root ?? evaluation.resources.join(", "))} will run code that is not static analysis. ` +
            "There is no sandbox: these recipes run with your user's permissions. Approving covers exactly these recipes; " +
            "pass staticOnly to scan without them.\n" +
            recipes.map((r) => `- ${r.recipe}: ${r.reasons.join("; ")}`).join("\n");
}
/** Register `challenge_scan`; the returned function disposes the registrations. */
export async function registerScanTool(ctx, deps = {}) {
    const registrations = [];
    const cleanup = async () => {
        for (const registration of registrations.reverse())
            await registration.dispose();
    };
    try {
        registrations.push(await ctx.tool.transform((editor) => {
            editor.add({
                name: SCAN_TOOL,
                description: SCAN_DESCRIPTION,
                input: SCAN_INPUT,
                execute: async (raw, context) => {
                    // The session's directory, not the plugin's: a default or relative root means the project being worked on.
                    const base = await sessionDirectory(ctx, context.sessionID, SCAN_TOOL);
                    const parsed = readScanInput(raw, base);
                    if (typeof parsed === "string")
                        return { content: `${SCAN_TOOL}: ${parsed}`, metadata: { ok: false } };
                    let input;
                    let risks;
                    try {
                        // Consent is per canonical root, so a symlink or a relative path cannot dodge or widen it.
                        input = { ...parsed, root: realpathSync(parsed.root ?? base) };
                        risks = parsed.staticOnly ? [] : await consentRisks(input, deps, context.signal);
                    }
                    catch (error) {
                        return { content: `${SCAN_TOOL}: ${error.message}`, metadata: { ok: false } };
                    }
                    // The approved set is exactly the recipes that were listed. Nothing is approved for a plan
                    // with no risk, so a recipe that turns risky before the run is a gap, not a free pass.
                    let approved = deps.approved ?? new Set();
                    if (risks.length > 0 && deps.approved === undefined) {
                        const root = input.root ?? base;
                        // A rejection (a deny rule, feedback, an interruption) propagates as the host defines it;
                        // a user who wants the scan without these recipes passes staticOnly instead.
                        await ctx.permission.assert({
                            sessionID: context.sessionID,
                            agent: context.agent,
                            source: { type: "tool", messageID: context.messageID, id: context.id },
                            action: SCAN_TOOL,
                            resources: [planResource(root, risks)],
                            save: [planResource(root, risks)],
                            metadata: { root, depth: input.depth ?? "standard", recipes: risks },
                        });
                        approved = new Set(risks.map((r) => r.recipe));
                    }
                    try {
                        const report = await runScan(input, { ...deps, approved }, context.signal);
                        return { content: formatScan(report), metadata: { ok: true, candidates: report.candidates.length, coverage: report.coverage } };
                    }
                    catch (error) {
                        return { content: `${SCAN_TOOL}: ${error.message}`, metadata: { ok: false } };
                    }
                },
            });
        }));
        registrations.push(await ctx.permission.hook("evaluate", confirmScan));
    }
    catch (error) {
        await cleanup();
        throw error;
    }
    return cleanup;
}
