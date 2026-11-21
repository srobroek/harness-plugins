import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext, type FakeContext } from "@srobroek/opencode-lib/testing"
import { DENY_QUESTION, HANDOFF_LABEL, MAX_REPROMPTS, REPROMPT, setupAutopilot, type WriteLock } from "./index.ts"
import type { Run } from "./rundir.ts"
import { type Clock, Ticks } from "./timer.ts"

const NOW = new Date(2026, 10, 20, 14, 0).getTime()

type Call = { command: string; args: string[] }

let root: string
let fake: FakeContext
let cleanup: (() => Promise<void>) | undefined
let calls: Call[]
let locked: string[]
let warnings: string[]
const warn = (message: string) => void warnings.push(message)
let beads: { list: unknown[]; ready: unknown[]; blocked: unknown[] }
/** While set, `bd list` waits for it: a test holds a run's critical section open with it. */
let listGate: Promise<void> | undefined
/** Called on each `git rev-parse`, the last host call `/autopilot` makes before it takes the run lock. */
let onRevParse: (() => void) | undefined
/** How many `bd create` calls fail before one succeeds. */
let failCreates = 0
/** How many handoff lookups (`bd list --label ...`) fail before one succeeds. */
let failLookups = 0
/** When set, what a handoff lookup prints instead of the bead list. */
let lookupStdout: string | undefined
/** Called after a `bd create` succeeds. */
let onCreated: (() => void) | undefined
/** What `gh <a> <b>` prints, by "a b". */
let ghReplies: Record<string, { ok: boolean; stdout: string; stderr: string }>

const run: Run = async (_cwd, command, args) => {
  calls.push({ command, args })
  const json = (value: unknown) => ({ ok: true, stdout: JSON.stringify(value), stderr: "" })
  if (command === "gh") {
    const line = args.join(" ")
    const key = Object.keys(ghReplies).find((candidate) => line.includes(candidate))
    return (key === undefined ? undefined : ghReplies[key]) ?? { ok: true, stdout: "", stderr: "" }
  }
  if (command === "git" && args[0] === "rev-parse") {
    onRevParse?.()
    return { ok: true, stdout: `${root}\n`, stderr: "" }
  }
  if (command === "git") return { ok: true, stdout: "7\n", stderr: "" }
  if (args[0] === "list" && args.includes("--label")) {
    if (failLookups > 0) {
      failLookups--
      return { ok: false, stdout: "", stderr: "store locked" }
    }
    if (lookupStdout !== undefined) return { ok: true, stdout: lookupStdout, stderr: "" }
    return json(beads.list)
  }
  if (args[0] === "list") {
    await listGate
    return json(beads.list)
  }
  if (args[0] === "ready") return json(beads.ready)
  if (args[0] === "blocked") return json(beads.blocked)
  if (args[0] === "create") {
    if (failCreates > 0) {
      failCreates--
      return { ok: false, stdout: "", stderr: "store busy" }
    }
    beads.list.push({ id: "t-99", status: "open", title: args[1], labels: [args[args.indexOf("--labels") + 1]] })
    onCreated?.()
    return json({ id: "t-99" })
  }
  return json({})
}

const lock: WriteLock = async (_cwd, owner, write) => {
  locked.push(owner)
  return { kind: "done", value: await write() }
}

const lead = (time: Record<string, number> = { busy: NOW - 60_000, idle: NOW - 30_000 }) => ({ id: "ses_lead", location: { directory: "/repo" }, time })

async function start(storage?: Record<string, unknown>) {
  fake = createFakeContext({
    directory: "/repo",
    projectID: "prj_test",
    storage,
    sessions: [lead(), { id: "ses_child", parentID: "ses_lead", agent: "coder", time: {} }, { id: "ses_grand", parentID: "ses_child", time: {} }, { id: "ses_other", time: {} }],
  })
  cleanup = await setupAutopilot(fake.context, { run, now: () => NOW, lock, warn })
}

async function command(text: string, sessionID = "ses_lead"): Promise<string> {
  const before = fake.calls.length
  await fake.commands.get("autopilot")?.execute({ sessionID, prompt: { text }, delivery: "queue" } as never)
  const sent = fake.calls.slice(before).find((call) => call.method === "session.prompt")
  return (sent?.input as { text: string } | undefined)?.text ?? ""
}

async function status(input: Record<string, unknown>, sessionID = "ses_lead"): Promise<Record<string, unknown>> {
  const tool = fake.tools.get("autopilot_status") as unknown as { execute: (input: unknown, context: unknown) => Promise<{ output: Record<string, unknown> }> }
  return (await tool.execute(input, { sessionID })).output
}

async function log(input: Record<string, unknown>, sessionID = "ses_lead"): Promise<string> {
  const tool = fake.tools.get("autopilot_log") as unknown as { execute: (input: unknown, context: unknown) => Promise<{ content: string }> }
  return (await tool.execute(input, { sessionID })).content
}

