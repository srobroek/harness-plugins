import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectCheckoutMarker, physical, verifyCheckout } from "@srobroek/opencode-lib/checkout-marker";
import { OPERATION_MARKERS, operationsInProgress, stashesOnBranch } from "@srobroek/opencode-lib/worktree-state";
import pkg from "../../package.json" with { type: "json" };
import { FORGE_TIMEOUT_MS, forgeEnvironment, forgeTarget, gitObservationEnvironment, normalizeRepoPath, observeGithubBranch, REMOTE_NAME, redactRemote, remoteBranchAbsent, repoPathFromRemote, runCli, SAFE_GIT_ARGS, singleRemoteRecord, } from "./forge-adapter.ts";
import { buildReceipt, canonicalLedger, closeoutCommands, listReceipts, provenReceiptDirectory, readReceipt, repoKey, repositoryContext, validateReceipt, writeReceipt, } from "./landing-receipt.ts";
import { retargetRepository } from "./target-repo.ts";
export const CLEANUP_BOUNDS = {
    refReadMs: 5_000,
    treeScanMs: 60_000, bdShowMs: 120_000, mutationMs: 600_000
};
const MAX_CLI_JSON_BYTES = 1024 * 1024;
const MAX_DIRTY_PATHS = 8;
const LOCAL_REF_PREFIX = "refs/heads/";
/** The GitHub fields this observation needs, in one `--json` projection. */
const PR_FIELDS = "number,url,state,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt";
/**
 * Which remover owns `target`: the host when its registry lists the same directory
 * (compared by canonical path), git otherwise. Pure given `canonical`.
 */
export function removalRoute(listed, target, canonical = (path) => physicalPath(path) ?? path) {
    const want = canonical(target);
    return listed.some((entry) => canonical(entry.directory) === want) ? "host" : "git";
}
/**
 * Whether a vanished worktree is provably gone: absent on disk and unregistered. Anything
 * seen on either side is present; an observation that could not be made proves nothing.
 */
export function targetAbsence(disk, registration) {
    if (disk === "present" || registration === "present")
        return "present";
    return disk === "absent" && registration === "absent" ? "absent" : "unknown";
}
function show(value) {
    if (typeof value === "string")
        return JSON.stringify(value);
    if (value === undefined)
        return "missing";
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
function refuse(field, observed, expected) {
    return { ok: false, reason: `${field}: observed ${show(observed)}, expected ${expected}` };
}
function isFailure(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, "ok");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === false;
}
const MAX_LISTED_CANDIDATES = 10;
function describeCandidates(candidates) {
    const shown = candidates.slice(0, MAX_LISTED_CANDIDATES).map((c) => {
        const state = c.receipt.worktree.removed ? "cleaned" : "uncleaned";
        return `pr ${c.receipt.pr.number} branch ${show(c.receipt.branch.name)} ${state} receipt ${c.path}`;
    });
    const more = candidates.length > shown.length ? ` (+${candidates.length - shown.length} more)` : "";
    return `${shown.join("; ")}${more}`;
}
function describeSelector(selector, scope) {
    if (selector.pr !== undefined)
        return `pr ${selector.pr}`;
    if (selector.branch !== undefined)
        return `branch ${show(selector.branch)}`;
    if (selector.worktree !== undefined)
        return `worktree ${show(selector.worktree)}`;
    if (selector.repo !== undefined)
        return `repo ${show(selector.repo)}`;
    return scope;
}
/**
 * Picks the one receipt a cleanup is about. `candidates` are validated receipts, newest first.
 * Only a PR's newest receipt in its repository counts, because a continuation supersedes the landing it continues.
 * `repo` scopes the candidates first. With no `pr`, `branch`, `worktree` or `head`, the selection then
 * prefers uncleaned receipts, and exactly one must remain. With one of them a cleaned receipt qualifies
 * too, so a repeated cleanup finds its finished landing. `pr`,
 * `branch` and `worktree` must all match; `head` breaks a tie by reviewed head oid, then branch.
 * Zero matches or several are refused with every candidate listed, never guessed.
 */
