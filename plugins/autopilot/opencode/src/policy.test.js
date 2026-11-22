import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endsWithQuestion, grantedMergeAsk, holdsLane, identifyRoot, isAskTool, mergeDrift, mergeOutcome, mergeRefusal, mergeResource, mergeResponse, ownWorktreeAsk, recordableLane, reviewExportAsk, rootIntact } from "./policy.ts";
test.each([
    ["question", true],
    ["parley_ask", true],
    ["parley.wait", true],
    ["tools.parley_end", true],
    ["read", false],
    ["autopilot_log", false],
])("isAskTool(%p) is %p", (tool, expected) => {
    expect(isAskTool(tool)).toBe(expected);
});
test.each([
    ["explore", false],
    ["code-reviewer", false],
    ["researcher", false],
    ["coder", true],
    ["general", true],
    [undefined, true],
])("holdsLane(%p) is %p", (agent, expected) => {
    expect(holdsLane(agent)).toBe(expected);
});
test.each([
    ["Done. Should I also update the docs?", true],
    ["Plan:\n\nLet me know which one you prefer.", true],
    ["Closed the bead. What is left: nothing?\n\nMoving on to the next item.", false],
    ["", false],
])("endsWithQuestion(%p)", (text, expected) => {
    expect(endsWithQuestion(text)).toBe(expected);
});
// --- auto-allow of the run's own worktrees ---------------------------------------------------
let base;
let lane;
let alias;
let outside;
const canon = (path) => {
    try {
        return realpathSync(path);
    }
    catch {
        return undefined;
    }
};
beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-policy-")));
    lane = join(base, "lane");
    outside = join(base, "outside");
    alias = join(base, "alias");
    mkdirSync(lane);
    mkdirSync(`${lane}-x`);
    mkdirSync(outside);
    symlinkSync(outside, join(lane, "escape"));
    symlinkSync(lane, alias);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