async function denied(tool: string, sessionID: string): Promise<string | undefined> {
  try {
    await fake.fire.tool("execute.before", { tool, sessionID, input: {} })
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

async function armed(setup: Record<string, unknown> = {}) {
  await command("--for 2h")
  return status({ action: "arm", setup: { scope: "p-1", full: false, allow: [], lanes: 3, until: "", ...setup } })
}

/** Resolves with the input of the next `session.<method>` call the plugin makes. */
function whenCalled(method: "prompt" | "synthetic" | "get"): Promise<unknown> {
  const session = fake.context.session as unknown as Record<string, (input: unknown) => Promise<unknown>>
  const original = session[method] as (input: unknown) => Promise<unknown>
  return new Promise((resolve) => {
    session[method] = async (input) => {
      session[method] = original
      const output = await original(input)
      resolve(input)
      return output
    }
  })
}

/** Settles every pending promise step, without waiting on a timer. */
async function settle(steps = 200): Promise<void> {
  for (let step = 0; step < steps; step++) await Promise.resolve()
}

const latestState = () => JSON.parse(readFileSync(join(latest(), "state.json"), "utf8")) as { phase: string; generation?: number; runId: string; sessionID: string; tick: { token?: string } }

/** A tick as the run's current automation sends it: with the token and session it is bound to. */
function tickInput(): Record<string, unknown> {
  const state = latestState()
  return { action: "tick", run: state.runId, token: state.tick.token, session: state.sessionID }
}

const latest = () => join(root, "opencode-scratch", "autopilot", "latest")

const journal = () =>
  readFileSync(join(latest(), "journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; summary: string })

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "autopilot-test-"))
  calls = []
  ghReplies = {}
  locked = []
  failLookups = 0
  lookupStdout = undefined
  onCreated = undefined
  warnings = []
  failCreates = 0
  beads = { list: [{ id: "p-1", status: "open" }], ready: [{ id: "p-1" }], blocked: [] }
  await start()
})

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  fake.closeEvents()
  rmSync(root, { recursive: true, force: true })
})

describe("/autopilot", () => {
  test("starts a run in setup and asks for every value the command line left out", async () => {
    const prompt = await command("--for 2h")
    expect(prompt).toContain("Still to ask: scope, full, allow, lanes, until.")
    const state = JSON.parse(readFileSync(join(latest(), "state.json"), "utf8")) as { phase: string; sessionID: string }
    expect(state).toMatchObject({ phase: "setup", sessionID: "ses_lead" })
  })

  test("the setup round may ask; an armed run may not, in the lead or any descendant", async () => {
    await command("")
    expect(await denied("parley_ask", "ses_lead")).toBeUndefined()
    await status({ action: "arm", setup: { scope: "p-1", lanes: 3 } })
    expect(await denied("question", "ses_lead")).toBe(DENY_QUESTION)
    expect(await denied("parley_wait", "ses_grand")).toBe(DENY_QUESTION)
    expect(await denied("question", "ses_other")).toBeUndefined()
    expect(await denied("read", "ses_lead")).toBeUndefined()
  })

  test("arming returns the 4-minute tick automation for this run", async () => {
    const result = await armed()
    expect(result.automation).toMatchObject({ trigger: { type: "every", every: "4 minutes" }, action: { type: "code" }, expires: new Date(NOW + 2 * 3_600_000 + 60_000).toISOString() })
    expect(journal().map((entry) => entry.type)).toEqual(["action"])
  })
})

describe("tick", () => {
  test("skips while the lead session executes", async () => {
    await armed()
    fake.sessions.set("ses_lead", lead({ busy: NOW - 1_000, idle: NOW - 60_000 }))
    expect(await status(tickInput())).toEqual({ skip: "lead session busy" })
  })

  test("sends the ping when the lead is idle, counting the busy writer lane", async () => {
    await armed()
    fake.sessions.set("ses_child", { id: "ses_child", parentID: "ses_lead", agent: "coder", time: { busy: NOW - 1_000 } })
    const result = await status(tickInput())
    expect(result.prompt).toBe("Autopilot tick. Post this ping verbatim, then continue:\n♥ 14:00 · 1/3 lanes · ready 1 · blocked 0 · parked 0 · 2h00m left\nNo actions due; keep working.")
  })

  test("counts a busy writer lane past the first page of children", async () => {
    await armed()
    for (let index = 0; index < 120; index++) fake.sessions.set(`ses_k${index}`, { id: `ses_k${index}`, parentID: "ses_lead", agent: "explore", time: { updated: 1_000 + index } })
    fake.sessions.set("ses_child", { id: "ses_child", parentID: "ses_lead", agent: "coder", time: { busy: NOW - 1_000, updated: 1 } })
    const result = await status(tickInput())
    expect(result.prompt).toContain("· 1/3 lanes ·")
  })

  test("ends the automation with a stop prompt when the scope is finished", async () => {
    await armed()
    beads = { list: [{ id: "p-1", status: "closed" }], ready: [], blocked: [] }
    expect(await status(tickInput())).toMatchObject({ done: true, stop: "scope finished" })
  })
})

describe("permission asks while armed", () => {
  const ask = (resource: string, sessionID = "ses_child", action = "shell", effect = "ask") =>
    fake.fire.permission("evaluate", { sessionID, action, resources: [resource], effect, message: undefined as string | undefined })

  const everything = { allow: ["merge", "deploy"], full: true }

  // [permission kind, the command or pattern it asks about]
  test.each([
    ["shell", "git status"],
    ["shell", "npm test"],
    ["shell", "gh pr merge 12 --squash"],
    ["edit", "src/index.ts"],
    ["external_directory", "/tmp/elsewhere/*"],
    ["delivery_land", "12"],
    ["safety_secret_command", "deploy-token"],
  ])("denies a %s ask for %p even with every grant, and journals a blocker naming both", async (action, resource) => {
    await armed(everything)
    expect(await ask(resource, "ses_child", action)).toMatchObject({ effect: "deny", message: expect.stringContaining("never approves") })
    expect(journal().at(-1)).toMatchObject({ type: "blocker", summary: expect.stringContaining(action), evidence: resource })
  })

  test("leaves rules the user already decided alone", async () => {
    await armed(everything)
    expect((await ask("git status", "ses_child", "shell", "allow")).effect).toBe("allow")
    expect((await ask("rm -rf /", "ses_child", "shell", "deny")).effect).toBe("deny")
    expect(journal().map((entry) => entry.type)).toEqual(["action"])
  })

  test("leaves sessions outside a run alone", async () => {
    await armed()
    expect((await ask("git push origin main", "ses_other")).effect).toBe("ask")
  })

  test("denies every ask while the run is stopping", async () => {
    await armed()
    failCreates = 1
    await status({ action: "stop", reason: "done" })
    expect(latestState().phase).toBe("stopping")
    expect((await ask("git status")).effect).toBe("deny")
  })
})