export function selectReceipt(candidates, selector, scope = "this repository") {
    const seen = new Set();
    let pool = candidates.filter((c) => {
        const key = `${c.receipt.repo.nameWithOwner}#${c.receipt.pr.number}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
    // Scope to the named repository first, so another repository's uncleaned receipt cannot hide this one's.
    if (selector.repo !== undefined)
        pool = pool.filter((c) => c.receipt.repo.nameWithOwner === selector.repo);
    const explicit = selector.pr !== undefined || selector.branch !== undefined || selector.worktree !== undefined;
    if (!explicit && selector.head === undefined) {
        // Uncleaned landings are what a bare call is about; with none left, the cleaned ones stay candidates
        // so a repeated call on a repository with a single landing is idempotent.
        const open = pool.filter((c) => !c.receipt.worktree.removed);
        if (open.length > 0)
            pool = open;
    }
    if (selector.pr !== undefined)
        pool = pool.filter((c) => c.receipt.pr.number === selector.pr);
    if (selector.branch !== undefined)
        pool = pool.filter((c) => c.receipt.branch.name === selector.branch);
    if (selector.worktree !== undefined) {
        const want = resolve(selector.worktree);
        pool = pool.filter((c) => c.receipt.worktree.path !== null && resolve(c.receipt.worktree.path) === want);
    }
    const head = selector.head;
    if (head !== undefined && (pool.length > 1 || !explicit)) {
        const byOid = pool.filter((c) => c.receipt.pr.headRefOid === head.oid);
        pool = byOid.length > 0 ? byOid : pool.filter((c) => c.receipt.branch.name === head.branch);
    }
    const [only] = pool;
    if (pool.length === 1 && only !== undefined)
        return { ok: true, candidate: only };
    const listing = candidates.length === 0 ? "no receipts" : `candidates: ${describeCandidates(candidates)}`;
    if (pool.length === 0) {
        return refuse("receipt", null, `the newest validated receipt for ${describeSelector(selector, scope)}; ${listing}`);
    }
    return refuse("receipt", `${pool.length} matching receipts`, `exactly one: pass receipt, pr or branch to choose; ${describeCandidates(pool)}`);
}
/** What a finished removal took and left, for the caller. Pure. */
export function removalReport(receipt, path, target, plan) {
    const removed = [`worktree ${path}`];
    const skipped = [];
    const branch = receipt.branch.name;
    if (plan === "delete")
        removed.push(`local branch ${branch}`);
    else if (plan === "absent")
        skipped.push(`local branch ${branch} was already gone`);
    else
        skipped.push(`local branch ${branch} left in place: it no longer points at the reviewed head`);
    if (!target.detached && target.branch !== null && target.branch !== `${LOCAL_REF_PREFIX}${branch}`) {
        skipped.push(`branch ${target.branch.slice(LOCAL_REF_PREFIX.length)} (the worktree's own) left in place`);
    }
    return { removed, skipped };
}
const withNotes = (report, notes) => notes.length === 0 ? report : { ...report, skipped: [...report.skipped, ...notes] };
const withRefusalNotes = (failure, notes) => notes.length === 0 ? failure : { ...failure, reason: `${failure.reason}; after the removal: ${notes.join("; ")}` };
/**
 * Whether a registered worktree is the landed one. Its HEAD must be the receipt's reviewed head;
 * the branch it sits on does not matter (a renamed branch, or none once the ref was deleted), and
 * any other HEAD is refused.
 */
export function acceptWorktree(record, receipt) {
    const failure = compare("worktree.HEAD", record.head, receipt.pr.headRefOid);
    if (failure !== null)
        return failure;
    if (record.detached || record.branch === null)
        return { ok: true, branch: "detached" };
    return { ok: true, branch: record.branch === `${LOCAL_REF_PREFIX}${receipt.branch.name}` ? "same" : "renamed" };
}
/**
 * The branch names whose stash entries block removal: the receipt's branch, and the branch the
 * worktree is actually on when that differs (a rename keeps the stash under the new name). Pure.
 */
export function stashBranches(receiptBranch, target) {
    // A stash made on a detached HEAD is subjected "WIP on (no branch)" / "On (no branch)".
    if (target.detached || target.branch === null)
        return [receiptBranch, DETACHED_STASH_BRANCH];
    const own = target.branch.slice(LOCAL_REF_PREFIX.length);
    return own === receiptBranch ? [receiptBranch] : [receiptBranch, own];
}
const DETACHED_STASH_BRANCH = "(no branch)";
/** What to do with the receipt branch's local ref: delete it only when it is still at the reviewed head. */
export function planLocalRef(observedOid, reviewedOid) {
    if (observedOid === null)
        return "absent";
    return observedOid === reviewedOid ? "delete" : "moved";
}
function commandLabel(argv) {
    return argv.map((value) => JSON.stringify(value)).join(" ");
}
function completed(result) {
    return result.ok && result.exitCode === 0 && result.error === undefined;
}
function commandFailure(field, argv, result, expected) {
    const exit = result.exitCode === null ? "no exit status" : `exit ${result.exitCode}`;
    const error = result.error === undefined ? "" : `, error ${result.error}`;
    const stderr = result.stderr.trim() === "" ? "" : `, stderr ${result.stderr.trim().slice(0, 400)}`;
    return refuse(field, `${commandLabel(argv)} (${exit}${error}${stderr})`, expected);
}
function own(holder, key) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    if (descriptor?.enumerable !== true || !("value" in descriptor))
        return undefined;
    return descriptor.value;
}
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : null;
}
function text(holder, key) {
    const value = own(holder, key);
    return typeof value === "string" && value !== "" ? value : null;
}
function integer(holder, key) {
    const value = own(holder, key);
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function parseJsonObject(field, result) {
    if (!completed(result))
        return commandFailure(field, [], result, "a successful bounded forge read");
    if (Buffer.byteLength(result.stdout) > MAX_CLI_JSON_BYTES) {
        return refuse(field, `JSON over ${MAX_CLI_JSON_BYTES} bytes`, `at most ${MAX_CLI_JSON_BYTES} bytes`);
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        return refuse(field, "unparseable JSON", "a JSON object from the forge");
    }
    return record(parsed) ?? refuse(field, parsed, "a JSON object from the forge");
}
function normalizedOid(value) {
    if (typeof value !== "string")
        return null;
    const oid = value.trim().toLowerCase();
    return oid === "" ? null : oid;
}
/**
 * Resolve the repository to observe from `repo.remote` — never from whichever
 * repository a forge CLI infers from the directory it runs in.
 *
 * `gh repo view` and `glab repo view` answer about whichever repository their CLI
 * treats as the local default, which is `origin`. On a checkout whose `origin` is
 * a contributor fork and whose `upstream` is the remote the landing was run with,
 * that is not the repository the receipt proves: the pull request came out of the
 * fork, and the identity comparison then refused a valid receipt, so cleanup
 * stayed blocked after a landing that had already succeeded. The remote *name* is
 * the field the receipt records, so the URL is resolved from that name and every
 * forge command is bound to the identity that URL names. That also moves the
 * identity decision ahead of every forge call, instead of catching a foreign
 * repository only after one was issued against it.
 *
 * `cwd` is the worktree the receipt names, not the directory cleanup was called in,
 * and the caller proves that path is a live listed worktree of this repository
 * before passing it. A remote name resolves per repository, but a remote *URL*
 * resolves per worktree: `extensions.worktreeConfig` scopes `url.<other>.insteadOf`
 * to one worktree, and `git remote get-url` expands those rewrites. So the landed
 * worktree and the directory cleanup runs from can print different URLs for the
 * same name, and only one of them is the URL the landing recorded.
 *
 * The Git read runs with {@link gitObservationEnvironment}: an ambient `GIT_DIR`,
 * `GIT_WORK_TREE`, or `GIT_CONFIG_*` selector decides which repository's remotes
 * are read, which is the same substitution by another route. The forge reads run
 * with {@link forgeEnvironment} and, on GitLab, an explicitly pinned canonical
 * host, and they are given no working directory at all: the repository is named
 * in the request, and nothing about the answer may depend on any directory.
 *
 * Every part of the identity is refused rather than guessed at: a receipt whose
 * remote is not a remote name, names no configured remote, names a host no
 * adapter verifies, names a different forge than the receipt recorded, carries no
 * `<owner>/<name>`, or names a repository other than the one the receipt proves is
 * not an observation. The last of those is the cross-check that makes a receipt
 * non-transferable: it is decided here, before one forge command is issued, so a
 * receipt carried into another checkout asks that checkout's forge nothing.
 */
async function resolveRemoteIdentity(receipt, run, cwd, forgeEnv, env, refReadMs, pin) {
    // Tested exactly as recorded, not trimmed first: `" origin"` is not the name of a
    // remote, it is a receipt that does not say which remote, and normalising it here
    // would let this call answer a question the receipt never asked.
    const remote = receipt.repo.remote;
    if (!REMOTE_NAME.test(remote))
        return refuse("repo.remote", remote, "a git remote name");
    const argv = ["git", ...SAFE_GIT_ARGS, "remote", "get-url", remote];
    const expected = `exactly one URL record for the configured remote ${remote} in ${cwd}`;
    const result = await run(argv, { cwd, timeoutMs: refReadMs, env: { ...gitObservationEnvironment(env), ...pin } });
    if (!completed(result))
        return commandFailure("repo.remote", argv, result, expected);
    // Not trimmed: a trimmed value is what lets a malformed one through. `URL` deletes
    // embedded tabs and newlines before parsing, so a rewritten or multi-URL remote can
    // read as an ordinary forge URL here while Git contacts something else — and this
    // identity then authorises a removal whose absence probe can only ever say
    // "unknown". One terminal newline is a record terminator; everything else refuses.
    //
    // The refusal names the shape, never the bytes. A remote URL may carry userinfo or a
    // token query, and output that no parser here accepts cannot be redacted either:
    // {@link redactRemote} can only locate a secret in a spelling it understands, so
    // echoing an unparseable value would publish whatever it holds into a refusal
    // message and into any log that quotes one.
    const remoteText = singleRemoteRecord(result.stdout);
    if (remoteText === null)
        return refuse("repo.remote", "malformed Git remote output", expected);
    // Classified before it is redacted: `forgeTarget` owns that judgement and must
    // see the spelling Git will actually contact.
    const target = forgeTarget(remoteText);
    const remoteUrl = redactRemote(remoteText);
    if (target === null) {
        return refuse("repo.forge", `"unknown" for remote ${remote} at ${show(remoteUrl)}`, '"github" or "gitlab"');
    }
    const forgeFailure = compare("repo.forge", target.forge, receipt.repo.forge);
    if (forgeFailure !== null)
        return forgeFailure;
    const fromRemote = repoPathFromRemote(remoteText);
    const nameWithOwner = fromRemote === null ? null : normalizeRepoPath(target.forge, fromRemote);
    if (nameWithOwner === null) {
        const shape = target.forge === "github" ? 'exactly "<owner>/<name>"' : 'a bounded "<group>/.../<project>" path';
        return refuse("repo.nameWithOwner", fromRemote, `${shape} from remote ${remote} at ${show(remoteUrl)}`);
    }
    const identityFailure = compare("repo.nameWithOwner", nameWithOwner, receipt.repo.nameWithOwner);
    if (identityFailure !== null)
        return identityFailure;
    // Both forges are addressed by canonical host and path, and both have that host
    // pinned in the environment as well. The host is not caller data: it is the
    // verified value `forgeTarget` returned for the transport host Git will contact,
    // so `gh` and `glab` are told the same thing twice and can infer neither from a
    // configured alias nor from the directory.
    const cliRepo = `${target.canonicalHost}/${nameWithOwner}`;
    const commandEnv = Object.assign(Object.create(null), forgeEnv, target.forge === "github"
        ? { GH_HOST: target.canonicalHost }
        : { GITLAB_HOST: target.canonicalHost, GITLAB_API_HOST: target.canonicalHost });
    // `remoteText`, not the redacted spelling: the absence probe has to contact what
    // Git contacted, and it is the one consumer allowed to hold the raw URL.
    return { forge: target.forge, nameWithOwner, cliRepo, remoteUrl: remoteText, env: commandEnv };
}
async function githubObservation(receipt, identity, run) {
    const argv = ["gh", "pr", "view", String(receipt.pr.number), "--repo", identity.cliRepo, "--json", PR_FIELDS];
    const method = argv.slice(0, 3).join(" ");
    const result = await run(argv, { timeoutMs: FORGE_TIMEOUT_MS, env: identity.env });
    if (!completed(result))
        return commandFailure("pr", argv, result, "a successful bounded GitHub pull-request read");
    const root = parseJsonObject("pr", result);
    if (isFailure(root))
        return root;
    const mergeCommit = record(own(root, "mergeCommit"));
    return {
        number: integer(root, "number") ?? -1,
        url: text(root, "url") ?? "",
        state: text(root, "state") ?? "",
        baseRefName: text(root, "baseRefName") ?? "",
        headRefName: text(root, "headRefName") ?? "",
        headRefOid: text(root, "headRefOid") ?? "",
        mergeCommitOid: mergeCommit === null ? null : normalizedOid(own(mergeCommit, "oid")),
        mergedAt: text(root, "mergedAt"),
        method,
    };
}
async function gitlabObservation(receipt, identity, run) {
    const argv = ["glab", "mr", "view", String(receipt.pr.number), "--repo", identity.cliRepo, "--output", "json"];
    const method = argv.slice(0, 3).join(" ");
    const result = await run(argv, { timeoutMs: FORGE_TIMEOUT_MS, env: identity.env });
    if (!completed(result))
        return commandFailure("pr", argv, result, "a successful bounded GitLab merge-request read");
    const root = parseJsonObject("pr", result);
    if (isFailure(root))
        return root;
    const mergeCommit = normalizedOid(own(root, "merge_commit_sha"));
    return {
        number: integer(root, "iid") ?? -1,
        url: text(root, "web_url") ?? "",
        state: text(root, "state") ?? "",
        baseRefName: text(root, "target_branch") ?? "",
        headRefName: text(root, "source_branch") ?? "",
        headRefOid: text(root, "sha") ?? "",
        mergeCommitOid: mergeCommit ?? normalizedOid(own(root, "squash_commit_sha")),
        mergedAt: text(root, "merged_at"),
        method,
    };
}
export async function observePullRequest(receipt, run = runCli, cwd = receipt.repo.canonicalRoot, env = process.env, refReadMs = CLEANUP_BOUNDS.refReadMs, pin) {
    const identity = await resolveRemoteIdentity(receipt, run, cwd, forgeEnvironment(env), env, refReadMs, pin);
    if (isFailure(identity))
        return identity;
    const pr = identity.forge === "github"
        ? await githubObservation(receipt, identity, run)
        : await gitlabObservation(receipt, identity, run);
    return isFailure(pr) ? pr : { identity, pr };
}
function compare(field, observed, expected) {
    return observed === expected ? null : refuse(field, observed, `receipt value ${show(expected)}`);
}
/**
 * Whether the observation is the landing the receipt proves.
 *
 * Only the pull request is compared here. The repository it was read from is not
 * one of the comparisons, because it was never in doubt: the read was bound to the
 * identity {@link resolveRemoteIdentity} had already matched against the receipt.
 */
function verifyObservation(receipt, observed) {
    const observedState = observed.state.trim().toUpperCase();
    const receiptState = receipt.pr.state.trim().toUpperCase();
    const comparisons = [
        ["pr.number", observed.number, receipt.pr.number],
        ["pr.url", observed.url, receipt.pr.url],
        ["pr.state", observedState, "MERGED"],
        ["receipt.pr.state", receiptState, "MERGED"],
        ["pr.baseRefName", observed.baseRefName, receipt.pr.baseRefName],
        ["pr.headRefName", observed.headRefName, receipt.pr.headRefName],
        ["pr.headRefOid", observed.headRefOid, receipt.pr.headRefOid],
        ["pr.mergeCommitOid", observed.mergeCommitOid, receipt.pr.mergeCommitOid],
        ["pr.mergedAt", observed.mergedAt, receipt.pr.mergedAt],
    ];
    for (const [field, actual, expected] of comparisons) {
        const failure = compare(field, actual, expected);
        if (failure !== null)
            return failure;
    }
    if (observed.headRefName !== receipt.branch.name) {
        return refuse("pr.headRefName", observed.headRefName, `receipt branch.name ${show(receipt.branch.name)}`);
    }
    return null;
}
/** Refusal for a receipt directory that {@link provenReceiptDirectory} could not trust. */
function untrustedDirectory(proof) {
    return refuse("receipt.directory", `${proof.at} (${proof.reason})`, "an existing non-symlink directory at and below the receipt root");
}
/**
 * The canonical path of a caller-named receipt in the proven receipt `directory`.
 *
 * The named path may reach that directory through an alias above the receipt root, such as
 * a symlinked home directory, so its parent is compared by realpath. The receipt file itself
 * is then lstat'd at its canonical path and refused if it is a symlink; the directories at
 * and below the receipt root were proved by the caller.
 */
function canonicalReceiptPath(raw, cwd, directory) {
    const supplied = resolve(cwd, raw);
    let parent;
    try {
        parent = realpathSync(dirname(supplied));
    }
    catch {
        parent = null;
    }
    if (parent !== directory)
        return refuse("receipt.path", supplied, `a direct entry under ${show(directory)}`);
    const target = join(directory, basename(supplied));
    let stat;
    try {
        stat = lstatSync(target);
    }
    catch {
        return refuse("receipt.path", target, "an existing canonical non-symlink receipt file");
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        return refuse("receipt.path", target, "a canonical non-symlink regular receipt file");
    }
    return target;
}
const FOREIGN_HINT = "a worktree of a repository other than this session's is never read from here: run delivery_cleanup from a session in that repository";
/** The refusal for a target repository other than the session's; nothing in the target was read. */
function foreignRepository() {
    return refuse("worktree.owner", "a receipt or worktree of a repository other than this session's", "delivery_cleanup run from a session in that repository; a checkout of another repository is untrusted, so nothing was read or removed");
}
function resolveReceipt(params, cwd, env, refReadMs, git, head) {
    const key = repoKey(cwd, git, refReadMs);
    if (key === null) {
        return {
            tag: "refused",
            failure: refuse("repo.key", null, "a repository key derived from the current Git common directory"),
        };
    }
    const proof = provenReceiptDirectory(env, key);
    const directory = proof.directory;
    let receipt = null;
    let receiptPath = null;
    if (params.receipt !== undefined) {
        // A receipt file sits in a directory named by its repository's key. One named for
        // another repository is refused here, from the path alone: nothing in that
        // repository's checkouts is read, because their config is not trusted.
        const named = basename(dirname(resolve(cwd, params.receipt)));
        if (/^[0-9a-f]{16}$/.test(named) && named !== key)
            return { tag: "refused", failure: foreignRepository() };
        if (!proof.ok)
            return { tag: "refused", failure: untrustedDirectory(proof) };
        const path = canonicalReceiptPath(params.receipt, cwd, directory);
        if (typeof path !== "string")
            return { tag: "refused", failure: path };
        const read = readReceipt(path);
        if (!read.ok)
            return { tag: "refused", failure: { ok: false, reason: read.reason } };
        receipt = read.receipt;
        receiptPath = path;
    }
    else {
        if (!proof.ok && proof.reason !== "absent")
            return { tag: "refused", failure: untrustedDirectory(proof) };
        const listed = proof.ok ? listReceipts(directory) : [];
        const candidates = listed.map((item) => ({ receipt: item, path: join(directory, `${item.receiptId}.json`) }));
        const selection = selectReceipt(candidates, { pr: params.pr, branch: params.branch, worktree: params.worktree, repo: params.repo, head }, `repo.key ${key}`);
        if (!selection.ok) {
            const hint = params.worktree === undefined ? "" : `; ${FOREIGN_HINT}`;
            return { tag: "refused", failure: { ok: false, reason: `${selection.reason}${hint}` } };
        }
        receipt = selection.candidate.receipt;
        receiptPath = selection.candidate.path;
    }
    if (receipt === null) {
        return { tag: "refused", failure: refuse("receipt", null, "a validated receipt") };
    }
    if (receiptPath === null)
        return {
            tag: "refused",
            failure: refuse("receipt.path", null, "the canonical path for the selected validated receipt"),
        };
    if (receipt.repo.key !== key) {
        return { tag: "refused", failure: refuse("repo.key", receipt.repo.key, `current repository key ${key}`) };
    }
    if (receipt.worktree.path === null) {
        return { tag: "refused", failure: refuse("worktree.path", null, "a linked-worktree path recorded by the receipt") };
    }
    return { tag: "resolved", receipt, path: receiptPath };
}
function verifyArguments(params, receipt) {
    const requested = [
        ["pr", params.pr, receipt.pr.number],
        ["branch", params.branch, receipt.branch.name],
        ["worktree", params.worktree, receipt.worktree.path],
        ["remote", params.remote, receipt.repo.remote],
        ["repo", params.repo, receipt.repo.nameWithOwner],
    ];
    for (const [field, supplied, expected] of requested) {
        if (supplied === undefined)
            continue;
        const failure = compare(field, supplied, expected);
        if (failure !== null)
            return failure;
    }
    return null;
}
async function runGit(run, cwd, args, timeoutMs, pin) {
    // A pin fixes `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` to what was verified, so
    // Git does not rediscover the repository through a `.git` marker that may have changed.
    return run(["git", ...SAFE_GIT_ARGS, ...args], {
        cwd,
        timeoutMs,
        env: { ...gitObservationEnvironment(process.env), ...pin },
    });
}
function worktreePathState(path) {
    let stat;
    try {
        stat = lstatSync(path);
    }
    catch (error) {
        return error.code === "ENOENT" ? "absent" : "unsafe";
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
        return "unsafe";
    try {
        realpathSync(path);
        return "directory";
    }
    catch {
        return "unsafe";
    }
}
function dirtyPaths(output) {
    return output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => (line.length > 3 ? line.slice(3) : line))
        .slice(0, MAX_DIRTY_PATHS);
}
/**
 * The target is clean: no tracked change, no untracked file (ignored files are allowed),
 * no merge/rebase/cherry-pick/revert/bisect in progress, and no stash made on its branch.
 * `git status --porcelain` alone misses the last two when the tree is otherwise clean.
 */
async function verifyCleanTarget(path, run, timeoutMs, pin, branches = []) {
    const state = worktreePathState(path);
    if (state !== "directory")
        return refuse("worktree.path", `${path} (${state})`, "a present non-symlink directory");
    const argv = ["status", "--porcelain"];
    const result = await runGit(run, path, argv, timeoutMs, pin);
    if (!completed(result))
        return commandFailure("worktree.status", ["git", ...argv], result, "exit 0 with empty output");
    if (result.stdout !== "") {
        const all = result.stdout.split(/\r?\n/).filter(Boolean);
        return refuse("worktree.status", { paths: dirtyPaths(result.stdout), total: all.length }, "no dirty paths (empty porcelain output)");
    }
    // The verified pin names this worktree's own git directory; no extra git read is needed.
    const gitDir = pin?.GIT_DIR;
    if (gitDir === undefined)
        return refuse("worktree.operation", path, "a verified git directory to read operation markers from");
    const operations = operationsInProgress(OPERATION_MARKERS.map((marker) => marker.name).filter((name) => existsSync(resolve(gitDir, name))));
    if (operations.length > 0)
        return refuse("worktree.operation", operations, "no merge, rebase, cherry-pick, revert or bisect in progress");
    if (branches.length > 0) {
        const stashArgv = ["stash", "list", "--format=%gs"];
        const stash = await runGit(run, path, stashArgv, timeoutMs, pin);
        if (!completed(stash))
            return commandFailure("worktree.stash", ["git", ...stashArgv], stash, "exit 0");
        const entries = branches.flatMap((branch) => stashesOnBranch(stash.stdout, branch));
        if (entries.length > 0) {
            return refuse("worktree.stash", entries.slice(0, MAX_DIRTY_PATHS), `no stash entries on ${branches.map(show).join(" or ")}`);
        }
    }
    return null;
}
async function verifyPushed(path, run, refReadMs, pin) {
    const upstreamArgv = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"];
    const upstream = await runGit(run, path, upstreamArgv, refReadMs, pin);
    if (upstream.error !== undefined || !upstream.ok) {
        return commandFailure("branch.upstream", ["git", ...upstreamArgv], upstream, "a completed upstream read");
    }
    if (upstream.exitCode !== 0 || upstream.stdout.trim() === "")
        return "pr-head";
    const countArgv = ["rev-list", "--count", "@{upstream}..HEAD"];
    const countResult = await runGit(run, path, countArgv, refReadMs, pin);
    if (!completed(countResult)) {
        return commandFailure("branch.unpushed", ["git", ...countArgv], countResult, "exit 0 and count 0");
    }
    const raw = countResult.stdout.trim();
    const count = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(count))
        return refuse("branch.unpushed", raw, "a non-negative integer count");
    if (count !== 0)
        return refuse("branch.unpushed", count, "0 commits above the upstream");
    return "upstream";
}
/**
 * The variables that choose which beads store `bd` opens, besides the working directory.
 * The beads plugin pins `BEADS_DIR` and `BEADS_DOLT_SHARED_SERVER` (and the marker that
 * tells its own pin from a user's) into every session shell; `bd` also honours a database
 * path and a socket.
 */
