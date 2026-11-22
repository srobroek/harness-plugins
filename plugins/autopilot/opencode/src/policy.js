/** No-questions policy and write lanes while a run is armed. Pure. */
import { commitChecks, own, requiredContexts, reviewApproval, str, usesMergeQueue } from "@srobroek/opencode-lib/pr-approval";
/** Tools that ask the user something and wait. */
export const ASK_TOOLS = new Set(["question", "parley_ask", "parley_wait", "parley_end", "ask_user", "ask_followup_question"]);
/** Whether `tool` (direct or a Code Mode path such as `parley.ask`) asks the user. */
export function isAskTool(tool) {
    const name = tool.replace(/^tools\./, "").replace(/[.-]/g, "_").toLowerCase();
    return ASK_TOOLS.has(name);
}
export const DENY_QUESTION = "autopilot is armed: never ask the user. Decide reversible items, log them with autopilot_log (type decision), park irreversible ones as a blocker, and continue.";
const ASKING = [/\?\s*$/, /\b(should I|shall I|do you want|would you like|let me know|which (one|option) do you)\b/i];
/** Whether the final text of a turn hands a question to the user. */
export function endsWithQuestion(text) {
    const paragraphs = text.trim().split(/\n\s*\n/);
    const last = paragraphs.at(-1)?.trim() ?? "";
    if (last === "")
        return false;
    return ASKING.some((pattern) => pattern.test(last));
}
export const REPROMPT = "autopilot is armed and the user is away: do not ask. Pick the most likely answer for anything reversible and log it with autopilot_log (type decision); log irreversible or outward-facing items as a blocker with parked: true. Then continue with the next item.";
/** Agents that never write to a checkout, so they run without a write lane. */
export const READ_ONLY_AGENTS = new Set([
    "explore",
    "researcher",
    "code-reviewer",
    "pr-reviewer",
    "security-reviewer",
    "adversarial-challenger",
    "seance",
    "debug",
    "operator",
    "plan",
]);
/** Whether a subagent of `agent` takes one of the run's write lanes. An unknown agent does. */
export function holdsLane(agent) {
    return agent === undefined || !READ_ONLY_AGENTS.has(agent);
}
export const EXTERNAL_DIRECTORY = "external_directory";
export const MERGE_ACTION = "autopilot_merge";
/**
 * Whether an `external_directory` ask is for exactly `<root>/*` of one of the run's confirmed
 * worktree `roots`. Both sides are compared by real path, so an alias of a root matches and a
 * sibling that shares the prefix, a path under the root, or a symlink leading outside does not.
 * Only an `ask` is ever turned into an allow.
 */
export function ownWorktreeAsk(input) {
    if (input.effect !== "ask" || input.action !== EXTERNAL_DIRECTORY)
        return false;
    if (input.resources.length === 0 || input.roots.length === 0)
        return false;
    const real = new Set(input.roots.flatMap((root) => input.canon(root) ?? []));
    return input.resources.every((resource) => {
        if (!resource.endsWith("/*"))
            return false;
        const root = resource.slice(0, -2);
        if (!root.startsWith("/") || /[*?]/.test(root))
            return false;
        const resolved = input.canon(root);
        return resolved !== undefined && real.has(resolved);
    });
}
/**
 * Whether an `external_directory` ask is for `<dir>/*` where `dir` is `root`, the real path of the
 * one export directory the run made last (already checked to be a plain directory), or a directory
 * under it. A host may ask for the directory that holds a file, so a reader of an exported file may
 * ask for a subdirectory; the host's types give the resource only as an opaque string, so both
 * forms are accepted and both stay inside that one directory. Real paths are compared, so a symlink
 * inside the export that leads outside, a `..` climb and a sibling sharing the prefix all fail. Only
 * an `ask` is ever turned into an allow.
 *
 * This is a directory grant, not a read grant: the ask carries no read/write distinction (see
 * `PermissionEvaluation`: action, resources, metadata, the originating tool call id), and when the
 * user's rules allow `edit` for paths, `external_directory` is the only prompt between a model and a
 * write there. The directory is therefore model-writable, and the integrity of what a reviewer reads
 * comes from the export's manifest (`verifyExport`), never from this permission.
 */