describe("a run's own worktrees", () => {
  let wt: string
  const ask = (resource: string, action = "external_directory", sessionID = "ses_child") =>
    fake.fire.permission("evaluate", { sessionID, action, resources: [resource], effect: "ask", message: undefined as string | undefined })
  const confirm = (...dirs: string[]) => {
    ;(fake.context as unknown as { worktree: { list: () => Promise<unknown> } }).worktree.list = async () => dirs.map((directory) => ({ directory }))
  }
  const lane = (directory: string, agent = "coder") => fake.sessions.set("ses_child", { id: "ses_child", parentID: "ses_lead", agent, location: { directory }, time: { busy: NOW - 1_000 } })
  const observe = async (directory: string, agent = "coder") => {
    lane(directory, agent)
    await status(tickInput())
  }
  const recorded = () => (latestState() as unknown as { worktrees?: { path: string; real: string; dev: string; ino: string }[] }).worktrees ?? []
  const newWorktree = (name: string) => {
    const dir = realpathSync(mkdtempSync(join(root, `${name}-`)))
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n")
    return dir
  }

  beforeEach(() => {
    wt = newWorktree("lane")
  })

  test("allows <root>/* of a lane the run observed and the project lists, without a blocker", async () => {
    await armed()
    confirm(wt)
    await observe(wt)
    expect(await ask(`${wt}/*`)).toMatchObject({ effect: "allow" })
    expect(journal().map((entry) => entry.type)).toEqual(["action"])
  })

  test("records the real path with the device and inode", async () => {
    await armed()
    confirm(wt)
    await observe(wt)
    expect(recorded()).toEqual([{ path: wt, real: wt, dev: expect.any(String), ino: expect.any(String) }])
  })

  test("denies the same ask before the lane is observed", async () => {
    await armed()
    confirm(wt)
    expect(await ask(`${wt}/*`)).toMatchObject({ effect: "deny" })
  })

  test("does not record a lane the project does not list", async () => {
    await armed()
    confirm()
    await observe(wt)
    expect(recorded()).toEqual([])
  })

  test("denies the ask when the project stops listing the worktree", async () => {
    await armed()
    confirm(wt)
    await observe(wt)
    confirm()
    expect(await ask(`${wt}/*`)).toMatchObject({ effect: "deny" })
  })

  test.each(["explore", "researcher", "code-reviewer", "debug"])("does not record a %s lane", async (agent) => {
    await armed()
    confirm(wt)
    await observe(wt, agent)
    expect(recorded()).toEqual([])
  })

  test("does not record a directory without the linked-worktree marker", async () => {
    await armed()
    const plain = realpathSync(mkdtempSync(join(root, "plain-")))
    confirm(plain)
    await observe(plain)
    expect(recorded()).toEqual([])
  })

  test("does not record the project's primary checkout", async () => {
    await armed()
    const primary = newWorktree("primary")
    ;(fake.context as unknown as { location: { project: { directory: string; canonical: string } } }).location.project = { directory: primary, canonical: primary } as never
    confirm(primary)
    await observe(primary)
    expect(recorded()).toEqual([])
  })

  test("denies a sibling of a recorded root", async () => {
    await armed()
    confirm(wt)
    await observe(wt)
    expect(await ask(`${wt}-x/*`)).toMatchObject({ effect: "deny" })
  })

  test("denies a recorded root that was removed and replaced by a symlink to another directory", async () => {
    await armed()
    confirm(wt)
    await observe(wt)
    const other = newWorktree("other")
    rmSync(wt, { recursive: true })
    symlinkSync(other, wt)
    expect(await ask(`${wt}/*`)).toMatchObject({ effect: "deny" })
  })

  test("denies a recorded root recreated with another inode", async () => {
    await armed()
    confirm(wt)
    await observe(wt)
    renameSync(wt, `${wt}-moved`)
    mkdirSync(wt)
    expect(await ask(`${wt}/*`)).toMatchObject({ effect: "deny" })
  })

  test("keeps the first identity of a root when a later tick sees another directory at the same path", async () => {
    await armed()
    confirm(wt)
    await observe(wt)
    const first = recorded()
    renameSync(wt, `${wt}-moved`)
    mkdirSync(wt)
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n")
    await observe(wt)
    expect(recorded()).toEqual(first)
  })

  test("keeps the recorded roots across ticks and in the state file", async () => {
    await armed()
    confirm(wt)
    await observe(wt)
    fake.sessions.delete("ses_child")
    await status(tickInput())
    expect(recorded().map((entry) => entry.path)).toEqual([wt])
  })
})