const LEDGER_SELECTORS = [
    "BEADS_DIR",
    "BEADS_DB",
    "BD_DB",
    "BD_SOCKET",
    "BEADS_DOLT_SHARED_SERVER",
    "SROBROEK_BEADS_PIN",
];
function withoutLedgerSelectors(env) {
    const rest = { ...env };
    for (const name of LEDGER_SELECTORS)
        delete rest[name];
    return rest;
}
function unwrapEnvelope(value) {
    const root = record(value);
    if (root === null || own(root, "schema_version") === undefined)
        return value;
    return own(root, "data");
}
/**
 * Whether the receipt's beads are closed with the landed merge sha, by the same read
 * `delivery_cleanup` makes. `open`: a bead is not closed (or lacks the sha) yet, which is
 * the one refusal that closing it fixes; `unknown`: the read or the classification failed.
 */
export async function ledgerState(receipt, cwd, receiptPath, run = runCli, timeoutMs = CLEANUP_BOUNDS.bdShowMs, refReadMs = CLEANUP_BOUNDS.refReadMs, git) {
    const failure = await verifyLedger(receipt, cwd, receiptPath, run, timeoutMs, refReadMs, git, process.env);
    if (failure === null)
        return "closed";
    return /^beads\.(?!ledgerActive)[^:]+:/.test(failure.reason) ? "open" : "unknown";
}
/**
 * The native close-out gate: classify the ledger at the canonical root, require the
 * receipt to agree, and then require every bead it names to be closed against this
 * merge.
 *
 * The stored boolean is never the gate on its own. A receipt is a file written by an
 * earlier call, possibly from a different directory and possibly tampered with, and
 * `beads.ledgerActive: false` read straight off it used to return success here — so
 * landing from a directory shadowed by a nested retired `.beads` and cleaning from
 * the repository whose canonical ledger is active removed the worktree and deleted
 * the branch while the authoritative bead stayed open. The classification is
 * therefore recomputed on every call, at the canonical root {@link canonicalLedger}
 * derives, and a disagreement refuses naming both values.
 *
 * A repository that cannot be classified refuses too: an unclassifiable ledger is
 * not an absent one, and the only irreversible step in this tool is on the other
 * side of this check.
 *
 * An active ledger with no bead ids is not handled here. `validateReceipt` refuses
 * that pair at the trust boundary, so a receipt read by this tool never carries it.
 */
