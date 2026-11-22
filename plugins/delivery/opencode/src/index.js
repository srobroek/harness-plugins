import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { keepFallback, ownedElsewhere } from "@srobroek/opencode-lib/agent-fallback";
import { grantTools, mcpGrant } from "@srobroek/opencode-lib/agent-tools";
import { appendResultText, shellOutput } from "@srobroek/opencode-lib/shell-result";
import { registerSkills } from "@srobroek/opencode-lib/skill-files";
import { AGENT_IDS, FALLBACK_AGENTS, fallbackModel, hasModelRoles, loadAgents, shapeAgent, } from "./agents.ts";
import { inlineCleanupDecision, nextAfterCleanup, runInlineCleanup, textAfterCleanup, } from "./auto-cleanup.ts";
import { cleanupDelivery, foreignCleanupReason, } from "./cleanup.ts";
import { MERGE_METHODS } from "./forge-adapter.ts";
import { landPullRequest } from "./land.ts";
import { CleanupDeferred, createPendingCleanup } from "./pending-cleanup.ts";
import { malformedNote, parseVerdict } from "./verdict.ts";
export { AGENT_IDS, availableModel, FALLBACK_AGENTS, fallbackModel, hasModelRoles, parseAgentFile, parseModel, shapeAgent, } from "./agents.ts";
export { cleanupDelivery } from "./cleanup.ts";
export { landPullRequest } from "./land.ts";
export { AGENT_VERDICTS, parseVerdict } from "./verdict.ts";
export const LAND_ACTION = "delivery_land";
export const CLEANUP_ACTION = "delivery_cleanup";
export const SKILL_PATH = fileURLToPath(new URL("../skills/delivery-git-workflow/SKILL.md", import.meta.url));
export const FAN_OUT_SKILL_PATH = fileURLToPath(new URL("../skills/delivery-fan-out/SKILL.md", import.meta.url));
export const FAN_OUT_PATH = fileURLToPath(new URL("../instructions/delivery-fan-out.md", import.meta.url));
/** `plugin.list` during setup must not hold up startup; a slow answer counts as "not installed". */
const PLUGIN_LIST_TIMEOUT_MS = 2000;
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
export function parseOptions(raw) {
    const options = raw ?? {};
    const models = {};
    if (typeof options.models === "object" && options.models !== null) {
        for (const [id, value] of Object.entries(options.models)) {
            if (typeof value === "string" || value === false)
                models[id] = value;
        }
    }
    return {
        confirm: options.confirm === true,
        receiptsDirectory: typeof options.receiptsDirectory === "string" ? options.receiptsDirectory : undefined,
        agents: options.agents !== false,
        models,
        fanOut: options.fanOut !== false,
        verdicts: options.verdicts !== false,
        autoCleanup: options.autoCleanup !== false,
    };
}
/**
 * Turn an allowed land or cleanup into a prompt; a configured deny never reaches the hook.
 * A subagent cannot answer a prompt (the safety plugin would deny it), so it keeps its allow.
 */