describe("autopilot_merge", () => {
  const SHA = "c".repeat(40)
  const merge = (input: Record<string, unknown> = { pr: 12, sha: SHA, method: "squash" }) => {
    const tool = fake.tools.get("autopilot_merge") as unknown as { execute: (input: unknown, context: unknown) => Promise<{ content: string }> }
    return tool.execute(input, { sessionID: "ses_lead" })
  }
  const ok = (value: unknown) => ({ ok: true, stdout: JSON.stringify(value), stderr: "" })
  const ready = () => {
    ghReplies = {
      "json baseRefName,headRefOid": ok({ baseRefName: "main", headRefOid: SHA }),
      "-X PUT": ok({ merged: true, sha: "f".repeat(40), message: "Pull Request successfully merged" }),
      baseRefName: ok({ state: "OPEN", headRefOid: SHA, baseRefName: "main", author: { login: "bot" } }),
      "mergeCommit,autoMergeRequest": ok({ state: "MERGED", headRefOid: SHA, mergeCommit: { oid: "f".repeat(40) }, autoMergeRequest: null }),
      "pulls/12/reviews": ok([[{ user: { login: "rev" }, state: "APPROVED", commit_id: SHA }]]),
      "/check-runs": ok([{ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }]),
      "/status": ok([{ state: "success", statuses: [] }]),
      "required_status_checks": ok({ contexts: ["ci"] }),
      "rules/branches": ok([[]]),
      "repo view": ok({ squashMergeAllowed: true, rebaseMergeAllowed: false, mergeCommitAllowed: true }),
    }
  }
  const merged = () => calls.filter((call) => call.command === "gh" && call.args.includes("PUT"))
  const prMerges = () => calls.filter((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "merge")
  const ask = (resource: string, action = "autopilot_merge") =>
    fake.fire.permission("evaluate", { sessionID: "ses_lead", action, resources: [resource], effect: "ask", message: undefined as string | undefined })

  test("asks the host for exactly <pr>@<sha>, then merges at that head with the given method, without --admin", async () => {
    await armed({ allow: ["merge"] })
    ready()
    expect((await merge()).content).toContain("merged #12")
    expect(fake.asserts.at(-1)).toMatchObject({ sessionID: "ses_lead", action: "autopilot_merge", resources: [`12@${SHA}`] })
    expect(merged()).toEqual([{ command: "gh", args: ["api", "-X", "PUT", "repos/{owner}/{repo}/pulls/12/merge", "-f", `sha=${SHA}`, "-f", "merge_method=squash"] }])
    expect(journal().at(-1)).toMatchObject({ type: "action", summary: expect.stringContaining("merged #12") })
  })

  test("reads reviews from the REST list and checks from the commit, not from the PR view", async () => {
    await armed({ allow: ["merge"] })
    ready()
    await merge()
    const gh = calls.filter((call) => call.command === "gh").map((call) => call.args.join(" "))
    expect(gh).toContain("api repos/{owner}/{repo}/pulls/12/reviews --paginate --slurp")
    expect(gh).toContain(`api repos/{owner}/{repo}/commits/${SHA}/check-runs --paginate --slurp`)
    expect(gh).toContain(`api repos/{owner}/{repo}/commits/${SHA}/status --paginate --slurp`)
  })

  test("the hook allows the merge ask only under --allow merge", async () => {
    await armed({ allow: ["merge"] })
    expect(await ask(`12@${SHA}`)).toMatchObject({ effect: "allow" })
  })

  test("the hook denies the merge ask without the grant and journals a blocker", async () => {
    await armed({ allow: ["deploy"] })
    expect(await ask(`12@${SHA}`)).toMatchObject({ effect: "deny", message: expect.stringContaining("never approves") })
    expect(journal().at(-1)).toMatchObject({ type: "blocker" })
  })

  test("does not merge when the host refuses the permission", async () => {
    await armed()
    ready()
    ;(fake.context.permission as unknown as { assert: () => Promise<void> }).assert = async () => {
      throw new Error("denied")
    }
    await expect(merge()).rejects.toThrow("denied")
    expect(merged()).toEqual([])
  })

  const refused: [string, () => void, string][] = [
    ["the PR head is not the given SHA", () => (ghReplies.baseRefName = ok({ state: "OPEN", headRefOid: "d".repeat(40), baseRefName: "main", author: { login: "bot" } })), "head"],
    ["the only approval is a verdict comment", () => (ghReplies["pulls/12/reviews"] = ok([[]])), "approval"],
    ["the only approval is the author's own", () => (ghReplies["pulls/12/reviews"] = ok([[{ user: { login: "bot" }, state: "APPROVED", commit_id: SHA }]])), "approval"],
    ["the approval is for an older commit", () => (ghReplies["pulls/12/reviews"] = ok([[{ user: { login: "rev" }, state: "APPROVED", commit_id: "e".repeat(40) }]])), "approval"],
    ["a check is red", () => (ghReplies["/check-runs"] = ok([{ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }])), "checks"],
    ["a required context is missing", () => (ghReplies.required_status_checks = ok({ contexts: ["ci", "deploy-gate"] })), "deploy-gate"],
    ["a ruleset requires a context that is missing", () => (ghReplies["rules/branches"] = ok([[{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "e2e" }] } }]])), "e2e"],
    ["the repository does not allow the method", () => (ghReplies["repo view"] = ok({ squashMergeAllowed: false, rebaseMergeAllowed: false, mergeCommitAllowed: true })), "method"],
  ]
  test.each(refused)("refuses and journals an issue when %s", async (_name, break_, word) => {
    await armed({ allow: ["merge"] })
    ready()
    break_()
    expect((await merge()).content).toContain(word)
    expect(merged()).toEqual([])
    expect(journal().at(-1)).toMatchObject({ type: "issue", summary: expect.stringContaining("#12") })
  })

  test("a branch with no protection (404 Branch not protected) and no rules merges", async () => {
    await armed({ allow: ["merge"] })
    ready()
    ghReplies.required_status_checks = { ok: false, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" }
    expect((await merge()).content).toContain("merged #12")
  })

  test.each([
    ["the rulesets cannot be read", () => (ghReplies["rules/branches"] = { ok: false, stdout: "", stderr: "HTTP 403" })],
    ["branch protection cannot be read", () => (ghReplies.required_status_checks = { ok: false, stdout: "", stderr: "HTTP 403: Resource not accessible" })],
  ])("refuses when %s, and merges nothing", async (_name, unread) => {
    await armed({ allow: ["merge"] })
    ready()
    unread()
    expect((await merge()).content).toContain("unreadable")
    expect(merged()).toEqual([])
    expect(journal().at(-1)).toMatchObject({ type: "issue" })
  })

  test("refuses a base branch behind a merge queue, journals it, and never merges or passes --auto", async () => {
    await armed({ allow: ["merge"] })
    ready()
    ghReplies["rules/branches"] = ok([[{ type: "merge_queue", parameters: {} }]])
    expect((await merge()).content).toContain("merge queues unsupported")
    expect(merged()).toEqual([])
    expect(journal().at(-1)).toMatchObject({ type: "issue", summary: expect.stringContaining("merge queues unsupported") })
  })

  test("merges through the REST endpoint and never calls gh pr merge, so no auto-merge and no --admin", async () => {
    await armed({ allow: ["merge"] })
    ready()
    await merge()
    expect(prMerges()).toEqual([])
    expect(calls.flatMap((call) => call.args)).not.toContain("--auto")
    expect(calls.flatMap((call) => call.args)).not.toContain("--admin")
    expect(calls.flatMap((call) => call.args)).not.toContain("--disable-auto")
  })

  test("re-reads the PR after merging as a final check", async () => {
    await armed({ allow: ["merge"] })
    ready()
    await merge()
    const last = calls.filter((call) => call.command === "gh").at(-1)
    expect(last?.args).toEqual(["pr", "view", "12", "--json", "state,headRefOid,mergeCommit,autoMergeRequest"])
  })

  test("re-reads the base and head right before the PUT", async () => {
    await armed({ allow: ["merge"] })
    ready()
    await merge()
    const lines = calls.filter((call) => call.command === "gh").map((call) => call.args.join(" "))
    const put = lines.findIndex((line) => line.includes("-X PUT"))
    expect(lines[put - 1]).toBe("pr view 12 --json baseRefName,headRefOid")
  })

  test("a PR retargeted after its rules were read is refused and no PUT is sent", async () => {
    await armed({ allow: ["merge"] })
    ready()
    ghReplies["json baseRefName,headRefOid"] = ok({ baseRefName: "release", headRefOid: SHA })
    expect((await merge()).content).toContain("base")
    expect(merged()).toEqual([])
    expect(journal().at(-1)).toMatchObject({ type: "issue", summary: expect.stringContaining("base") })
  })

  test("a head that moved right before the PUT is refused and no PUT is sent", async () => {
    await armed({ allow: ["merge"] })
    ready()
    ghReplies["json baseRefName,headRefOid"] = ok({ baseRefName: "main", headRefOid: "9".repeat(40) })
    expect((await merge()).content).toContain("head")
    expect(merged()).toEqual([])
  })

  test.each([
    ["405 for a queue-required or protected branch", "Merge queue required", "405"],
    ["409 for a head mismatch", "Head branch was modified", "409"],
  ])("a %s is a refusal journaled with the status and message", async (_name, message, status) => {
    await armed({ allow: ["merge"] })
    ready()
    ghReplies["-X PUT"] = { ok: false, stdout: JSON.stringify({ message }), stderr: `gh: ${message} (HTTP ${status})` }
    const result = await merge()
    expect(result.content).toContain(status)
    expect(result.content).not.toContain("merged #12")
    expect(journal().at(-1)).toMatchObject({ type: "issue", summary: expect.stringContaining(message) })
    expect(journal().at(-1)).toMatchObject({ summary: expect.stringContaining(status) })
  })

  test("a 200 without merged: true is not a merge", async () => {
    await armed({ allow: ["merge"] })
    ready()
    ghReplies["-X PUT"] = ok({ merged: false, message: "Queued" })
    const result = await merge()
    expect(result.content).toContain("refused")
    expect(journal().some((entry) => entry.type === "action" && entry.summary.includes("merged #12"))).toBe(false)
  })

  test("a 200 whose re-read shows an open PR is refused", async () => {
    await armed({ allow: ["merge"] })
    ready()
    ghReplies["mergeCommit,autoMergeRequest"] = ok({ state: "OPEN", headRefOid: SHA, mergeCommit: null, autoMergeRequest: { enabledAt: "now" } })
    const result = await merge()
    expect(result.content).toContain("refused")
    expect(prMerges()).toEqual([])
    expect(journal().at(-1)).toMatchObject({ type: "issue", summary: expect.stringContaining("#12") })
  })

  test("a PR merged at a different head is not reported as merged", async () => {
    await armed({ allow: ["merge"] })
    ready()
    ghReplies["mergeCommit,autoMergeRequest"] = ok({ state: "MERGED", headRefOid: "9".repeat(40), mergeCommit: { oid: "f".repeat(40) }, autoMergeRequest: null })
    const result = await merge()
    expect(result.content).toContain("refused")
    expect(result.content).not.toContain("merged #12")
    expect(journal().some((entry) => entry.type === "action" && entry.summary.includes("merged #12"))).toBe(false)
  })

  test("a rebase merge passes the method through", async () => {
    await armed({ allow: ["merge"] })
    ready()
    ghReplies["repo view"] = ok({ squashMergeAllowed: true, rebaseMergeAllowed: true, mergeCommitAllowed: true })
    await merge({ pr: 12, sha: SHA, method: "rebase" })
    expect(merged()[0]?.args).toContain("merge_method=rebase")
  })

  test.each([
    { pr: "12; rm -rf /", sha: SHA, method: "squash" },
    { pr: 12, sha: "abc", method: "squash" },
    { pr: 12, sha: SHA },
    { pr: 12, sha: SHA, method: "--admin" },
  ])("rejects malformed input %p before any gh call", async (input) => {
    await armed({ allow: ["merge"] })
    expect((await merge(input)).content).toContain("refused")
    expect(calls.filter((call) => call.command === "gh")).toEqual([])
  })
})