async function verifyLedger(receipt, cwd, receiptPath, run, timeoutMs, refReadMs, git, env) {
    const classification = canonicalLedger(cwd, git, refReadMs);
    if (classification === null) {
        return refuse("beads.ledgerActive", `no ledger classification from ${cwd}`, "a repository whose canonical root can be resolved, so the receipt's ledger claim can be recomputed rather than trusted");
    }
    const landedSha = receipt.pr.mergeCommitOid ?? "missing";
    const nativeSteps = receipt.beads.ids.flatMap((id) => {
        const { update, close } = closeoutCommands(id, receipt.pr.number, landedSha, receiptPath);
        return [update, close];
    });
    if (classification.active !== receipt.beads.ledgerActive) {
        return {
            ok: false,
            reason: `beads.ledgerActive: observed ${receipt.beads.ledgerActive} stored in the receipt, expected ${classification.active}, recomputed at canonical root ${show(classification.root)}; ${classification.active
                ? `this repository's ledger is active, so for each receipt bead in child-before-parent order run ${nativeSteps.join("; ")}, then delivery_cleanup`
                : `the receipt was written against a ledger this repository does not have, so nothing was removed because the canonical ledger classification disagreed with the receipt; to recover, run delivery_land for PR #${receipt.pr.number} again${receipt.worktree.path === null ? "" : ` with worktree ${show(receipt.worktree.path)}`}, which proves the already-merged request without merging and writes a fresh receipt, then run delivery_cleanup with that new receipt`}`,
        };
    }
    if (!classification.active)
        return null;
    const argv = ["bd", "show", ...receipt.beads.ids, "--json"];
    // The read is about the ledger of the repository the classification was made for, so it
    // runs at that root and opens that ledger alone: a store the session pinned (its
    // `BEADS_DIR`, a database path, a shared server) would answer for another repository.
    const result = await run(argv, {
        cwd: classification.root,
        timeoutMs,
        env: { ...withoutLedgerSelectors(env), BD_JSON_ENVELOPE: "1", BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" },
    });
    if (!completed(result))
        return commandFailure("beads", argv, result, "a successful read-only bd show");
    if (Buffer.byteLength(result.stdout) > MAX_CLI_JSON_BYTES) {
        return refuse("beads", `JSON over ${MAX_CLI_JSON_BYTES} bytes`, `at most ${MAX_CLI_JSON_BYTES} bytes`);
    }
    let parsed;
    try {
        parsed = unwrapEnvelope(JSON.parse(result.stdout));
    }
    catch {
        return refuse("beads", "unparseable JSON", "an issue array from read-only bd show");
    }
    if (!Array.isArray(parsed))
        return refuse("beads", parsed, "an issue array from read-only bd show");
    const rows = new Map();
    for (const item of parsed) {
        const issue = record(item);
        const id = issue === null ? null : text(issue, "id");
        if (issue === null || id === null)
            return refuse("beads", item, "issues with string ids");
        const prior = rows.get(id);
        if (prior !== undefined && !isDeepStrictEqual(prior, issue)) {
            return refuse(`beads.${id}`, [prior, issue], "duplicate bd show rows for one bead id to be identical");
        }
        if (prior === undefined)
            rows.set(id, issue);
    }
    for (const id of receipt.beads.ids) {
        const issue = rows.get(id);
        const { update, close } = closeoutCommands(id, receipt.pr.number, landedSha, receiptPath);
        if (issue === undefined)
            return refuse(`beads.${id}`, null, `a bead returned by bd show before ${update} then ${close}`);
        const status = text(issue, "status");
        if (status !== "closed")
            return refuse(`beads.${id}.status`, status, `"closed" after ${update} then ${close}`);
        const metadata = record(own(issue, "metadata"));
        const mergeSha = metadata === null ? undefined : own(metadata, "merge_sha");
        if (typeof mergeSha !== "string" || mergeSha !== receipt.pr.mergeCommitOid) {
            return refuse(`beads.${id}.metadata.merge_sha`, mergeSha, `receipt pr.mergeCommitOid ${show(receipt.pr.mergeCommitOid)} after ${update} then ${close}`);
        }
    }
    return null;
}
export function parseWorktreeList(output) {
    const records = [];
    let current = null;
    for (const line of output.split("\n")) {
        if (line === "") {
            if (current !== null)
                records.push(current);
            current = null;
            continue;
        }
        if (line.startsWith("worktree ")) {
            if (current !== null)
                records.push(current);
            current = { path: line.slice(9), head: "", branch: null, detached: false, prunable: false };
            continue;
        }
        if (current === null)
            continue;
        if (line.startsWith("HEAD "))
            current.head = line.slice(5);
        else if (line.startsWith("branch "))
            current.branch = line.slice(7);
        else if (line === "detached")
            current.detached = true;
        else if (line.startsWith("prunable"))
            current.prunable = true;
    }
    if (current !== null)
        records.push(current);
    return records;
}
async function readWorktrees(cwd, run, refReadMs, pin) {
    const argv = ["worktree", "list", "--porcelain"];
    const result = await runGit(run, cwd, argv, refReadMs, pin);
    if (!completed(result))
        return commandFailure("worktree.list", ["git", ...argv], result, "exit 0 porcelain records");
    const records = parseWorktreeList(result.stdout);
    if (records.length === 0)
        return refuse("worktree.list", [], "at least the repository's main worktree");
    const malformed = records.find((item) => item.path === "" || !isAbsolute(item.path));
    if (malformed !== undefined)
        return refuse("worktree.list.path", malformed.path, "a non-empty absolute path in every record");
    return records;
}
/**
 * Whether `path` is provably a checkout of another repository than the session's.
 * A path the session repository itself lists is never foreign. The proof is only used
 * to choose the refusal; what lets Git run in a target is that the session lists it.
 */
async function isForeignCheckout(path, cwd, records, run, refReadMs) {
    const real = physicalPath(path);
    if (real !== null && recordForTarget([...records], real) !== null)
        return false;
    const argv = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    const result = await runGit(run, cwd, argv, refReadMs);
    const session = completed(result) ? physicalPath(result.stdout.trim()) : null;
    return session !== null && ["foreign", "unsafe"].includes(inspectCheckoutMarker(path, session));
}
function physicalPath(path) {
    return physical(path);
}
/**
 * Whether this call was made from inside the worktree it would remove.
 *
 * `git worktree remove` aimed at the caller's own directory leaves the process
 * standing in a deleted path, and every absence check after that point is then
 * answered from somewhere that no longer exists — so the removal is both the
 * destruction and the loss of its own proof. Comparison is by realpath and by
 * containment: a subdirectory of the target is inside the target, and a symlinked
 * alias of either resolves to the same place.
 *
 * A path that does not resolve is not treated as inside: the later listing and
 * directory checks refuse an unresolvable target by name, and guessing here would
 * hide that refusal behind a less specific one.
 */
function invocationInsideTarget(cwd, target) {
    const invocation = physicalPath(cwd);
    const resolved = physicalPath(target);
    if (invocation === null || resolved === null)
        return false;
    return invocation === resolved || invocation.startsWith(`${resolved}${sep}`);
}
/** The registered record whose physical path is `expected`, which the caller has already resolved once. */
function recordForTarget(records, expected) {
    for (const item of records) {
        if (physicalPath(item.path) === expected)
            return item;
    }
    return null;
}
function storedRecordForTarget(records, target) {
    const expected = resolve(target);
    for (const item of records) {
        if (resolve(item.path) === expected)
            return item;
    }
    return null;
}
/**
 * The registered record naming `target`, however the path is spelled. A directory that
 * still exists is compared by its physical path, so a symlinked parent matches; one that
 * has vanished keeps its physical parent and its own name, so a stored spelling matches.
 */
function registeredRecord(records, target) {
    const canonical = (path) => {
        const full = resolve(path);
        const real = physicalPath(full);
        if (real !== null)
            return real;
        const parent = physicalPath(dirname(full));
        return parent === null ? full : join(parent, basename(full));
    };
    const expected = canonical(target);
    for (const item of records) {
        if (canonical(item.path) === expected)
            return item;
    }
    return null;
}
async function verifyTargetIdentity(receipt, cwd, run, refReadMs, git) {
    const path = receipt.worktree.path;
    const listed = await readWorktrees(cwd, run, refReadMs);
    if (!Array.isArray(listed))
        return listed;
    const main = listed[0];
    if (main === undefined)
        return refuse("worktree.list", [], "a main worktree record");
    // The caller's path is resolved exactly once. Registration matching, the marker reads,
    // the pin and every later command use this physical path and never the spelling the
    // receipt gave, so a parent directory that is a symlink switched between steps cannot
    // make them look at different trees. The path must equal a registered worktree path.
    const physicalTarget = physicalPath(path);
    if (physicalTarget === null)
        return refuse("worktree.path", path, "an exact live record in git worktree list --porcelain");
    if (physicalTarget === physicalPath(main.path))
        return refuse("worktree.path", path, `a linked worktree other than main ${show(main.path)}`);
    const target = recordForTarget(listed, physicalTarget);
    if (target === null && (await isForeignCheckout(path, cwd, listed, run, refReadMs)))
        return refuse("worktree.path", path, "a worktree in the current repository");
    if (target === null || target.prunable)
        return refuse("worktree.path", path, "an exact live record in git worktree list --porcelain");
    // The registration is the session repository's, but the directory behind it is
    // whatever is on disk now: a replaced checkout, or a `.git` link into another
    // repository, would make the Git commands below run in code this repository does
    // not own. Nothing runs in the target until its marker provably belongs here.
    const common = repositoryContext(cwd, git, refReadMs)?.commonDir ?? null;
    const verdict = common === null ? { state: "unsafe" } : verifyCheckout(physicalTarget, common);
    if (verdict.state !== "same" || common === null) {
        return refuse("worktree.marker", `${path} (.git ${verdict.state})`, "a regular .git file naming a directory under this repository's worktrees/ whose commondir is this repository; nothing was read in the worktree");
    }
    const accepted = acceptWorktree(target, receipt);
    if (!accepted.ok)
        return accepted;
    // A receipt path whose last component is itself a link is refused as before; the check
    // only refuses, nothing after it uses the caller's spelling.
    if (worktreePathState(physicalTarget) !== "directory" || worktreePathState(path) !== "directory") {
        return refuse("worktree.path", `${path} (unsafe)`, "the listed non-symlink directory");
    }
    return { records: listed, target, main, common, pin: verdict.pin, cwd: physicalTarget };
}
/**
 * Reads the receipt branch's local ref. A ref that is gone is not a failure (the branch may have
 * been deleted or renamed away); a ref that cannot be read is.
 */
async function verifyLocalRef(receipt, cwd, run, refReadMs, pin) {
    const presence = await localRefAbsence(cwd, receipt.branch.name, run, refReadMs, pin);
    if (presence === "unknown")
        return refuse("branch.localRef", "unreadable", "a readable local ref state");
    if (presence === "absent")
        return planLocalRef(null, receipt.pr.headRefOid);
    const ref = `${LOCAL_REF_PREFIX}${receipt.branch.name}`;
    const argv = ["rev-parse", "--verify", ref];
    const result = await runGit(run, cwd, argv, refReadMs, pin);
    if (!completed(result))
        return commandFailure("branch.localRef", ["git", ...argv], result, `exit 0 and oid ${receipt.pr.headRefOid}`);
    return planLocalRef(result.stdout.trim(), receipt.pr.headRefOid);
}
async function revalidateBoundary(receipt, cwd, run, bounds, git) {
    const identity = await verifyTargetIdentity(receipt, cwd, run, bounds.refReadMs, git);
    if (isFailure(identity))
        return identity;
    const ref = await verifyLocalRef(receipt, cwd, run, bounds.refReadMs);
    if (isFailure(ref))
        return ref;
    const clean = await verifyCleanTarget(identity.cwd, run, bounds.treeScanMs, identity.pin, stashBranches(receipt.branch.name, identity.target));
    if (clean !== null)
        return clean;
    const pushed = await verifyPushed(identity.cwd, run, bounds.refReadMs, identity.pin);
    return isFailure(pushed) ? pushed : identity;
}
async function registrationAbsence(cwd, trustedPath, run, refReadMs, pin) {
    const listed = await readWorktrees(cwd, run, refReadMs, pin);
    if (!Array.isArray(listed))
        return "unknown";
    return storedRecordForTarget(listed, trustedPath) === null ? "absent" : "present";
}
function pathAbsence(path) {
    try {
        lstatSync(path);
        return "present";
    }
    catch (error) {
        return error.code === "ENOENT" ? "absent" : "unknown";
    }
}
async function localRefAbsence(cwd, branch, run, refReadMs, pin) {
    const argv = ["show-ref", "--verify", "--quiet", `${LOCAL_REF_PREFIX}${branch}`];
    const result = await runGit(run, cwd, argv, refReadMs, pin);
    if (result.error !== undefined || !result.ok)
        return "unknown";
    if (result.exitCode === 0)
        return "present";
    if (result.exitCode === 1 && result.stdout === "" && result.stderr === "")
        return "absent";
    return "unknown";
}
function safeExecutionCwd(receipt, records, invocationCwd) {
    const target = physicalPath(receipt.worktree.path);
    const preferred = records.find((item) => item.branch === `${LOCAL_REF_PREFIX}${receipt.pr.baseRefName}` && physicalPath(item.path) !== target);
    if (preferred !== undefined && worktreePathState(preferred.path) === "directory")
        return preferred.path;
    const invocation = records.find((item) => physicalPath(item.path) === physicalPath(invocationCwd) && physicalPath(item.path) !== target);
    if (invocation !== undefined && worktreePathState(invocation.path) === "directory")
        return invocation.path;
    const main = records[0];
    return main !== undefined && physicalPath(main.path) !== target && worktreePathState(main.path) === "directory"
        ? main.path
        : null;
}
function nextReceiptEpoch(receipt, now) {
    const observed = Math.trunc(now());
    const prior = Date.parse(receipt.emittedAt);
    return Math.max(observed, Number.isFinite(prior) ? prior + 1 : observed);
}
export function branchDeleteArgs(branch) {
    return ["branch", "-d", "--", branch];
}
/**
 * Remove a landed pull request's worktree and local branch. A `repo` that names the
 * session's repository changes nothing. A `repo` of another repository is verified
 * (its clone, named by `repoPath` or `worktree`, must have a remote naming it) and then
 * refused with {@link foreignCleanupReason}: that cleanup runs from a session there.
 */
export async function cleanupDelivery(params, sessionCwd, deps = {}) {
    const { repo: requested, repoPath, ...rest } = params;
    // The requested repository stays on every path. It names the repository the receipt must
    // belong to, so a session whose clone has several remotes (an `upstream` and an `origin`)
    // cannot clean the receipt of one while being asked for the other.
    const repo = requested?.trim() === "" ? undefined : requested?.trim();
    if (repo === undefined && repoPath === undefined)
        return cleanupInRepository(rest, sessionCwd, deps);
    const refReadMs = { ...CLEANUP_BOUNDS, ...deps.bounds }.refReadMs;
    const run = (argv, options) => (deps.run ?? runCli)(argv, { ...options, signal: deps.signal });
    const read = async (at, argv) => {
        const result = await runGit(run, at, [...argv], refReadMs);
        return completed(result) ? result.stdout : null;
    };
    const target = await retargetRepository({ repo, repoPath, worktree: rest.worktree }, sessionCwd, read);
    if ("reason" in target)
        return { ok: false, reason: target.reason };
    if (target.retargeted)
        return { ok: false, reason: foreignCleanupReason(repo ?? "", target.cwd) };
    return cleanupInRepository({ ...rest, repo }, target.cwd, deps);
}
/**
 * Why cleanup of another repository's landing is refused from this session. Lane claims,
 * holds, denials, the removal lock and the bead ledger it must respect all belong to
 * that repository, and this session reads only its own; removing from here could take
 * a worktree another agent in that repository still owns.
 */
export function foreignCleanupReason(repo, root) {
    return `repo: observed ${JSON.stringify(repo.trim())}, a repository other than this session's; its lane claims, holds and bead ledger are not visible from here, so run delivery_cleanup from a session in ${root}; nothing was removed`;
}
async function cleanupInRepository(params, cwd, deps) {
    const { signal } = deps;
    const bounds = { ...CLEANUP_BOUNDS, ...deps.bounds };
    // `commit` runs the removal and everything after it; `run` carries the signal, so an
    // interrupt ends whichever read is running and keeps the next one from starting.
    const commit = deps.run ?? runCli;
    const run = (argv, options) => commit(argv, { ...options, signal });
    const now = deps.now ?? Date.now;
    const env = deps.env ?? process.env;
    // A target of another repository is refused from the session repository's own
    // worktree list and plain filesystem reads, before any Git process touches it. It is
    // only looked for when the selectors have already failed to name a receipt of this
    // repository, so an ordinary cleanup pays no extra read.
    // The HEAD of the worktree the caller named, from the session repository's own list, to tell
    // apart receipts that the other selectors leave ambiguous. Read only when it can matter.
    const worktreeHead = async () => {
        if (params.receipt !== undefined || params.worktree === undefined || params.worktree.trim() === "")
            return undefined;
        const listed = await readWorktrees(cwd, run, bounds.refReadMs);
        if (!Array.isArray(listed))
            return undefined;
        const record = storedRecordForTarget(listed, resolve(cwd, params.worktree.trim()));
        if (record === null)
            return undefined;
        const branch = record.detached || record.branch === null ? null : record.branch.slice(LOCAL_REF_PREFIX.length);
        return { branch, oid: record.head };
    };
    const foreignWorktree = async () => {
        if (params.worktree === undefined || params.worktree.trim() === "")
            return false;
        const listed = await readWorktrees(cwd, run, bounds.refReadMs);
        return (Array.isArray(listed) &&
            (await isForeignCheckout(resolve(cwd, params.worktree.trim()), cwd, listed, run, bounds.refReadMs)));
    };
    // A worktree that is already gone (cleaned before, or removed by hand) has nothing left to remove.
    // Success without a receipt write, because no proof was made now and a repeat must change nothing.
    const alreadyCleaned = async (receipt, receiptPath) => {
        const target = receipt.worktree.path;
        const cleaned = receipt.worktree.removed;
        // A receipt not yet cleaned goes on to the full checks, without an extra Git call,
        // unless the path is already absent on disk.
        if (!cleaned && pathAbsence(target) !== "absent")
            return null;
        const listed = await readWorktrees(cwd, run, bounds.refReadMs);
        // The disk is read again here, after the await: whatever appeared while Git ran counts.
        const disk = pathAbsence(target);
        const record = Array.isArray(listed) ? registeredRecord(listed, target) : null;
        const registration = !Array.isArray(listed) ? "unknown" : record === null ? "absent" : "present";
        const state = targetAbsence(disk, registration);
        let note = null;
        if (state === "absent") {
            note = cleaned
                ? `worktree ${target} was already cleaned by an earlier call`
                : `worktree ${target} is already gone (neither on disk nor registered); nothing was removed and the landing receipt is unchanged`;
        }
        else if (!cleaned) {
            return null;
        }
        else if (state === "present") {
            // A cleaned receipt does not prove the path is still empty: something may have been
            // created or registered there since. Never remove it; report what is there and stop.
            return {
                ok: false,
                reason: `worktree.path: ${target} was cleaned by an earlier call but a ${record !== null ? "registered worktree" : "directory"} exists there now (HEAD ${record?.head ?? "unknown, not a registered worktree"}); it was not removed, so inspect it and run delivery_cleanup against a new landing receipt if it should go`,
            };
        }
        else {
            const why = Array.isArray(listed)
                ? `the filesystem read of ${target} failed`
                : `the worktree list could not be read (${listed.reason})`;
            return {
                ok: false,
                reason: `worktree.path: ${target} was cleaned by an earlier call, but ${why}, so its absence is unproven; nothing was removed`,
            };
        }
        return {
            ok: true,
            receipt,
            path: receiptPath,
            remoteBranchAbsence: receipt.branch.deletedRemote ? "absent" : "unknown",
            alreadyCleaned: true,
            localRefDeleted: false,
            report: { removed: [], skipped: [note] },
        };
    };
    const resolution = resolveReceipt(params, cwd, env, bounds.refReadMs, deps.git, await worktreeHead());
    if (resolution.tag === "refused")
        return (await foreignWorktree()) ? foreignRepository() : resolution.failure;
    const receipt = resolution.receipt;
    const argsFailure = verifyArguments(params, receipt);
    if (argsFailure !== null)
        return (await foreignWorktree()) ? foreignRepository() : argsFailure;
    const gone = await alreadyCleaned(receipt, resolution.path);
    if (gone !== null)
        return gone;
    if (typeof receipt.pr.mergeCommitOid !== "string" || receipt.pr.mergeCommitOid.trim() === "") {
        return refuse("pr.mergeCommitOid", receipt.pr.mergeCommitOid, "a non-empty merge commit oid before cleanup");
    }
    // Before any observation, and long before the irreversible step: a call from inside
    // its own target can neither remove it safely nor verify the removal afterwards.
    if (invocationInsideTarget(cwd, receipt.worktree.path)) {
        return refuse("worktree.invocationCwd", cwd, `a directory outside the worktree this call would remove (${receipt.worktree.path}, resolved to ${physicalPath(receipt.worktree.path)})`);
    }
    // The target's identity is proved before the pull request is read, because the read
    // has to be made from inside the target. With `extensions.worktreeConfig`, a
    // `url.<other>.insteadOf` rewrite is worktree-scoped, and `git remote get-url`
    // expands those rewrites: the same remote name resolves to one repository in the
    // landed worktree and another here. The URL the landing recorded is the one its own
    // worktree resolves, so resolving it anywhere else refuses a valid receipt and
    // leaves that worktree permanently unremovable.
    //
    // This is a read: `git worktree list --porcelain` and one `lstat`. It proves the
    // path is a live, listed, non-symlink linked worktree of this repository on the
    // receipt's branch and head before it is used as a directory to run a command in,
    // and `revalidateBoundary` proves the same identity again immediately before the
    // irreversible step.
    const identity = await verifyTargetIdentity(receipt, cwd, run, bounds.refReadMs, deps.git);
    if (isFailure(identity))
        return identity;
    const observed = await observePullRequest(receipt, run, identity.cwd, env, bounds.refReadMs, identity.pin);
    if (isFailure(observed))
        return observed;
    const observedFailure = verifyObservation(receipt, observed.pr);
    if (observedFailure !== null)
        return observedFailure;
    const path = receipt.worktree.path;
    const dirty = await verifyCleanTarget(identity.cwd, run, bounds.treeScanMs, identity.pin, stashBranches(receipt.branch.name, identity.target));
    if (dirty !== null)
        return dirty;
    const pushed = await verifyPushed(identity.cwd, run, bounds.refReadMs, identity.pin);
    if (isFailure(pushed))
        return pushed;
    const ledger = await verifyLedger(receipt, cwd, resolution.path, run, bounds.bdShowMs, bounds.refReadMs, deps.git, env);
    if (ledger !== null)
        return ledger;
    // The prompt (if any) comes first and outside the critical section: a held lock must never wait on a person.
    await deps.authorize?.({ worktree: path, branch: receipt.branch.name, pr: receipt.pr.number });
    let absenceProven = false;
    const removeSection = async () => {
        const localRef = await verifyLocalRef(receipt, cwd, run, bounds.refReadMs);
        if (isFailure(localRef))
            return localRef;
        const boundary = await revalidateBoundary(receipt, cwd, run, bounds, deps.git);
        if (isFailure(boundary))
            return boundary;
        const executionCwd = safeExecutionCwd(receipt, boundary.records, cwd);
        if (executionCwd === null)
            return refuse("worktree.executionCwd", null, "a different listed worktree for the same repository");
        // The directory the removal and the branch deletion run from is pinned the same way,
        // so a marker swapped after this point cannot redirect them either.
        const executionDir = physicalPath(executionCwd);
        const executionVerdict = executionDir === null ? { state: "absent" } : verifyCheckout(executionDir, boundary.common);
        if (executionDir === null || executionVerdict.state !== "same")
            return refuse("worktree.executionCwd", `${executionCwd} (.git ${executionVerdict.state})`, "a verified worktree of this repository");
        const executionPin = executionVerdict.pin;
        const targetPath = boundary.target.path;
        const removeArgv = ["worktree", "remove", targetPath];
        // Ownership is decided before the last abort check, so an interrupt during the
        // listing still stops the call. A host that is present but cannot list leaves the
        // owner unknown; removing with git could strand its registry entry, so refuse.
        let route = "git";
        if (deps.host !== undefined) {
            try {
                route = removalRoute(await deps.host.list(), targetPath);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return refuse("worktree.owner", `host worktree.list failed (${message.trim().slice(0, 400)})`, "a readable OpenCode worktree registry; nothing was removed, so retry delivery_cleanup once the host responds");
            }
        }
        // The last point an interrupt is honoured. Past it the removal runs to completion or
        // to its bound, and the steps after it record what happened instead of stopping
        // with the worktree gone and no continuation receipt.
        if (signal?.aborted === true)
            return refuse("signal", "an abort", "no interrupt before the worktree removal; nothing was removed");
        const held = await deps.finalCheck?.(targetPath);
        if (held !== undefined) {
            return refuse("worktree.held", held, "no owner, hold, denial or competing remover at the moment of removal; nothing was removed");
        }
        // An interrupt that arrived during the final lookup still stops the call; once the removal starts, nothing does.
        if (signal?.aborted === true)
            return refuse("signal", "an abort", "no interrupt before the worktree removal; nothing was removed");
        if (route === "host" && deps.host !== undefined) {
            try {
                await deps.host.remove(targetPath);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return refuse("worktree.removed", `host worktree.remove ${JSON.stringify(targetPath)} (error ${message.trim().slice(0, 400)})`, "host removal without force");
            }
        }
        else {
            const removed = await runGit(commit, executionDir, removeArgv, bounds.mutationMs, executionPin);
            if (!completed(removed)) {
                return commandFailure("worktree.removed", ["git", ...removeArgv], removed, "exit 0 without --force");
            }
        }
        const registration = await registrationAbsence(executionDir, targetPath, commit, bounds.refReadMs, executionPin);
        const pathGone = pathAbsence(targetPath);
        if (registration !== "absent")
            return refuse("worktree.registrationAbsence", registration, '"absent" after removal');
        if (pathGone !== "absent")
            return refuse("worktree.pathAbsence", pathGone, '"absent" after removal');
        // From here the worktree is gone and proven so; whatever fails later, work that follows the removal still runs.
        absenceProven = true;
        const refAfterWorktree = await verifyLocalRef(receipt, executionDir, commit, bounds.refReadMs, executionPin);
        if (isFailure(refAfterWorktree))
            return refAfterWorktree;
        // A ref that was at the reviewed head before the removal and is not now was moved by someone else.
        if (localRef === "delete" && refAfterWorktree !== "delete") {
            return refuse("branch.localRef", refAfterWorktree, `a ref still at ${receipt.pr.headRefOid}, as before the removal`);
        }
        // Only a ref still at the reviewed head is deleted; one that is gone or has moved is left as found.
        if (refAfterWorktree === "delete") {
            const deleteArgv = branchDeleteArgs(receipt.branch.name);
            const deleted = await runGit(commit, executionDir, deleteArgv, bounds.mutationMs, executionPin);
            if (!completed(deleted)) {
                return commandFailure("worktree.localRefDeleted", ["git", ...deleteArgv], deleted, "exit 0 without -D");
            }
        }
        const localAbsence = await localRefAbsence(executionDir, receipt.branch.name, commit, bounds.refReadMs, executionPin);
        // The last probe must give a definite answer that matches the plan: absent after a deletion or
        // when the ref was gone, present when it was left because it moved. An unknown answer never passes.
        const expected = refAfterWorktree === "moved" ? "present" : "absent";
        if (localAbsence !== expected) {
            return refuse("worktree.localRefAbsence", localAbsence, `"${expected}" (ref plan ${refAfterWorktree})`);
        }
        return { ok: true, registration, pathGone, localAbsence, localRefPlan: refAfterWorktree, executionDir };
    };
    const section = deps.removalSection === undefined ? await removeSection() : await deps.removalSection(path, removeSection);
    // After the lock is released, and whether or not the later steps (branch deletion, ref probes) held.
    let afterNotes = [];
    if (absenceProven) {
        try {
            afterNotes = (await deps.afterRemoval?.(path)) ?? [];
        }
        catch (error) {
            afterNotes = [`work after the removal failed: ${error instanceof Error ? error.message : String(error)}`];
        }
    }
    if (isFailure(section))
        return withRefusalNotes(section, afterNotes);
    const { registration, pathGone, localAbsence, localRefPlan, executionDir } = section;
    // The probe is given the URL the target resolved, not `repo.remote`. A name is
    // re-resolved wherever it is asked, and by now the target is gone, so the question
    // would be answered through a surviving worktree's configuration: one
    // worktree-scoped `insteadOf` there and `git ls-remote` asks a different repository,
    // whose exit 2 would be recorded as verified absence of a branch that still exists.
    // A false absence is the one verdict this tool must never invent, so the probe
    // contacts exactly what Git contacted when the identity was resolved. `cwd` is still
    // a surviving worktree: Git needs a repository for the protocol and helper pins the
    // adapter puts on this read. The verdict comes back as a word, so the URL cannot
    // reach the receipt or a refusal.
    //
    // GitHub is asked through the forge API instead, for the repository the identity bound:
    // the Git probe is pinned to plain `ssh`, which cannot reach a remote whose routing lives
    // in `core.sshCommand` (#248), and the API names the repository rather than a URL a
    // worktree's config could rewrite.
    const remoteAbsence = observed.identity.forge === "github"
        ? (await observeGithubBranch(observed.identity.nameWithOwner, receipt.branch.name, commit, env)).verdict
        : await remoteBranchAbsent(observed.identity.remoteUrl, receipt.branch.name, executionDir, commit);
    const issuedAt = nextReceiptEpoch(receipt, now);
    const verifiedAt = new Date(issuedAt).toISOString();
    const continued = buildReceipt({
        now: issuedAt,
        continues: receipt,
        emitter: { plugin: pkg.name, version: pkg.version, tool: "delivery_cleanup" },
        repo: receipt.repo,
        pr: {
            number: observed.pr.number,
            url: observed.pr.url,
            state: observed.pr.state,
            baseRefName: observed.pr.baseRefName,
            headRefName: observed.pr.headRefName,
            headRefOid: observed.pr.headRefOid,
            mergeCommitOid: observed.pr.mergeCommitOid,
            mergedAt: observed.pr.mergedAt,
        },
        branch: {
            name: receipt.branch.name,
            deletedRemote: remoteAbsence === "absent",
            remoteAbsenceVerifiedAt: remoteAbsence === "absent" ? verifiedAt : null,
            autoDeleteSetting: receipt.branch.autoDeleteSetting,
        },
        worktree: {
            path,
            removed: true,
            localRefDeleted: localAbsence === "absent",
            absenceVerifiedAt: verifiedAt,
        },
        beads: receipt.beads,
        proof: {
            // The same field means the same thing on every receipt: the provider CLI and
            // verb that observed this landing. What this call added — four independent
            // absence verdicts — is the evidence, and `emitter.tool` names who verified it.
            method: observed.pr.method,
            observedAt: verifiedAt,
            evidence: {
                worktreeRegistration: registration,
                worktreePath: pathGone,
                localRef: localAbsence,
                remoteBranch: remoteAbsence,
                pushed,
            },
        },
        outcome: "cleaned",
        notes: remoteAbsence === "absent" ? undefined : `remote branch absence observed ${remoteAbsence}`,
    });
    const validation = validateReceipt(continued);
    if (!validation.ok)
        return withRefusalNotes({ ok: false, reason: `continuation receipt: ${validation.reason}` }, afterNotes);
    let written;
    try {
        // Beside the receipt it continues: the directory resolveReceipt proved.
        written = writeReceipt(continued, dirname(resolution.path));
    }
    catch (error) {
        return withRefusalNotes(refuse("continuation receipt write", error instanceof Error ? error.message : String(error), "one persisted validated receipt"), afterNotes);
    }
    return {
        ok: true,
        receipt: continued,
        path: written,
        remoteBranchAbsence: remoteAbsence,
        alreadyCleaned: false,
        localRefDeleted: localRefPlan === "delete",
        report: withNotes(removalReport(receipt, path, identity.target, localRefPlan), afterNotes),
    };
}