export function confirmDelivery(evaluation, subagent = false) {
    if (evaluation.effect !== "allow" || subagent)
        return;
    if (evaluation.action === LAND_ACTION) {
        evaluation.effect = "ask";
        evaluation.message = `Land ${evaluation.resources.join(", ")}? delivery_land merges at most once and writes a landing receipt.`;
    }
    else if (evaluation.action === CLEANUP_ACTION) {
        evaluation.effect = "ask";
        evaluation.message = `Remove worktree ${evaluation.resources.join(", ")} and delete its local branch?`;
    }
}
const LAND_INPUT = {
    type: "object",
    properties: {
        pr: { type: ["integer", "string"], description: "PR or MR number" },
        merge_method: { type: "string", enum: [...MERGE_METHODS], description: "default squash" },
        repo: { type: "string", description: '"<owner>/<name>"; defaults to the remote URL path' },
        remote: { type: "string", description: 'Forge remote; default "origin"' },
        expectHeadSha: {
            type: "string",
            description: "The reviewed head; required to merge, optional when proving an already MERGED PR",
        },
        requireApproval: {
            type: "boolean",
            description: "Require an APPROVED review or a 'VERDICT: APPROVE' author comment for the exact head",
        },
        requireGreenChecks: { type: "boolean", description: "Require every check on the head to pass" },
        queueWaitSeconds: { type: "integer", description: "Merge queue: seconds to wait for the merge, 0-3600; default 600" },
        setupAutoDelete: { type: "boolean", description: "Enable deletion-on-merge after the landing is proved" },
        worktree: { type: "string", description: "Landed worktree for cleanup (HEAD = PR head); inferred if omitted" },
        repoPath: { type: "string", description: "Checkout of repo on this machine; needed when repo is not the session's" },
        beadId: {
            type: "string",
            description: "Bead this closes when the branch is not <omp|opencode>/agent/<bead-id>; required then on a ledger",
        },
    },
    required: ["pr"],
    additionalProperties: false,
};
const LAND_OUTPUT = {
    type: "object",
    properties: {
        ok: { type: "boolean" },
        receiptPath: { type: "string" },
        mergeSha: { type: "string" },
        pr: { type: "integer" },
        repo: { type: "string" },
        next: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        mergeIssued: { type: "boolean" },
        queued: { type: "boolean" },
        receipt: { type: "object" },
        cleanup: {
            type: "object",
            properties: {
                ok: { type: "boolean" },
                reason: { type: "string" },
                removed: { type: "string" },
                localRefDeleted: { type: "boolean" },
                skipped: { type: "boolean" },
                deferred: { type: "string" },
                denied: { type: "boolean" },
            },
            required: ["ok"],
        },
    },
    required: ["ok"],
};
const CLEANUP_INPUT = {
    type: "object",
    properties: {
        receipt: {
            type: "string",
            minLength: 1,
            description: "Path to a canonical landing receipt; omit to select the newest for this repository",
        },
        pr: { type: "integer", minimum: 1, description: "PR number, which must equal the selected receipt" },
        branch: { type: "string", minLength: 1, description: "Branch, which must equal the selected receipt" },
        worktree: { type: "string", minLength: 1, description: "Worktree path, which must equal the selected receipt" },
        remote: { type: "string", minLength: 1, description: "Remote name, which must equal the selected receipt" },
        repo: { type: "string", minLength: 1, description: '"<owner>/<name>", which must equal the selected receipt\'s repo; another repository is refused: clean up from a session there' },
        repoPath: { type: "string", minLength: 1, description: "Checkout of repo on this machine; only identifies it" },
    },
    additionalProperties: false,
};
const CLEANUP_OUTPUT = {
    type: "object",
    properties: {
        ok: { type: "boolean" },
        receiptPath: { type: "string" },
        branch: { type: "string" },
        worktree: { type: "string" },
        remoteBranchAbsence: { type: "string", enum: ["absent", "present", "unknown"] },
        alreadyCleaned: { type: "boolean" },
        removed: { type: "array", items: { type: "string" } },
        skipped: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        deferred: { type: "string" },
        receipt: { type: "object" },
    },
    required: ["ok"],
};
/** What `delivery_cleanup` returns when the worktree belongs to a lane: nothing removed, the owner does it. */
function deferredOutput(deferred) {
    return { ok: true, deferred };
}
const LAND_DESCRIPTION = "Merge a reviewed pull request at most once, prove it landed, and write one landing receipt.\n" +
    "Refuses unless expectHeadSha names the PR head (required whenever the call would merge) " +
    "and, when worktree is given, it is a worktree of the repository landed whose HEAD is that head. A repo other than the session's needs worktree or repoPath, a local clone whose remote names it. With requireApproval/requireGreenChecks it also requires an approval artifact on the PR for that exact head " +
    "and green checks before merging. Merges at most once (an already MERGED request is proved, not re-merged) with merge_method (squash by default, PR title as subject), " +
    "binds the merge to the head, re-reads it, fetches the landed commits and checks the method's commit shape, observes the remote branch, then writes the receipt. " +
    "Writes no Beads ledger: when beads.ledgerActive, run the returned next steps child-before-parent, then delivery_cleanup. A landing of another repository runs no cleanup; its next names the session to clean up from. " +
    "A base branch with a GitHub merge queue is landed by enqueuing the head (never --auto): queued true means still queued, call again. " +
    "A refusal with mergeIssued true means the PR is merged: re-run with the same pr and expectHeadSha to write the receipt.";