test("the same error signature logged twice parks its bead on the next tick", async () => {
  await armed()
  for (let index = 0; index < 2; index++) expect(await log({ type: "issue", summary: "build fails", bead: "p-1", error: "TS2304 foo" })).toBe("logged issue")
  const result = await status(tickInput())
  expect(result.actions).toContainEqual({ kind: "park", item: "p-1", reason: "same error twice: TS2304 foo" })
})

test("a blocker on a bead flags it human under the store's write lock", async () => {
  await armed()
  expect(await log({ type: "blocker", summary: "needs a key", bead: "p-1", parked: true })).toBe("logged blocker; flagged p-1 human")
  expect(calls.at(-1)).toEqual({ command: "bd", args: ["update", "p-1", "--add-label", "human", "--json"] })
  expect(locked).toHaveLength(1)
})

describe("stop", () => {
  test("writes summary.md, leaves a handoff bead and disarms", async () => {
    await armed()
    await log({ type: "ambiguity", summary: "which region?" })
    beads = { list: [{ id: "p-1", status: "closed" }], ready: [], blocked: [] }
    const result = await status({ action: "stop", reason: "scope finished" })
    expect(result).toMatchObject({ done: true, stopped: "scope finished", handoff: "t-99" })
    const summary = readFileSync(join(latest(), "summary.md"), "utf8")
    expect(summary).toContain("closed beads: 1; open: 0")
    expect(summary).toContain("## Needs input\n\n- which region?")
    expect(calls.find((call) => call.args[0] === "create")?.args).toContain(HANDOFF_LABEL)
    expect(await denied("question", "ses_lead")).toBeUndefined()
    expect([...fake.storage.keys()]).toEqual([])
  })

  test("/autopilot review asks about the stopped run's summary", async () => {
    await armed()
    await status({ action: "stop", reason: "done" })
    const prompt = await command("review", "ses_other")
    expect(prompt).toContain("# Autopilot run")
    expect(prompt).toContain("parley_ask")
  })
})