const asks = (resources, over = {}) => ownWorktreeAsk({ action: over.action ?? "external_directory", effect: over.effect ?? "ask", resources, roots: over.roots ?? [lane], canon });
test.each([
    ["a recorded root", () => [`${lane}/*`], true],
    ["a symlink alias of a recorded root (the /local/home vs /home mismatch)", () => [`${alias}/*`], true],
    ["a sibling that only shares the prefix", () => [`${lane}-x/*`], false],
    ["a path under the root", () => [`${lane}/src/*`], false],
    ["a symlink inside the root that leads outside", () => [`${lane}/escape/*`], false],
    ["a root that is not recorded", () => [`${outside}/*`], false],
    ["a wildcard root", () => [`${base}/la*/*`], false],
    ["a single-character wildcard root", () => [`${base}/lan?/*`], false],
    ["a root with no trailing /*", () => [lane], false],
    ["a relative root", () => ["lane/*"], false],
    ["a root that does not exist", () => [`${base}/gone/*`], false],
    ["two resources when one is not recorded", () => [`${lane}/*`, `${outside}/*`], false],
    ["no resources", () => [], false],
])("external_directory ask for %s: allowed is %p", (_name, resources, expected) => {
    expect(asks(resources())).toBe(expected);
});
test.each(["allow", "deny"])("an external_directory %s effect is not touched", (effect) => {
    expect(asks([`${lane}/*`], { effect })).toBe(false);
});
test.each(["shell", "edit", "delivery_land", "read"])("a %s ask for a recorded root is not touched", (action) => {
    expect(asks([`${lane}/*`], { action })).toBe(false);
});
test("no recorded roots allows nothing", () => {
    expect(asks([`${lane}/*`], { roots: [] })).toBe(false);
});
// --- typed merge -----------------------------------------------------------------------------
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
test("mergeResource joins the PR and the SHA", () => {
    expect(mergeResource(12, SHA)).toBe(`12@${SHA}`);
});
test.each([
    ["merge granted", "autopilot_merge", "ask", [`12@${SHA}`], ["merge"], true],
    ["no grant", "autopilot_merge", "ask", [`12@${SHA}`], [], false],
    ["only deploy granted", "autopilot_merge", "ask", [`12@${SHA}`], ["deploy"], false],
    ["a malformed resource", "autopilot_merge", "ask", ["12@abc"], ["merge"], false],
    ["a shell merge", "shell", "ask", ["gh pr merge 12"], ["merge"], false],
    ["a rule that denies", "autopilot_merge", "deny", [`12@${SHA}`], ["merge"], false],
    ["two resources", "autopilot_merge", "ask", [`12@${SHA}`, `13@${SHA}`], ["merge"], false],
])("grantedMergeAsk with %s is %p", (_name, action, effect, resources, allow, expected) => {
    expect(grantedMergeAsk({ action, effect, resources, allow: [...allow] })).toBe(expected);
});
const view = (over = {}) => ({ state: "OPEN", headRefOid: SHA, baseRefName: "main", author: { login: "bot" }, ...over });
const reviews = [{ user: { login: "rev" }, state: "APPROVED", commit_id: SHA }];
const runs = [{ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }];
const status = { state: "success", statuses: [] };
const repo = { squashMergeAllowed: true, rebaseMergeAllowed: false, mergeCommitAllowed: true };
const refusal = (over = {}) => mergeRefusal({ sha: SHA, method: "squash", view: view(), reviews, runs, status, protection: { contexts: ["ci"] }, rules: [[]], repo, ...over });
test("mergeRefusal passes an approved, green, matching PR", () => {
    expect(refusal()).toBeUndefined();
});
test.each([
    ["the PR head moved (SHA mismatch)", { view: view({ headRefOid: OTHER }) }, "head"],
    ["an unreadable view", { view: undefined }, "head"],
    ["a merged PR", { view: view({ state: "MERGED" }) }, "state"],
    ["an approval for an older head", { reviews: [{ user: { login: "rev" }, state: "APPROVED", commit_id: OTHER }] }, "approval"],
    ["no reviews", { reviews: [] }, "approval"],
    ["the PR author approving their own PR", { reviews: [{ user: { login: "bot" }, state: "APPROVED", commit_id: SHA }] }, "approval"],
    ["an unreadable review list", { reviews: undefined }, "approval"],
    ["a failing check", { runs: [{ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }] }, "checks"],
    ["no checks", { runs: [{ check_runs: [] }] }, "checks"],
    ["a required check that never ran", { protection: { contexts: ["ci", "deploy"] } }, "deploy"],
    ["a ruleset context that never ran", { rules: [[{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "e2e" }] } }]] }, "e2e"],
    ["unreadable rulesets", { rules: undefined }, "unreadable"],
    ["unreadable branch protection", { protection: undefined }, "unreadable"],
    ["a merge queue on the base branch", { rules: [[{ type: "merge_queue", parameters: {} }]] }, "merge queues unsupported"],
    ["a method the repository does not allow", { method: "rebase" }, "method"],
    ["a method that is not one", { method: "fast-forward" }, "method"],
    ["unreadable repository settings", { repo: undefined }, "method"],
])("mergeRefusal refuses %s", (_name, over, word) => {
    expect(refusal(over)).toContain(word);
});
test("a verdict comment by the author is not an approval", () => {
    const withComment = { ...view(), comments: [{ author: { login: "bot" }, body: `VERDICT: APPROVE\n${SHA}` }] };
    expect(refusal({ view: withComment, reviews: [] })).toContain("approval");
});
describe("a witnessed review in place of the GitHub approval", () => {
    const noApproval = { reviews: [] };
    test("is accepted when the grant is set and the record approves exactly the merged head", () => {
        expect(refusal({ ...noApproval, witnessed: { granted: true, approvedSha: SHA } })).toBeUndefined();
    });
    test.each([
        ["no grant", { granted: false, approvedSha: SHA }],
        ["no record", { granted: true, approvedSha: undefined }],
        ["a record for another head", { granted: true, approvedSha: OTHER }],
        ["no witness input", undefined],
    ])("is refused with %s", (_name, witnessed) => {
        expect(refusal({ ...noApproval, ...(witnessed ? { witnessed } : {}) })).toContain("approval");
    });
    test.each([
        ["a failing check", { runs: [{ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }] }, "checks"],
        ["a missing required context", { protection: { contexts: ["ci", "deploy"] } }, "deploy"],
        ["a moved head", { view: view({ headRefOid: OTHER }) }, "head"],
        ["a merged PR", { view: view({ state: "MERGED" }) }, "state"],
        ["a merge queue", { rules: [[{ type: "merge_queue", parameters: {} }]] }, "merge queues unsupported"],
        ["a method the repository does not allow", { method: "rebase" }, "method"],
    ])("still applies %s", (_name, over, word) => {
        expect(refusal({ ...noApproval, ...over, witnessed: { granted: true, approvedSha: SHA } })).toContain(word);
    });
});
test("mergeRefusal refuses a SHA that is not 40 hex digits", () => {
    expect(refusal({ sha: "abc", view: view({ headRefOid: "abc" }) })).toContain("sha");
});
// --- root identity and lane recording --------------------------------------------------------
const probe = (table) => (path) => {
    const entry = table[path];
    return entry === undefined ? undefined : { isDirectory: entry.dir ?? true, isSymbolicLink: entry.link ?? false, dev: entry.dev ?? "1", ino: entry.ino ?? "10" };
};
const real = (map) => (path) => map[path];
test("identifyRoot records the real path with dev and ino of a plain directory", () => {
    expect(identifyRoot("/w/a", probe({ "/w/a": {} }), real({ "/w/a": "/real/a" }))).toEqual({ path: "/w/a", real: "/real/a", dev: "1", ino: "10" });
});
test.each([
    ["a symlink", { "/w/a": { link: true } }],
    ["a file", { "/w/a": { dir: false } }],
    ["a path that does not exist", {}],
])("identifyRoot refuses %s", (_name, table) => {
    expect(identifyRoot("/w/a", probe(table), real({ "/w/a": "/real/a" }))).toBeUndefined();
});
describe("rootIntact", () => {
    const recorded = { path: "/w/a", real: "/real/a", dev: "1", ino: "10" };
    const canonical = real({ "/w/a": "/real/a" });
    test.each([
        ["the same directory", { "/w/a": {} }, canonical, true],
        ["removed", {}, canonical, false],
        ["replaced by a symlink", { "/w/a": { link: true } }, real({ "/w/a": "/elsewhere" }), false],
        ["replaced by a symlink to the same place", { "/w/a": { link: true } }, canonical, false],
        ["recreated with another inode", { "/w/a": { ino: "11" } }, canonical, false],
        ["on another device", { "/w/a": { dev: "2" } }, canonical, false],
        ["resolving elsewhere", { "/w/a": {} }, real({ "/w/a": "/real/b" }), false],
        ["replaced by a file", { "/w/a": { dir: false } }, canonical, false],
    ])("%s", (_name, table, canon, expected) => {
        expect(rootIntact(recorded, probe(table), canon)).toBe(expected);
    });
});
describe("recordableLane", () => {
    const base = { agent: "coder", directory: "/w/a", listed: new Set(["/real/a", "/real/main"]), primary: new Set(["/real/main"]), canon: real({ "/w/a": "/real/a", "/w/main": "/real/main", "/w/gone": "/real/gone" }), linked: (dir) => dir !== "/w/main" };
    test("a writer in a listed, linked, non-primary worktree is recorded", () => {
        expect(recordableLane(base)).toBe(true);
    });
    test.each(["explore", "researcher", "code-reviewer", "pr-reviewer", "security-reviewer", "debug", "operator", "plan"])("a %s lane is not recorded", (agent) => {
        expect(recordableLane({ ...base, agent })).toBe(false);
    });
    test("the primary checkout is not recorded, even though the project lists it", () => {
        expect(recordableLane({ ...base, directory: "/w/main" })).toBe(false);
    });
    test("a directory the project does not list is not recorded", () => {
        expect(recordableLane({ ...base, directory: "/w/gone" })).toBe(false);
    });
    test("a directory without a linked-worktree marker is not recorded", () => {
        expect(recordableLane({ ...base, linked: () => false })).toBe(false);
    });
});
// --- what happened after gh pr merge ---------------------------------------------------------
describe("mergeOutcome", () => {
    const after = (over = {}) => ({ state: "MERGED", headRefOid: SHA, mergeCommit: { oid: "f".repeat(40) }, autoMergeRequest: null, ...over });
    test("a merged PR at the reviewed head with a merge commit is success", () => {
        expect(mergeOutcome(after(), SHA)).toEqual({ ok: true });
    });
    test.each([
        ["the PR is still open with an auto-merge request", after({ state: "OPEN", mergeCommit: null, autoMergeRequest: { enabledAt: "now" } })],
        ["the PR is still open", after({ state: "OPEN", mergeCommit: null })],
        ["the PR is merged but auto-merge is still recorded", after({ autoMergeRequest: { enabledAt: "now" } })],
        ["the PR merged at another head", after({ headRefOid: OTHER })],
        ["the PR merged without a merge commit", after({ mergeCommit: null })],
        ["the PR cannot be read", undefined],
    ])("refuses when %s", (_name, view) => {
        expect(mergeOutcome(view, SHA)).toEqual({ ok: false, reason: expect.any(String) });
    });
});
describe("mergeDrift (the re-read just before the PUT)", () => {
    const now = (over = {}) => ({ baseRefName: "main", headRefOid: SHA, ...over });
    test("the same base and head is no drift", () => {
        expect(mergeDrift({ view: now(), base: "main", sha: SHA })).toBeUndefined();
    });
    test.each([
        ["the PR was retargeted", now({ baseRefName: "release" }), "base"],
        ["the head moved", now({ headRefOid: OTHER }), "head"],
        ["the read failed", undefined, "unreadable"],
    ])("refuses when %s", (_name, view, word) => {
        expect(mergeDrift({ view, base: "main", sha: SHA })).toContain(word);
    });
});
describe("mergeResponse (gh api -X PUT .../merge)", () => {
    const MERGE = "f".repeat(40);
    const reply = (ok, stdout, stderr = "") => ({ ok, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr });
    test("merged true with a sha is success", () => {
        expect(mergeResponse(reply(true, { merged: true, sha: MERGE, message: "Pull Request successfully merged" }))).toEqual({ ok: true, sha: MERGE });
    });
    test.each([
        ["a 405 for a queue-required or protected branch", reply(false, { message: "Merge queue required" }, "gh: Merge queue required (HTTP 405)"), "405"],
        ["a 409 for a head mismatch", reply(false, { message: "Head branch was modified" }, "gh: Head branch was modified (HTTP 409)"), "409"],
        ["a 2xx without merged true", reply(true, { merged: false, message: "Queued" }), "merged"],
        ["a 2xx without a sha", reply(true, { merged: true }), "sha"],
        ["a 2xx that is not JSON", reply(true, "ok"), "unreadable"],
        ["a failure with no status", reply(false, "", "network down"), "network down"],
    ])("refuses %s", (_name, result, word) => {
        expect(mergeResponse(result)).toMatchObject({ ok: false, reason: expect.stringContaining(word) });
    });
    test("a non-2xx refusal carries the status and the message", () => {
        expect(mergeResponse(reply(false, { message: "Merge queue required" }, "gh: Merge queue required (HTTP 405)"))).toEqual({ ok: false, reason: "merge refused by GitHub (HTTP 405): Merge queue required" });
    });
});
// --- read access to the exported review directory ----------------------------------------------
describe("reviewExportAsk", () => {
    let review;
    beforeAll(() => {
        review = join(base, "run", "review");
        mkdirSync(join(review, "abc", "files", "src"), { recursive: true });
        symlinkSync(outside, join(review, "abc", "escape"));
        symlinkSync(review, join(base, "review-alias"));
    });
    const reviewAsk = (resources, over = {}) => reviewExportAsk({ action: over.action ?? "external_directory", effect: over.effect ?? "ask", resources, root: "root" in over ? over.root : review, canon });
    test.each([
        ["the review directory", () => [`${review}/*`], true],
        ["an exported directory", () => [`${review}/abc/files/src/*`], true],
        ["a symlink alias of the review directory", () => [`${join(base, "review-alias")}/*`], true],
        ["a sibling that only shares the prefix", () => [`${review}-x/*`], false],
        ["the run directory above it", () => [`${join(base, "run")}/*`], false],
        ["a `..` climb out of it", () => [`${review}/abc/../../*`], false],
        ["a symlink inside it that leads outside", () => [`${review}/abc/escape/*`], false],
        ["a wildcard in the directory", () => [`${review}/a*/*`], false],
        ["a single-character wildcard", () => [`${review}/ab?/*`], false],
        ["no trailing /*", () => [review], false],
        ["a relative directory", () => ["review/*"], false],
        ["a directory that does not exist", () => [`${review}/gone/*`], false],
        ["two resources when one is outside", () => [`${review}/*`, `${outside}/*`], false],
        ["no resources", () => [], false],
    ])("external_directory ask for %s: allowed is %p", (_name, resources, expected) => {
        expect(reviewAsk(resources())).toBe(expected);
    });
    test.each(["allow", "deny"])("an external_directory %s effect is not touched", (effect) => {
        expect(reviewAsk([`${review}/*`], { effect })).toBe(false);
    });
    test.each(["shell", "edit", "autopilot_merge", "read"])("a %s ask for the review directory is not touched", (action) => {
        expect(reviewAsk([`${review}/*`], { action })).toBe(false);
    });
    test("a run with no usable review directory allows nothing", () => {
        expect(reviewAsk([`${review}/*`], { root: undefined })).toBe(false);
    });
});
