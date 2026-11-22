/**
 * Pure judgments about a GitHub PR's approval and checks, shared by `delivery_land` and
 * `autopilot_merge`. Each takes a payload a caller read from the forge and never reads anything
 * itself. An unreadable payload refuses: an unknown approval is not an approval.
 */
/** The own, enumerable data property `key` of a plain object, else `undefined`. */
export function own(holder, key) {
    if (typeof holder !== "object" || holder === null || Array.isArray(holder))
        return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
    return descriptor.value;
}
export function str(holder, key) {
    const value = own(holder, key);
    return typeof value === "string" ? value : null;
}
/** The login of a `gh pr view` author or review author. */
export function login(holder) {
    return str(own(holder, "author"), "login") ?? str(own(holder, "author"), "username");
}
/**
 * Approval for exactly `head` from a `gh pr view --json author,reviews,comments` payload: an
 * `APPROVED` review whose `commit.oid` is the head. With `commentVerdict`, also a comment by the PR
 * author whose first line is `VERDICT: APPROVE` and whose body names the head (for a reviewer that
 * shares the author's account, which GitHub refuses to let approve).
 */
export function githubApproval(payload, head, options) {
    const author = login(payload);
    const reviews = own(payload, "reviews");
    const comments = own(payload, "comments");
    if (!Array.isArray(reviews) || !Array.isArray(comments)) {
        return {
            ok: false,
            reason: "approval: observed no reviews/comments arrays, expected the gh pr view --json reviews,comments payload",
        };
    }
    for (const review of reviews) {
        if (str(review, "state") !== "APPROVED")
            continue;
        const oid = str(own(review, "commit"), "oid")?.trim().toLowerCase();
        if (oid === head)
            return { ok: true, evidence: { kind: "review", reviewer: login(review), commit: oid } };
    }
    if (options.commentVerdict && author !== null) {
        for (const comment of comments) {
            if (login(comment) !== author)
                continue;
            const body = str(comment, "body") ?? "";
            const first = body.split(/\r?\n/, 1)[0]?.trim() ?? "";
            if (/^VERDICT:\s*APPROVE\b/.test(first) && body.toLowerCase().includes(head)) {
                return { ok: true, evidence: { kind: "verdict-comment", reviewer: author, commit: head } };
            }
        }
    }
    const stale = reviews.filter((review) => str(review, "state") === "APPROVED").length;
    return {
        ok: false,
        reason: `approval: observed ${stale} APPROVED review(s), none for head ${head}${options.commentVerdict ? ', and no author "VERDICT: APPROVE" comment naming it' : ""}; expected an approval artifact on the PR for the exact head`,
    };
}
/** GitHub checks for the PR head: every check passed or was skipped, and at least one ran. Pure: takes `gh pr checks --json name,state,bucket`. */
export function githubChecks(payload) {
    if (!Array.isArray(payload))
        return { ok: false, reason: "checks: observed no check list, expected gh pr checks --json output" };
    if (payload.length === 0)
        return { ok: false, reason: "checks: observed no checks, expected at least one passing check for the head" };
    const bad = payload.filter((check) => !["pass", "skipping"].includes(str(check, "bucket") ?? ""));
    if (bad.length > 0) {
        const listed = bad.slice(0, 8).map((check) => `${str(check, "name") ?? "?"}=${str(check, "bucket") ?? str(check, "state") ?? "?"}`);
        return { ok: false, reason: `checks: observed ${listed.join(", ")}, expected every check to pass` };
    }
    return { ok: true, evidence: { checks: payload.length } };
}
/** `gh api --paginate --slurp` prints an array of pages; a single page or a bare array also reads. Items are flattened with `pick`. */
export function pages(payload, pick) {
    if (!Array.isArray(payload))
        return undefined;
    const out = [];
    for (const page of payload) {
        const items = Array.isArray(page) ? page : pick(page);
        if (Array.isArray(items))
            out.push(...items);
        else if (page !== null && typeof page === "object")
            out.push(page);
        else
            return undefined;
    }
    return out;
}
/**
 * Strict approval from the reviews REST list (`pulls/{n}/reviews`): a reviewer other than the PR
 * author whose latest decisive review is `APPROVED` on commit `sha`, and nobody whose latest
 * decisive review requests changes. Comments never count.
 */