describe("run state transitions", () => {
  test("a status read leaves a logged stop for the next tick", async () => {
    await armed()
    await log({ type: "stop", summary: "PR open" })
    await status({ action: "status" })
    expect(await status(tickInput())).toMatchObject({ done: true, stop: "logged: PR open" })
  })

  test("a tick racing two stops leaves the run stopped with one handoff bead", async () => {
    await armed()
    await Promise.all([status(tickInput()), status({ action: "stop", reason: "a" }), status({ action: "stop", reason: "b" })])
    const state = JSON.parse(readFileSync(join(latest(), "state.json"), "utf8")) as { phase: string }
    expect(state.phase).toBe("stopped")
    expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(1)
  })

  test("a resume that waits behind a stop does not bring the run back", async () => {
    await armed()
    let release: () => void = () => {}
    listGate = new Promise((resolve) => {
      release = resolve
    })
    const resumeReachedRoot = new Promise<void>((resolve) => {
      onRevParse = resolve
    })
    const stopping = status({ action: "stop", reason: "done" })
    const resuming = command("resume", "ses_other")
    await resumeReachedRoot
    onRevParse = undefined
    // From its rev-parse, resume takes only promise steps to reach the run lock; let them settle.
    for (let step = 0; step < 50; step++) await Promise.resolve()
    release()
    listGate = undefined
    await stopping
    expect(await resuming).toContain("already stopped")
    const state = JSON.parse(readFileSync(join(latest(), "state.json"), "utf8")) as { phase: string }
    expect(state.phase).toBe("stopped")
    expect(await denied("question", "ses_other")).toBeUndefined()
  })
})

test("/autopilot resume moves a run to the new session", async () => {
  await armed()
  const prompt = await command("resume", "ses_other")
  expect(prompt).toContain("resumed in this session")
  expect(prompt).toContain("automation_create")
  expect(await denied("question", "ses_other")).toBe(DENY_QUESTION)
  expect(await denied("question", "ses_lead")).toBeUndefined()
})

describe("fallback tick", () => {
  type Timer = { callback: () => void; cleared: boolean }
  const timers: Timer[] = []
  const clock: Clock = {
    setInterval: (callback) => {
      const timer = { callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearInterval: (timer) => {
      ;(timer as Timer).cleared = true
    },
  }

  async function startWithClock(storage?: Record<string, unknown>) {
    await cleanup?.()
    fake.closeEvents()
    fake = createFakeContext({ directory: "/repo", storage, sessions: [lead()] })
    cleanup = await setupAutopilot(fake.context, { run, now: () => NOW, lock, warn, ticks: new Ticks(clock) })
  }

  const prompts = () => fake.calls.filter((call) => call.method === "session.prompt").map((call) => (call.input as { text: string }).text)

  beforeEach(() => {
    timers.length = 0
  })

  test("sends nothing on a beat while the lead is busy", async () => {
    await startWithClock()
    await armed()
    await status({ action: "fallback" })
    fake.sessions.set("ses_lead", lead({ busy: NOW - 1_000, idle: NOW - 60_000 }))
    const before = prompts().length
    const skipped = whenCalled("get")
    timers[0]?.callback()
    await skipped
    await status({ action: "status" })
    expect(prompts()).toHaveLength(before)
  })

  test("prompts the lead with the ping while it is idle and stops at the end of the run", async () => {
    await startWithClock()
    await armed()
    await status({ action: "fallback" })
    const prompted = whenCalled("prompt")
    timers[0]?.callback()
    expect(((await prompted) as { text: string }).text).toStartWith("Autopilot tick.")
    await status({ action: "stop", reason: "done" })
    expect(timers[0]?.cleared).toBe(true)
  })

  test("starts again after a server restart", async () => {
    await startWithClock()
    await armed()
    await status({ action: "fallback" })
    const storage = Object.fromEntries(fake.storage)
    await startWithClock(storage)
    expect(timers.filter((timer) => !timer.cleared)).toHaveLength(1)
  })

  test("starts again after a server restart while the run is stopping", async () => {
    await startWithClock()
    await armed()
    await status({ action: "fallback" })
    failCreates = 1
    await status({ action: "stop", reason: "done" })
    expect(latestState().phase).toBe("stopping")
    await startWithClock(Object.fromEntries(fake.storage))
    expect(timers.filter((timer) => !timer.cleared)).toHaveLength(1)
  })
})

test("an armed run survives a server restart", async () => {
  await armed()
  const storage = Object.fromEntries(fake.storage)
  await cleanup?.()
  fake.closeEvents()
  await start(storage)
  expect(await denied("question", "ses_lead")).toBe(DENY_QUESTION)
})

describe("a turn that ends in a question", () => {
  const ask = { type: "assistant", content: [{ type: "text", text: "Done. Should I also update the docs?" }] }
  const syntheticTexts = () => fake.calls.filter((call) => call.method === "session.synthetic").map((call) => (call.input as { text: string }).text)

  test("re-prompts the lead to decide and continue", async () => {
    await armed()
    fake.messages.set("ses_lead", [ask])
    await fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [] })
    expect(syntheticTexts()).toEqual([REPROMPT])
  })

  test(`stops re-prompting after ${MAX_REPROMPTS} turns in a row and logs an issue`, async () => {
    await armed()
    fake.messages.set("ses_lead", [ask])
    for (let index = 0; index <= MAX_REPROMPTS; index++) await fake.fire.session("experimental.idle", { sessionID: "ses_lead", background: [] })
    expect(syntheticTexts()).toHaveLength(MAX_REPROMPTS)
    expect(journal().at(-1)?.type).toBe("issue")
  })
})