const CLEANUP_DESCRIPTION = "Remove a landed PR's worktree and local branch after proving the landing receipt, and write a continuation receipt.\n" +
    "Recomputes the ledger classification at the canonical root, proves the PR merged at the recorded head from the receipt's own remote, " +
    "checks every receipt bead is closed with metadata.merge_sha equal to the merge (read-only bd show at the repository root, session bead pins removed), refuses to remove the worktree it runs from, a dirty tree or unpushed commits, a receipt or worktree of another repository, and a repo other than the session's (run it from a session there), " +
    "then removes the worktree (no force; through OpenCode when it tracks it, else git worktree remove) and runs git branch -d and verifies four absences.";
export function landOutput(outcome, cleanup) {
    if (!outcome.ok) {
        return {
            ok: false,
            reason: outcome.reason,
            ...(outcome.mergeIssued === true ? { mergeIssued: true } : {}),
            ...(outcome.queued === true ? { queued: true } : {}),
        };
    }
    return {
        ok: true,
        receiptPath: outcome.receiptPath,
        mergeSha: outcome.receipt.pr.mergeCommitOid ?? "",
        pr: outcome.receipt.pr.number,
        repo: outcome.receipt.repo.nameWithOwner,
        next: nextAfterCleanup(outcome.next, cleanup),
        ...(cleanup === undefined ? {} : { cleanup }),
        receipt: outcome.receipt,
    };
}
function cleanupOutput(result) {
    if (!result.ok)
        return { ok: false, reason: result.reason };
    return {
        ok: true,
        receiptPath: result.path,
        branch: result.receipt.branch.name,
        worktree: result.receipt.worktree.path ?? "",
        remoteBranchAbsence: result.remoteBranchAbsence,
        alreadyCleaned: result.alreadyCleaned,
        removed: result.report.removed,
        skipped: result.report.skipped,
        receipt: result.receipt,
    };
}
/** The persisted metadata: the output without the full receipt, which lives on disk. */
function metadataOf(output) {
    const { receipt: _receipt, ...rest } = output;
    return rest;
}
/**
 * OpenCode's worktree registry for this project. Undefined when the host reports no
 * project or an older host has no `worktree` list/remove, so cleanup keeps the git path.
 */