export function reviewExportAsk(input) {
    const { root } = input;
    if (input.effect !== "ask" || input.action !== EXTERNAL_DIRECTORY || root === undefined || input.resources.length === 0)
        return false;
    return input.resources.every((resource) => {
        if (!resource.endsWith("/*"))
            return false;
        const dir = resource.slice(0, -2);
        if (!dir.startsWith("/") || /[*?]/.test(dir))
            return false;
        const resolved = input.canon(dir);
        return resolved !== undefined && (resolved === root || resolved.startsWith(`${root}/`));
    });
}
const FULL_SHA = /^[0-9a-f]{40}$/;
/** The permission resource of one merge: `<pr>@<sha>`. */
export function mergeResource(pr, sha) {
    return `${pr}@${sha}`;
}
/** Whether an `autopilot_merge` ask for one `<pr>@<sha>` is covered by the `merge` grant. */
export function grantedMergeAsk(input) {
    if (input.effect !== "ask" || input.action !== MERGE_ACTION || !input.allow.includes("merge"))
        return false;
    const [resource, ...rest] = input.resources;
    return rest.length === 0 && resource !== undefined && /^\d+@[0-9a-f]{40}$/.test(resource);
}
const text = (holder, key) => str(holder, key) ?? undefined;
export const MERGE_METHODS = ["squash", "rebase", "merge"];
/** Why `method` may not be used on the repository, from `gh repo view --json squashMergeAllowed,rebaseMergeAllowed,mergeCommitAllowed`. */
function methodRefusal(repo, method) {
    if (!MERGE_METHODS.includes(method))
        return `method must be one of ${MERGE_METHODS.join(", ")}`;
    const flag = { squash: "squashMergeAllowed", rebase: "rebaseMergeAllowed", merge: "mergeCommitAllowed" }[method];
    return own(repo, flag) === true ? undefined : `method ${method} is not allowed by the repository (or its settings were unreadable)`;
}
/** Whether a witnessed review stands in for the forge approval of `sha`: the grant is set and the record approves exactly that head. */
export function witnessedApproval(witnessed, sha) {
    return witnessed !== undefined && witnessed.granted && witnessed.approvedSha !== undefined && witnessed.approvedSha.toLowerCase() === sha.toLowerCase();
}
/**
 * Why a PR may not be merged at `sha` with `method`, or `undefined` when it may. `view` is `gh pr
 * view --json state,headRefOid,baseRefName,author`; `reviews`, `runs` and `status` are the REST
 * payloads for the PR's reviews and the commit's check runs and status; `protection` and `rules` are
 * the base branch's required-status-checks protection and rulesets, `undefined` when unreadable (which refuses). Approval is a review by someone other than the
 * author, on exactly `sha`; comments never count. A `witnessed` review under the `self-review` grant
 * replaces that approval and nothing else. Anything unreadable refuses.
 */