test("after compaction the lead gets the rules and a fresh status as a queued message", async () => {
  await armed()
  const sentPromise = whenCalled("synthetic")
  fake.emit({ type: "session.compaction.ended", data: { sessionID: "ses_lead", reason: "auto" } })
  const sent = (await sentPromise) as { text: string; delivery: string }
  expect(sent.delivery).toBe("queue")
  expect(sent.text).toContain("still armed after compaction")
})

test("cleanup disposes every registration", async () => {
  await cleanup?.()
  cleanup = undefined
  expect(fake.active()).toBe(0)
  expect(existsSync(root)).toBe(true)
})

describe("two plugin instances on one run", () => {
  test("a stale instance never writes over a run another instance stopped", async () => {
    await armed()
    let releaseB: () => void = () => {}
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let readingB: () => void = () => {}
    const startedB = new Promise<void>((resolve) => {
      readingB = resolve
    })
    const runB: Run = async (cwd, command, args) => {
      if (args[0] === "list") {
        readingB()
        await gateB
      }
      return run(cwd, command, args)
    }
    const fakeB = createFakeContext({ directory: "/repo", storage: Object.fromEntries(fake.storage), sessions: [lead()] })
    const cleanupB = await setupAutopilot(fakeB.context, { run: runB, now: () => NOW, lock, warn })
    const toolB = fakeB.tools.get("autopilot_status") as unknown as { execute: (input: unknown, context: unknown) => Promise<{ output: Record<string, unknown> }> }
    try {
      const tickB = toolB.execute(tickInput(), { sessionID: "ses_lead" })
      await startedB
      const stopping = status({ action: "stop", reason: "done" })
      await settle()
      releaseB()
      await Promise.all([tickB, stopping])
      expect(latestState().phase).toBe("stopped")
      expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(1)
    } finally {
      await cleanupB()
      fakeB.closeEvents()
    }
  })
})

describe("a run file that cannot be read", () => {
  test.each([
    ["is not JSON", "{ not json"],
    ["has the wrong shape", JSON.stringify({ version: 1, runId: "x", phase: "bogus" })],
  ])("a latest state generation that %s is reported and journaled, never read as an empty run", async (_name, text) => {
    await armed()
    const input = tickInput()
    const latestFile = `state.${latestState().generation}.json`
    writeFileSync(join(latest(), latestFile), text)
    const result = await status(input)
    expect(result).toMatchObject({ error: expect.stringContaining(latestFile) })
    expect(result).not.toHaveProperty("done")
    expect(journal().at(-1)).toMatchObject({ type: "blocker", summary: expect.stringContaining(latestFile) })
  })

  test("a corrupt line inside the journal is reported, not skipped", async () => {
    await armed()
    const path = join(latest(), "journal.jsonl")
    writeFileSync(path, `{"broken\n${readFileSync(path, "utf8")}`)
    const result = await status(tickInput())
    expect(result).toMatchObject({ error: expect.stringContaining("journal.jsonl") })
    const last = readFileSync(path, "utf8").trim().split("\n").at(-1) as string
    expect(JSON.parse(last)).toMatchObject({ type: "blocker", summary: expect.stringContaining("journal.jsonl") })
    expect(warnings.at(-1)).toBe("run file error")
  })

  test("an unreadable summary is an error for /autopilot review, not a missing one", async () => {
    await armed()
    await status({ action: "stop", reason: "done" })
    const path = join(latest(), "summary.md")
    chmodSync(path, 0o200)
    try {
      expect(await command("review", "ses_other")).toContain("could not read")
    } finally {
      chmodSync(path, 0o600)
    }
  })
})

test("startup reads every page of armed runs from storage", async () => {
  await armed()
  const storage: Record<string, unknown> = Object.fromEntries(fake.storage)
  for (let index = 0; index < 150; index++) storage[`armed/ses_a${String(index).padStart(3, "0")}`] = { runId: "gone", root }
  await cleanup?.()
  fake.closeEvents()
  fake = createFakeContext({ directory: "/repo", storage, sessions: [lead()] })
  // A host pages its scan at 100 keys whatever the caller asks for.
  const host = fake.context.storage as unknown as { scan: (input: { prefix: string; after?: string; limit?: number }) => Promise<unknown> }
  const scan = host.scan
  host.scan = (input) => scan({ ...input, limit: Math.min(input.limit ?? 100, 100) })
  cleanup = await setupAutopilot(fake.context, { run, now: () => NOW, lock, warn })
  expect(await denied("question", "ses_lead")).toBe(DENY_QUESTION)
})