export function hostWorktrees(ctx) {
    const projectID = ctx.location.project?.id;
    const worktree = ctx.worktree;
    if (projectID === undefined)
        return undefined;
    if (typeof worktree?.list !== "function" || typeof worktree.remove !== "function")
        return undefined;
    const { list, remove } = worktree;
    return {
        list: () => list.call(worktree, { projectID }),
        remove: (directory) => remove.call(worktree, { projectID, directory, force: false }),
    };
}
function environment(options) {
    return options.receiptsDirectory === undefined
        ? process.env
        : { ...process.env, DELIVERY_RECEIPTS_DIR: options.receiptsDirectory };
}
function asserter(ctx, context, action) {
    return async (resource, metadata) => {
        await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action,
            resources: [resource],
            save: [resource],
            metadata,
        });
    };
}
async function isPrimary(ctx, sessionID) {
    try {
        const session = (await ctx.session.get({ sessionID }));
        return session?.parentID === undefined || session.parentID === null;
    }
    catch {
        return false;
    }
}
export async function setupDelivery(ctx, overrides = {}) {
    const options = parseOptions(ctx.options);
    const directory = ctx.location.directory;
    const disposers = [];
    // Always set up: denials and landing records coordinate with the lane owner whatever autoCleanup says.
    // autoCleanup only turns delivery's own inline cleanup and retry on or off.
    const pending = createPendingCleanup({
        ctx,
        cwd: directory,
        env: environment(options),
        host: () => hostWorktrees(ctx),
        ...overrides,
    });
    const tools = await ctx.tool.transform((editor) => {
        editor.add({
            name: LAND_ACTION,
            description: LAND_DESCRIPTION,
            input: LAND_INPUT,
            output: LAND_OUTPUT,
            execute: async (input, context) => {
                const ask = asserter(ctx, context, LAND_ACTION);
                const outcome = await landPullRequest(input, {
                    cwd: directory,
                    env: environment(options),
                    signal: context.signal,
                    authorize: (request) => ask(request.resource, { ...request }),
                });
                if (!outcome.ok) {
                    const output = landOutput(outcome);
                    return { output, content: outcome.text, metadata: metadataOf(output) };
                }
                const receiptPath = outcome.receipt.worktree.path;
                // Another repository's claims, holds and ledger are not visible here, so its
                // landing is neither cleaned up inline nor left pending for this session's retry.
                if (outcome.foreign === true) {
                    const cleanup = {
                        ok: false,
                        skipped: true,
                        reason: foreignCleanupReason(outcome.receipt.repo.nameWithOwner, outcome.receipt.repo.canonicalRoot),
                    };
                    const output = landOutput(outcome, cleanup);
                    return { output, content: textAfterCleanup(outcome.text, cleanup), metadata: metadataOf(output) };
                }
                const decision = inlineCleanupDecision(outcome.receipt, options.autoCleanup, receiptPath === null || pending === undefined ? { owner: "none" } : pending.ownership(receiptPath));
                // A refused prompt is a denial: recorded, and never retried without a new explicit call.
                let denied = false;
                // A skipped run is reported only when the option is on; off keeps the old result.
                const cleanup = decision.run
                    ? await runInlineCleanup(() => {
                        const askCleanup = asserter(ctx, context, CLEANUP_ACTION);
                        return cleanupDelivery({ receipt: outcome.receiptPath }, directory, {
                            env: environment(options),
                            signal: context.signal,
                            authorize: async (request) => {
                                try {
                                    await askCleanup(request.worktree, { ...request });
                                }
                                catch (error) {
                                    denied = true;
                                    throw error;
                                }
                            },
                            ...pending.removalFor(context.sessionID),
                            host: hostWorktrees(ctx),
                        });
                    })
                    : options.autoCleanup
                        ? decision.deferred === undefined
                            ? { ok: false, skipped: true, reason: decision.reason }
                            : { ok: false, deferred: decision.deferred }
                        : undefined;
                if (denied && cleanup !== undefined)
                    cleanup.denied = true;
                // Cleanup that did not finish stays pending: delivery retries it when a turn ends.
                if (cleanup?.ok !== true) {
                    await pending.record(outcome.receipt, context.sessionID, { denied }).catch(() => { });
                }
                const output = landOutput(outcome, cleanup);
                const content = cleanup === undefined ? outcome.text : textAfterCleanup(outcome.text, cleanup);
                return { output, content, metadata: metadataOf(output) };
            },
        });
        editor.add({
            name: CLEANUP_ACTION,
            description: CLEANUP_DESCRIPTION,
            input: CLEANUP_INPUT,
            output: CLEANUP_OUTPUT,
            execute: async (input, context) => {
                const ask = asserter(ctx, context, CLEANUP_ACTION);
                let result;
                try {
                    result = await cleanupDelivery(input, directory, {
                        env: environment(options),
                        signal: context.signal,
                        ...pending.explicit((req) => ask(req.worktree, { ...req }), context.sessionID),
                        host: hostWorktrees(ctx),
                    });
                }
                catch (error) {
                    if (!(error instanceof CleanupDeferred))
                        throw error;
                    const output = deferredOutput(error.deferred);
                    return { output, content: `delivery_cleanup deferred: ${error.deferred}`, metadata: metadataOf(output) };
                }
                await pending.gc();
                const output = cleanupOutput(result);
                const text = !result.ok
                    ? `delivery_cleanup refused: ${result.reason}`
                    : result.alreadyCleaned
                        ? `delivery_cleanup: nothing to remove. ${result.report.skipped.join("; ")}.\nreceipt: ${result.path}`
                        : `delivery_cleanup removed ${result.report.removed.join(", ")}${result.report.skipped.length > 0 ? `; skipped: ${result.report.skipped.join("; ")}` : ""}; remote branch ${result.remoteBranchAbsence}.\nreceipt: ${result.path}`;
                return { output, content: text, metadata: metadataOf(output) };
            },
        });
    });
    disposers.push(() => tools.dispose());
    // Delivery's own retry runs only with autoCleanup; the coordination above does not depend on it.
    if (options.autoCleanup)
        await pending.start();
    disposers.push(() => pending.dispose());
    if (options.confirm) {
        const gate = await ctx.permission.hook("evaluate", async (evaluation) => {
            if (evaluation.effect !== "allow" || (evaluation.action !== LAND_ACTION && evaluation.action !== CLEANUP_ACTION))
                return;
            // A failed lookup keeps the prompt (fail closed).
            const info = (await ctx.session.get({ sessionID: evaluation.sessionID }).catch(() => undefined));
            confirmDelivery(evaluation, typeof info?.parentID === "string" && info.parentID !== "");
        });
        disposers.push(() => gate.dispose());
    }
    if (options.agents) {
        const files = loadAgents();
        let available = [];
        try {
            available = (await ctx.model.list()).data ?? [];
        }
        catch {
            available = [];
        }
        let modelRoles = false;
        let owned = new Set();
        try {
            const listed = await withTimeout(ctx.plugin.list(), PLUGIN_LIST_TIMEOUT_MS);
            modelRoles = hasModelRoles(listed);
            owned = ownedElsewhere(listed, FALLBACK_AGENTS);
        }
        catch {
            modelRoles = false;
        }
        const grant = mcpGrant(ctx.options?.tools, files.map((file) => file.id));
        const agents = await ctx.agent.transform((editor) => {
            for (const file of files) {
                const created = editor.get(file.id) === undefined;
                if (!keepFallback(file.id, FALLBACK_AGENTS, owned, !created))
                    continue;
                const model = fallbackModel(file, options.models[file.id], modelRoles, available);
                editor.update(file.id, (draft) => shapeAgent(draft, grantTools(file, grant), model, created));
            }
        });
        disposers.push(() => agents.dispose());
    }
    if (options.verdicts) {
        const after = await ctx.tool.hook("execute.after", (event) => {
            if (event.tool !== "subagent" || event.status !== "completed")
                return;
            const input = (event.input ?? {});
            const agent = typeof input.agent === "string" ? input.agent : undefined;
            const output = event.result.output;
            if (output?.status === "running")
                return;
            const text = shellOutput(event.result);
            if (text === undefined)
                return;
            const verdict = parseVerdict(text, agent !== undefined && AGENT_IDS.includes(agent) ? agent : undefined);
            if (verdict === undefined)
                return;
            const result = { ...event.result, metadata: { ...event.result.metadata, delivery: verdict } };
            event.result = "reason" in verdict ? appendResultText(result, malformedNote(verdict, output?.sessionID)) : result;
        });
        disposers.push(() => after.dispose());
    }
    if (options.fanOut) {
        const fanOut = readFileSync(FAN_OUT_PATH, "utf8").trim();
        const primary = new Map();
        // Also on compaction and generate, so those requests keep the turns' system prompt and prompt cache.
        const addFanOut = async (event) => {
            if (AGENT_IDS.includes(event.agent))
                return;
            if (!("subagent" in event.tools))
                return;
            let known = primary.get(event.sessionID);
            if (known === undefined) {
                known = isPrimary(ctx, event.sessionID);
                primary.set(event.sessionID, known);
            }
            if (await known)
                event.system.push({ type: "text", text: fanOut });
        };
        const hooks = [
            await ctx.session.hook("context", addFanOut),
            await ctx.session.hook("compaction", addFanOut),
            await ctx.session.hook("generate", addFanOut),
        ];
        disposers.push(async () => {
            for (const hook of hooks)
                await hook.dispose();
            primary.clear();
        });
    }
    const skills = await registerSkills(ctx.skill, [SKILL_PATH, FAN_OUT_SKILL_PATH]);
    disposers.push(() => skills.dispose());
    return async () => {
        for (const dispose of disposers.reverse())
            await dispose();
    };
}
export default Plugin.define({
    id: "srobroek.delivery",
    setup: (ctx) => setupDelivery(ctx),
});