export function mergeRefusal(input) {
    const sha = input.sha.toLowerCase();
    if (!FULL_SHA.test(sha))
        return "sha must be the full 40-digit head commit";
    const head = text(input.view, "headRefOid")?.toLowerCase();
    if (head !== sha)
        return `PR head is ${head ?? "unreadable"}, not the reviewed ${sha}; review the new head first`;
    const state = text(input.view, "state");
    if (state !== "OPEN")
        return `PR state is ${state ?? "unreadable"}, expected OPEN`;
    const method = methodRefusal(input.repo, input.method);
    if (method !== undefined)
        return method;
    // The only requirement a witnessed review replaces is the forge's approval; everything else still applies.
    if (!witnessedApproval(input.witnessed, sha)) {
        const approval = reviewApproval(input.reviews, text(own(input.view, "author"), "login") ?? null, sha);
        if (!approval.ok)
            return approval.reason;
    }
    if (usesMergeQueue(input.rules))
        return "the base branch uses a merge queue; merge queues unsupported";
    const required = requiredContexts(input.protection, input.rules, { requireBoth: true });
    const checks = commitChecks({ runs: input.runs, status: input.status, required, requireKnown: true });
    return checks.ok ? undefined : checks.reason;
}
/** The identity of `path` when it is a plain directory (not a symlink), else `undefined`. */
export function identifyRoot(path, lstat, canon) {
    const stat = lstat(path);
    const resolved = canon(path);
    if (stat === undefined || resolved === undefined || !stat.isDirectory || stat.isSymbolicLink)
        return undefined;
    return { path, real: resolved, dev: stat.dev, ino: stat.ino };
}
/** Whether `root` is still the directory that was recorded: same inode, same device, same real path, still not a symlink. */
export function rootIntact(root, lstat, canon) {
    const now = identifyRoot(root.path, lstat, canon);
    return now !== undefined && now.real === root.real && now.dev === root.dev && now.ino === root.ino;
}
/**
 * Whether a child session's directory is a worktree the run may record: the child can write
 * (not a read-only agent), the project lists the directory, it is not the primary checkout, and it
 * carries the linked-worktree marker.
 */
export function recordableLane(input) {
    if (!holdsLane(input.agent))
        return false;
    const resolved = input.canon(input.directory);
    return resolved !== undefined && input.listed.has(resolved) && !input.primary.has(resolved) && input.linked(input.directory);
}
/**
 * Whether the PR really merged at `sha`. `view` is `gh pr view --json
 * state,headRefOid,mergeCommit,autoMergeRequest` read after the merge call. Success needs MERGED, the
 * reviewed head, a merge commit and no auto-merge request.
 */
export function mergeOutcome(view, sha) {
    const state = text(view, "state");
    const head = text(view, "headRefOid")?.toLowerCase();
    if (view === undefined)
        return { ok: false, reason: "could not read the PR after merging, so the merge is unconfirmed" };
    if (state !== "MERGED")
        return { ok: false, reason: `PR is ${state ?? "unreadable"} after the merge call, not MERGED` };
    if (head !== sha)
        return { ok: false, reason: `PR merged at ${head ?? "an unreadable head"}, not the reviewed ${sha}` };
    if (own(view, "mergeCommit") == null)
        return { ok: false, reason: "PR is MERGED but has no merge commit" };
    if (own(view, "autoMergeRequest") != null)
        return { ok: false, reason: "PR is MERGED but an auto-merge request is still recorded" };
    return { ok: true };
}
/** Why the PR no longer matches what was checked, from a re-read of `baseRefName,headRefOid` just before the merge; `undefined` when it still does. */
export function mergeDrift(input) {
    const base = text(input.view, "baseRefName");
    const head = text(input.view, "headRefOid")?.toLowerCase();
    if (base === undefined || head === undefined)
        return "PR base or head unreadable just before merging";
    if (base !== input.base)
        return `PR base changed from ${input.base} to ${base} after its protection was read`;
    if (head !== input.sha)
        return `PR head is ${head}, not the reviewed ${input.sha}`;
    return undefined;
}
/** The result of `gh api -X PUT repos/{o}/{r}/pulls/{n}/merge`: success needs `merged: true` and a `sha`; any non-2xx is a refusal with its status and message. */
export function mergeResponse(result) {
    let body;
    try {
        body = JSON.parse(result.stdout);
    }
    catch {
        body = undefined;
    }
    if (!result.ok) {
        const status = /HTTP (\d{3})/.exec(result.stderr)?.[1];
        const message = text(body, "message") ?? result.stderr.trim().slice(0, 300);
        return { ok: false, reason: status === undefined ? `merge failed: ${message}` : `merge refused by GitHub (HTTP ${status}): ${message}` };
    }
    if (body === undefined)
        return { ok: false, reason: "merge response unreadable" };
    if (own(body, "merged") !== true)
        return { ok: false, reason: `merge response did not say merged: ${text(body, "message") ?? "no message"}` };
    const sha = text(body, "sha");
    return sha === undefined ? { ok: false, reason: "merge response carried no sha" } : { ok: true, sha };
}