describe("stop and the journal", () => {
  const handoffText = () => {
    const create = calls.find((call) => call.args[0] === "create")?.args ?? []
    return create[create.indexOf("-d") + 1] ?? ""
  }
  const summaryText = () => readFileSync(join(latest(), "summary.md"), "utf8")

  test("a blocker logged before the stop is in both the summary and the handoff bead", async () => {
    await armed()
    await log({ type: "blocker", summary: "needs a key", parked: true })
    await status({ action: "stop", reason: "done" })
    expect(summaryText()).toContain("needs a key")
    expect(handoffText()).toContain("needs a key")
  })

  test("a blocker logged while the stop runs waits for it and says the summary is closed", async () => {
    await armed()
    let release: () => void = () => {}
    listGate = new Promise((resolve) => {
      release = resolve
    })
    const stopping = status({ action: "stop", reason: "done" })
    await settle()
    const logging = log({ type: "blocker", summary: "late key", parked: true })
    await settle()
    release()
    listGate = undefined
    await stopping
    expect(await logging).toContain("after the run stopped")
    expect(summaryText().includes("late key")).toBe(handoffText().includes("late key"))
  })
})

describe("the tick automation after a resume", () => {
  type Armed = { automation: { action: { args: { run: string; token: string; session: string } } } }

  test("resume names the old automation for deletion and its ticks become no-ops that end it", async () => {
    const armedResult = (await armed()) as unknown as Armed
    const old = armedResult.automation.action.args
    await status({ action: "arm", automation_id: "aut_old" })
    const prompt = await command("resume", "ses_other")
    expect(prompt).toContain('automation_delete({ id: "aut_old" })')
    const before = latestState()
    expect(await status({ action: "tick", ...old }, "ses_lead")).toMatchObject({ done: true, stale: expect.any(String) })
    expect(latestState()).toEqual(before)
  })

  test("a tick for the current automation still runs", async () => {
    const armedResult = (await armed()) as unknown as Armed
    expect(await status({ action: "tick", ...armedResult.automation.action.args })).toHaveProperty("prompt")
  })
})

describe("a stop whose artifacts fail to write", () => {
  test("stays stopping, retries the handoff on the next tick and creates it once", async () => {
    await armed()
    failCreates = 1
    expect(await status({ action: "stop", reason: "done" })).toMatchObject({ phase: "stopping" })
    expect(latestState().phase).toBe("stopping")
    expect(await denied("question", "ses_lead")).toBe(DENY_QUESTION)
    expect(await status(tickInput())).toMatchObject({ done: true, handoff: "t-99" })
    expect(latestState().phase).toBe("stopped")
    expect(await status(tickInput())).toMatchObject({ done: true })
    expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(2)
  })

  test("retries summary.md after a failed write", async () => {
    await armed()
    mkdirSync(join(latest(), "summary.md"))
    expect(await status({ action: "stop", reason: "done" })).toMatchObject({ phase: "stopping" })
    rmSync(join(latest(), "summary.md"), { recursive: true })
    expect(await status({ action: "stop", reason: "done" })).toMatchObject({ done: true })
    expect(readFileSync(join(latest(), "summary.md"), "utf8")).toContain("- Stopped: done")
    expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(1)
  })

  test("a lookup that fails after a lost state save leaves the handoff pending and never creates a second bead", async () => {
    await armed()
    let blocked = ""
    // The bead is created, then the state save that records it fails: its generation file cannot be created.
    onCreated = () => {
      blocked = join(latest(), `state.${(latestState().generation ?? 0) + 1}.json`)
      mkdirSync(blocked)
    }
    expect(await status({ action: "stop", reason: "done" })).toHaveProperty("error")
    rmSync(blocked, { recursive: true })
    expect(latestState().phase).toBe("stopping")
    failLookups = 1
    expect(await status(tickInput())).toMatchObject({ phase: "stopping", error: expect.stringContaining("look up") })
    expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(1)
    expect(await status(tickInput())).toMatchObject({ done: true, handoff: "t-99" })
    expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(1)
  })

  test("a stop whose state write loses to a competing writer returns stale, journals an issue and keeps the successor's state", async () => {
    await armed()
    let successorPath = ""
    let successorText = ""
    // Another writer creates the next generation while this stop is creating the handoff bead.
    onCreated = () => {
      const current = latestState()
      const generation = (current.generation ?? 0) + 1
      successorPath = join(latest(), `state.${generation}.json`)
      successorText = `${JSON.stringify({ ...current, generation, ticks: 41 }, null, 2)}\n`
      writeFileSync(successorPath, successorText)
    }
    const result = await status({ action: "stop", reason: "done" })
    expect(result).toMatchObject({ stale: true, error: expect.stringContaining("state moved on") })
    expect(result).not.toHaveProperty("done")
    expect(journal().at(-1)).toMatchObject({ type: "issue", summary: expect.stringContaining("lost to another writer") })
    expect(journal().some((entry) => entry.type === "blocker")).toBe(false)
    expect(readFileSync(successorPath, "utf8")).toBe(successorText)
    const highest = readdirSync(latest())
      .map((name) => /^state\.(\d+)\.json$/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .sort((a, b) => a - b)
      .at(-1)
    expect(join(latest(), `state.${highest}.json`)).toBe(successorPath)
    expect(JSON.parse(successorText)).toMatchObject({ phase: "stopping", ticks: 41 })
  })

  test.each([
    ["is not JSON", "warning: ok\n{ not json ["],
    ["is not a list", '{"id":"t-1"}'],
  ])("a handoff lookup whose output %s leaves the stop pending and creates nothing", async (_name, stdout) => {
    await armed()
    lookupStdout = stdout
    expect(await status({ action: "stop", reason: "done" })).toMatchObject({ phase: "stopping" })
    expect(latestState().phase).toBe("stopping")
    expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(0)
  })

  test("finds a handoff bead an earlier attempt created before its state write failed", async () => {
    await armed()
    beads.list.push({ id: "t-42", status: "open", labels: [HANDOFF_LABEL], title: `Autopilot handoff: run ${latestState().runId}` })
    expect(await status({ action: "stop", reason: "done" })).toMatchObject({ done: true, handoff: "t-42" })
    expect(calls.filter((call) => call.args[0] === "create")).toHaveLength(0)
  })
})
