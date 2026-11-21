import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { endsWithQuestion, grantedMergeAsk, holdsLane, isAskTool, mergeMethodFlag, mergeRefusal, mergeResource, ownWorktreeAsk } from "./policy.ts"

// --- auto-allow of the run's own worktrees ---------------------------------------------------

let base: string
let lane: string
let alias: string
let outside: string
const canon = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-policy-")))
  lane = join(base, "lane")
  outside = join(base, "outside")
  alias = join(base, "alias")
  mkdirSync(lane)
  mkdirSync(`${lane}-x`)
  mkdirSync(outside)
  symlinkSync(outside, join(lane, "escape"))
  symlinkSync(lane, alias)
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

const asks = (resources: string[], over: { action?: string; effect?: "allow" | "deny" | "ask"; roots?: string[] } = {}) =>
  ownWorktreeAsk({ action: over.action ?? "external_directory", effect: over.effect ?? "ask", resources, roots: over.roots ?? [lane], canon })

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
  expect(asks(resources())).toBe(expected)
})

test.each(["allow", "deny"] as const)("an external_directory %s effect is not touched", (effect) => {
  expect(asks([`${lane}/*`], { effect })).toBe(false)
})

test.each(["shell", "edit", "delivery_land", "read"])("a %s ask for a recorded root is not touched", (action) => {
  expect(asks([`${lane}/*`], { action })).toBe(false)
})

test("no recorded roots allows nothing", () => {
  expect(asks([`${lane}/*`], { roots: [] })).toBe(false)
})

// --- typed merge -----------------------------------------------------------------------------

const SHA = "a".repeat(40)
const OTHER = "b".repeat(40)

test("mergeResource joins the PR and the SHA", () => {
  expect(mergeResource(12, SHA)).toBe(`12@${SHA}`)
})

test.each([
  ["merge granted", "autopilot_merge", "ask", [`12@${SHA}`], ["merge"], true],
  ["no grant", "autopilot_merge", "ask", [`12@${SHA}`], [], false],
  ["only deploy granted", "autopilot_merge", "ask", [`12@${SHA}`], ["deploy"], false],
  ["a malformed resource", "autopilot_merge", "ask", ["12@abc"], ["merge"], false],
  ["a shell merge", "shell", "ask", ["gh pr merge 12"], ["merge"], false],
  ["a rule that denies", "autopilot_merge", "deny", [`12@${SHA}`], ["merge"], false],
  ["two resources", "autopilot_merge", "ask", [`12@${SHA}`, `13@${SHA}`], ["merge"], false],
] as const)("grantedMergeAsk with %s is %p", (_name, action, effect, resources, allow, expected) => {
  expect(grantedMergeAsk({ action, effect, resources, allow: [...allow] })).toBe(expected)
})

const view = (over: Record<string, unknown> = {}) => ({
  state: "OPEN",
  headRefOid: SHA,
  author: { login: "bot" },
  reviews: [{ state: "APPROVED", commit: { oid: SHA }, author: { login: "rev" } }],
  comments: [],
  ...over,
})
const green = [{ name: "ci", bucket: "pass", state: "SUCCESS" }]

test("mergeRefusal passes an approved, green, matching PR", () => {
  expect(mergeRefusal({ sha: SHA, view: view(), checks: green })).toBeUndefined()
})

test("mergeRefusal accepts the author's VERDICT: APPROVE comment naming the head", () => {
  const comment = { author: { login: "bot" }, body: `VERDICT: APPROVE\nhead ${SHA}` }
  expect(mergeRefusal({ sha: SHA, view: view({ reviews: [], comments: [comment] }), checks: green })).toBeUndefined()
})

test.each([
  ["the PR head moved (SHA mismatch)", () => view({ headRefOid: OTHER }), green, "head"],
  ["the approval is for an older head", () => view({ reviews: [{ state: "APPROVED", commit: { oid: OTHER } }] }), green, "approval"],
  ["no approval at all", () => view({ reviews: [] }), green, "approval"],
  ["a changes-requested review", () => view({ reviews: [{ state: "CHANGES_REQUESTED", commit: { oid: SHA } }] }), green, "approval"],
  ["a verdict comment by someone else", () => view({ reviews: [], comments: [{ author: { login: "x" }, body: `VERDICT: APPROVE ${SHA}` }] }), green, "approval"],
  ["a verdict comment that does not name the head", () => view({ reviews: [], comments: [{ author: { login: "bot" }, body: "VERDICT: APPROVE" }] }), green, "approval"],
  ["a merged PR", () => view({ state: "MERGED" }), green, "state"],
  ["a failing check", () => view(), [{ name: "ci", bucket: "fail" }], "checks"],
  ["a pending check", () => view(), [{ name: "ci", bucket: "pending" }], "checks"],
  ["no checks", () => view(), [], "checks"],
  ["an unreadable check list", () => view(), undefined, "checks"],
  ["an unreadable view", () => undefined, green, "head"],
])("mergeRefusal refuses %s", (_name, make, checks, word) => {
  expect(mergeRefusal({ sha: SHA, view: make(), checks })).toContain(word)
})

test("mergeRefusal refuses a SHA that is not 40 hex digits", () => {
  expect(mergeRefusal({ sha: "abc", view: view({ headRefOid: "abc" }), checks: green })).toContain("sha")
})

test.each<[unknown, "--squash" | "--rebase" | "--merge" | undefined]>([
  [{ squashMergeAllowed: true, rebaseMergeAllowed: true, mergeCommitAllowed: true }, "--squash"],
  [{ squashMergeAllowed: false, rebaseMergeAllowed: true, mergeCommitAllowed: true }, "--rebase"],
  [{ squashMergeAllowed: false, rebaseMergeAllowed: false, mergeCommitAllowed: true }, "--merge"],
  [{ squashMergeAllowed: false, rebaseMergeAllowed: false, mergeCommitAllowed: false }, undefined],
  [undefined, undefined],
])("mergeMethodFlag(%p) is %p", (repo, expected) => {
  expect(mergeMethodFlag(repo)).toBe(expected)
})

test.each([
  ["question", true],
  ["parley_ask", true],
  ["parley.wait", true],
  ["tools.parley_end", true],
  ["read", false],
  ["autopilot_log", false],
])("isAskTool(%p) is %p", (tool, expected) => {
  expect(isAskTool(tool)).toBe(expected)
})

test.each([
  ["explore", false],
  ["code-reviewer", false],
  ["researcher", false],
  ["coder", true],
  ["general", true],
  [undefined, true],
])("holdsLane(%p) is %p", (agent, expected) => {
  expect(holdsLane(agent)).toBe(expected)
})

test.each([
  ["Done. Should I also update the docs?", true],
  ["Plan:\n\nLet me know which one you prefer.", true],
  ["Closed the bead. What is left: nothing?\n\nMoving on to the next item.", false],
  ["", false],
])("endsWithQuestion(%p)", (text, expected) => {
  expect(endsWithQuestion(text)).toBe(expected)
})