export function reviewApproval(reviewsPayload, prAuthor, sha) {
    const reviews = pages(reviewsPayload, (page) => own(page, "reviews"));
    if (reviews === undefined)
        return { ok: false, reason: "approval: observed no review list, expected gh api pulls/{n}/reviews output" };
    if (prAuthor === null)
        return { ok: false, reason: "approval: observed no PR author, expected one to rule out a self-approval" };
    const latest = new Map();
    for (const review of reviews) {
        const state = str(review, "state");
        const who = str(own(review, "user"), "login");
        if (who === null || state === null || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state))
            continue;
        latest.set(who.toLowerCase(), { state, commit: str(review, "commit_id")?.trim().toLowerCase() ?? null });
    }
    const blocking = [...latest].filter(([, review]) => review.state === "CHANGES_REQUESTED").map(([who]) => who);
    if (blocking.length > 0)
        return { ok: false, reason: `approval: ${blocking.join(", ")} requested changes and has not approved since` };
    for (const [who, review] of latest) {
        if (review.state === "APPROVED" && review.commit === sha && who !== prAuthor.toLowerCase())
            return { ok: true, evidence: { kind: "review", reviewer: who, commit: sha } };
    }
    return { ok: false, reason: `approval: observed no APPROVED review of ${sha} by someone other than the PR author ${prAuthor}; comments do not count` };
}
const PASSING_RUN = new Set(["success", "neutral", "skipped"]);
/**
 * Every check run and commit status on `sha` is green, at least one exists, and every required
 * context is present and green. `runs` is `commits/{sha}/check-runs`, `status` is
 * `commits/{sha}/status`, `required` the contexts branch protection or rulesets demand, or
 * `undefined` when they were unreadable (then the all-green rule stands alone).
 */
export function commitChecks(input) {
    const runs = pages(input.runs, (page) => own(page, "check_runs"));
    const statusPages = Array.isArray(input.status) ? input.status : [input.status];
    const statuses = statusPages.flatMap((page) => {
        const list = own(page, "statuses");
        return Array.isArray(list) ? list : [];
    });
    if (runs === undefined || !statusPages.every((page) => Array.isArray(own(page, "statuses")))) {
        return { ok: false, reason: "checks: observed an unreadable check-run or status list, expected the commit's check-runs and status" };
    }
    const green = new Set();
    const bad = [];
    for (const run of runs) {
        const name = str(run, "name") ?? "?";
        const conclusion = str(run, "conclusion");
        if (str(run, "status") === "completed" && conclusion !== null && PASSING_RUN.has(conclusion))
            green.add(name);
        else
            bad.push(`${name}=${conclusion ?? str(run, "status") ?? "?"}`);
    }
    for (const status of statuses) {
        const name = str(status, "context") ?? "?";
        if (str(status, "state") === "success")
            green.add(name);
        else
            bad.push(`${name}=${str(status, "state") ?? "?"}`);
    }
    if (runs.length + statuses.length === 0)
        return { ok: false, reason: "checks: observed no check runs or statuses, expected at least one passing check for the head" };
    if (bad.length > 0)
        return { ok: false, reason: `checks: observed ${bad.slice(0, 8).join(", ")}, expected every check to pass` };
    if (input.requireKnown && input.required === undefined)
        return { ok: false, reason: "checks: branch protection or rulesets unreadable, so the required contexts are unknown; refusing" };
    const missing = (input.required ?? []).filter((context) => !green.has(context));
    if (missing.length > 0)
        return { ok: false, reason: `checks: required ${missing.join(", ")} not present and passing` };
    return { ok: true, evidence: { checks: runs.length + statuses.length, required: input.required?.length ?? null } };
}
/**
 * The required status contexts from `branches/{b}/protection/required_status_checks` and the
 * rulesets in `rules/branches/{b}`. `undefined` when neither could be read, so the caller knows the
 * requirement is unknown rather than empty.
 */
export function requiredContexts(protection, rules, options = {}) {
    if (protection === undefined && rules === undefined)
        return undefined;
    if (options.requireBoth && (protection === undefined || pages(rules, () => undefined) === undefined))
        return undefined;
    const contexts = new Set();
    const listed = own(protection, "contexts");
    if (Array.isArray(listed))
        for (const context of listed)
            if (typeof context === "string")
                contexts.add(context);
    const checks = own(protection, "checks");
    if (Array.isArray(checks))
        for (const check of checks)
            if (str(check, "context") !== null)
                contexts.add(str(check, "context"));
    const ruleList = pages(rules, () => undefined) ?? [];
    for (const rule of ruleList) {
        if (str(rule, "type") !== "required_status_checks")
            continue;
        const required = own(own(rule, "parameters"), "required_status_checks");
        if (Array.isArray(required))
            for (const check of required)
                if (str(check, "context") !== null)
                    contexts.add(str(check, "context"));
    }
    return [...contexts].sort();
}
/** Whether a branch ruleset (`rules/branches/{b}`) puts the branch behind a merge queue. */
export function usesMergeQueue(rules) {
    return (pages(rules, () => undefined) ?? []).some((rule) => str(rule, "type") === "merge_queue");
}
