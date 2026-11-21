import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { endsWithQuestion, grantedMergeAsk, holdsLane, identifyRoot, isAskTool, mergeOutcome, mergeRefusal, mergeResource, ownWorktreeAsk, recordableLane, rootIntact } from "./policy.ts"

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

const view = (over: Record<string, unknown> = {}) => ({ state: "OPEN", headRefOid: SHA, baseRefName: "main", author: { login: "bot" }, ...over })
const reviews = [{ user: { login: "rev" }, state: "APPROVED", commit_id: SHA }]
const runs = [{ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }]
const status = { state: "success", statuses: [] }
const repo = { squashMergeAllowed: true, rebaseMergeAllowed: false, mergeCommitAllowed: true }
type Input = Parameters<typeof mergeRefusal>[0]
const refusal = (over: Partial<Input> = {}) => mergeRefusal({ sha: SHA, method: "squash", view: view(), reviews, runs, status, protection: { contexts: ["ci"] }, rules: [[]], repo, ...over })

test("mergeRefusal passes an approved, green, matching PR", () => {
  expect(refusal()).toBeUndefined()
})

test.each<[string, Partial<Input>, string]>([
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
  expect(refusal(over)).toContain(word)
})

test("a verdict comment by the author is not an approval", () => {
  const withComment = { ...view(), comments: [{ author: { login: "bot" }, body: `VERDICT: APPROVE\n${SHA}` }] }
  expect(refusal({ view: withComment, reviews: [] })).toContain("approval")
})

test("mergeRefusal refuses a SHA that is not 40 hex digits", () => {
  expect(refusal({ sha: "abc", view: view({ headRefOid: "abc" }) })).toContain("sha")
})

// --- root identity and lane recording --------------------------------------------------------

const probe =
  (table: Record<string, { dir?: boolean; link?: boolean; dev?: string; ino?: string }>) =>
  (path: string) => {
    const entry = table[path]
    return entry === undefined ? undefined : { isDirectory: entry.dir ?? true, isSymbolicLink: entry.link ?? false, dev: entry.dev ?? "1", ino: entry.ino ?? "10" }
  }
const real = (map: Record<string, string>) => (path: string) => map[path]

test("identifyRoot records the real path with dev and ino of a plain directory", () => {
  expect(identifyRoot("/w/a", probe({ "/w/a": {} }), real({ "/w/a": "/real/a" }))).toEqual({ path: "/w/a", real: "/real/a", dev: "1", ino: "10" })
})

test.each([
  ["a symlink", { "/w/a": { link: true } }],
  ["a file", { "/w/a": { dir: false } }],
  ["a path that does not exist", {}],
])("identifyRoot refuses %s", (_name, table) => {
  expect(identifyRoot("/w/a", probe(table), real({ "/w/a": "/real/a" }))).toBeUndefined()
})

describe("rootIntact", () => {
  const recorded = { path: "/w/a", real: "/real/a", dev: "1", ino: "10" }
  const canonical = real({ "/w/a": "/real/a" })
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
    expect(rootIntact(recorded, probe(table), canon)).toBe(expected)
  })
})

describe("recordableLane", () => {
  const base = { agent: "coder", directory: "/w/a", listed: new Set(["/real/a", "/real/main"]), primary: new Set(["/real/main"]), canon: real({ "/w/a": "/real/a", "/w/main": "/real/main", "/w/gone": "/real/gone" }), linked: (dir: string) => dir !== "/w/main" }
  test("a writer in a listed, linked, non-primary worktree is recorded", () => {
    expect(recordableLane(base)).toBe(true)
  })
  test.each(["explore", "researcher", "code-reviewer", "pr-reviewer", "security-reviewer", "debug", "operator", "plan"])("a %s lane is not recorded", (agent) => {
    expect(recordableLane({ ...base, agent })).toBe(false)
  })
  test("the primary checkout is not recorded, even though the project lists it", () => {
    expect(recordableLane({ ...base, directory: "/w/main" })).toBe(false)
  })
  test("a directory the project does not list is not recorded", () => {
    expect(recordableLane({ ...base, directory: "/w/gone" })).toBe(false)
  })
  test("a directory without a linked-worktree marker is not recorded", () => {
    expect(recordableLane({ ...base, linked: () => false })).toBe(false)
  })
})

// --- what happened after gh pr merge ---------------------------------------------------------

describe("mergeOutcome", () => {
  const after = (over: Record<string, unknown> = {}) => ({ state: "MERGED", headRefOid: SHA, mergeCommit: { oid: "f".repeat(40) }, autoMergeRequest: null, ...over })
  test("a merged PR at the reviewed head with a merge commit is success", () => {
    expect(mergeOutcome(after(), SHA)).toEqual({ ok: true })
  })
  test.each<[string, unknown, boolean]>([
    ["auto-merge was enabled and the PR is still open", after({ state: "OPEN", mergeCommit: null, autoMergeRequest: { enabledAt: "now" } }), true],
    ["the PR is still open without auto-merge (a queue or a silent no-op)", after({ state: "OPEN", mergeCommit: null }), true],
    ["the PR is merged but auto-merge is still recorded", after({ autoMergeRequest: { enabledAt: "now" } }), true],
    ["the PR merged at another head", after({ headRefOid: OTHER }), false],
    ["the PR merged without a merge commit", after({ mergeCommit: null }), false],
    ["the PR cannot be read", undefined, true],
  ])("refuses when %s (disable auto-merge: %p)", (_name, view, disableAuto) => {
    expect(mergeOutcome(view, SHA)).toMatchObject({ ok: false, disableAuto, reason: expect.any(String) })
  })
})
