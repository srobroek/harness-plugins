import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { parse } from "@visulima/yaml"

const workflow = parse(readFileSync(path.join(import.meta.dir, "../.github/workflows/ci-publish.yml"), "utf8")) as {
  jobs: { publish: { if: string; steps: { run: string }[] } }
}
const script = workflow.jobs.publish.steps[0]?.run.split("<<'JS'\n")[1]?.replace(/\nJS\s*$/, "")
if (!script) throw new Error("Missing CI publisher script")
const execute = new (Object.getPrototypeOf(async () => {}).constructor)("process", "fetch", "setTimeout", "Date", script)
const trustedCi = readFileSync(path.join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8")
const definition = (text: string, sha = "workflow-blob") => ({ sha, encoding: "base64", content: Buffer.from(text).toString("base64") })

function admitted(github: Record<string, unknown>) {
  const condition = workflow.jobs.publish.if.replace(/github(?:\.[\w-]+)+/g, (reference) => {
    let value: unknown = github
    for (const key of reference.split(".").slice(1)) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
    return JSON.stringify(value ?? "")
  })
  return new Function(`return (${condition})`)()
}

test("admits an explicit publisher dispatch on the default branch without a workflow_run payload", () => {
  expect(admitted({ event_name: "workflow_dispatch", ref_type: "branch", ref_name: "main", event: { repository: { default_branch: "main" } } })).toBe(true)
})

test.each([
  { event_name: "workflow_dispatch", ref_type: "branch", ref_name: "renovate/example", event: { repository: { default_branch: "main" } } },
  { event_name: "workflow_dispatch", ref_type: "tag", ref_name: "main", event: { repository: { default_branch: "main" } } },
  { event_name: "workflow_run", ref_type: "branch", ref_name: "main", event: { repository: { default_branch: "main" }, workflow_run: { event: "pull_request" } } },
])("does not admit publication outside the default-branch dispatch boundary: %j", (github) => {
  expect(admitted(github)).toBe(false)
})

function fixture(completeAfterSleeps = 1) {
  const sha = "a".repeat(40)
  const run = {
    id: 123, workflow_id: 10, run_attempt: 1, event: "workflow_dispatch", status: "completed", conclusion: "success",
    path: ".github/workflows/ci.yml", head_sha: sha, head_branch: "renovate/example", head_repository: { full_name: "owner/repo" },
  }
  const pr = { state: "open", user: { login: "renovate[bot]" }, head: { sha, ref: run.head_branch, repo: { full_name: "owner/repo", fork: false } } }
  const jobs = ["check / check", "repo-checks"].map((name) => ({ name, status: "completed", conclusion: "success" }))
  const statuses: { sha: string; context: string; state: string; target_url: string }[] = []
  const requests: string[] = []
  const responses: Record<string, unknown> = {
    "/actions/runs/123": run,
    "/actions/workflows/ci.yml/runs": { workflow_runs: [run] },
    "/pulls": [pr],
    [`/contents/.github/workflows/ci.yml?ref=${sha}`]: definition(trustedCi),
    [`/contents/.github/workflows/ci.yml?ref=${"b".repeat(40)}`]: definition(trustedCi),
    "/actions/runs/123/jobs": { total_count: jobs.length, jobs },
  }
  const fetch = async (url: string, options: { method: string; body?: string }) => {
    const endpoint = url.replace("https://api.github.com/repos/owner/repo", "")
    requests.push(endpoint)
    if (options.method === "POST" && endpoint.startsWith("/statuses/")) {
      statuses.push({ sha: endpoint.split("/").at(-1) ?? "", ...JSON.parse(options.body ?? "{}") })
      return new Response("{}", { status: 201 })
    }
    const key = endpoint.startsWith("/contents/") ? endpoint : (endpoint.split("?")[0] ?? "")
    if (key === "/actions/workflows/ci.yml/runs") {
      expect(new URL(url).searchParams.get("event")).toBe("workflow_dispatch")
      expect(new URL(url).searchParams.get("head_sha")).toBe(sha)
      expect(new URL(url).searchParams.get("branch")).toBe(run.head_branch)
      expect(new URL(url).searchParams.get("per_page")).toBe("1")
    }
    if (key === "/actions/runs/123/jobs") expect(new URL(url).searchParams.get("filter")).toBe("latest")
    if (!(key in responses)) throw new Error(`Unexpected API request: ${endpoint}`)
    const response = responses[key]
    return response instanceof Response ? response : new Response(JSON.stringify(response))
  }
  const env = { GITHUB_TOKEN: "fixture-token", GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "b".repeat(40), RUN_ID: "123" }
  const delays: number[] = []
  const sleep = (callback: () => void, milliseconds: number) => {
    delays.push(milliseconds)
    if (delays.length >= completeAfterSleeps) run.status = "completed"
    callback()
  }
  return { run, pr, jobs, responses, statuses, requests, env, delays, execute: (clock: Pick<DateConstructor, "now"> = Date) => execute({ env }, fetch, sleep, clock) }
}

test("publishes the expected statuses on the exact dispatched head", async () => {
  const f = fixture()
  await f.execute()
  expect(f.statuses.map(({ sha, context, state }) => ({ sha, context, state }))).toEqual([
    { sha: "a".repeat(40), context: "check / check", state: "success" },
    { sha: "a".repeat(40), context: "repo-checks", state: "success" },
  ])
  expect(f.statuses.every((status) => status.target_url === "https://github.com/owner/repo/actions/runs/123")).toBe(true)
})

test.each(["failure", "cancelled", "timed_out"])("publishes failure for an unsuccessful run: %s", async (conclusion) => {
  const f = fixture()
  f.run.conclusion = conclusion
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["failure", "failure"])
})

test.each(["skipped", "failure"])("never promotes an unsuccessful required job: %s", async (conclusion) => {
  const f = fixture()
  const job = f.jobs[0]
  if (!job) throw new Error("Missing fixture job")
  job.conclusion = conclusion
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["failure", "failure"])
})

test("publishes pending, waits thirty seconds, then publishes completion", async () => {
  const f = fixture()
  f.run.status = "in_progress"
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["pending", "pending", "success", "success"])
  expect(f.delays).toEqual([30_000])
})

test("stops polling after twenty minutes without publishing success", async () => {
  const f = fixture()
  f.run.status = "in_progress"
  let reads = 0
  const clock = { now: () => (++reads === 1 ? 0 : 21 * 60_000) }
  await expect(f.execute(clock)).rejects.toThrow("Timed out waiting for dispatched CI")
  expect(f.statuses.map((status) => status.state)).toEqual(["pending", "pending"])
  expect(f.delays).toEqual([])
})

test("retries when CI completes during the freshness check", async () => {
  const f = fixture()
  f.run.status = "in_progress"
  let reads = 0
  Object.defineProperty(f.responses, "/actions/runs/123", {
    get: () => ({ ...f.run, status: ++reads === 1 ? "in_progress" : "completed" }),
  })
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["success", "success"])
  expect(f.delays).toEqual([30_000])
})

test("repeated pending polls reuse immutable CI definitions and publish only state transitions", async () => {
  const f = fixture(3)
  f.run.status = "in_progress"
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["pending", "pending", "success", "success"])
  expect(f.requests.filter((request) => request.startsWith("/contents/")).length).toBe(2)
  expect(f.delays).toEqual([30_000, 30_000, 30_000])
})

test.each(["123/../../statuses/other", "", "-1"])("rejects an invalid dispatched run id: %s", async (runId) => {
  const f = fixture()
  f.env.RUN_ID = runId
  await expect(f.execute()).rejects.toThrow("Invalid CI run id")
  expect(f.statuses).toEqual([])
})

test.each(["fork", "new-head", "non-renovate"])("does not publish for an ineligible PR: %s", async (reason) => {
  const f = fixture()
  if (reason === "fork") f.pr.head.repo.fork = true
  if (reason === "new-head") f.pr.head.sha = "c".repeat(40)
  if (reason === "non-renovate") f.pr.user.login = "someone"
  await f.execute()
  expect(f.statuses).toEqual([])
})

test("ignores an older dispatch when a newer dispatch exists", async () => {
  const f = fixture()
  f.responses["/actions/workflows/ci.yml/runs"] = { workflow_runs: [{ ...f.run, id: 124 }, f.run] }
  await f.execute()
  expect(f.statuses).toEqual([])
})

test("fails closed when the branch replaces the trusted CI definition", async () => {
  const f = fixture()
  f.responses[`/contents/.github/workflows/ci.yml?ref=${f.run.head_sha}`] = definition(trustedCi.replace("contents: read", "contents: write"), "untrusted-workflow")
  await expect(f.execute()).rejects.toThrow("CI definition differs")
  expect(f.statuses).toEqual([])
})

test("fails closed when a required job is absent", async () => {
  const f = fixture()
  f.jobs.splice(0, 1)
  f.responses["/actions/runs/123/jobs"] = { total_count: f.jobs.length, jobs: f.jobs }
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["failure", "failure"])
})


test("does not publish when a GitHub API read fails", async () => {
  const f = fixture()
  f.responses["/actions/runs/123/jobs"] = new Response("Not found", { status: 404 })
  await expect(f.execute()).rejects.toThrow("GitHub API /actions/runs/123/jobs?filter=latest&per_page=100: 404")
  expect(f.statuses).toEqual([])
})

test.each(["event", "path", "repository", "branch"])("ignores a run outside the trusted dispatch boundary: %s", async (reason) => {
  const f = fixture()
  if (reason === "event") f.run.event = "pull_request"
  if (reason === "path") f.run.path = ".github/workflows/other.yml"
  if (reason === "repository") f.run.head_repository.full_name = "someone/repo"
  if (reason === "branch") f.run.head_branch = "feature/example"
  await f.execute()
  expect(f.statuses).toEqual([])
})

test("does not publish for multiple matching PRs", async () => {
  const f = fixture()
  f.responses["/pulls"] = [f.pr, f.pr]
  await f.execute()
  expect(f.statuses).toEqual([])
})

test("does not publish results from a superseded attempt", async () => {
  const f = fixture()
  let reads = 0
  Object.defineProperty(f.responses, "/actions/runs/123", { get: () => (++reads === 1 ? f.run : { ...f.run, run_attempt: 2 }) })
  await f.execute()
  expect(f.statuses).toEqual([])
})

test("does not treat truncated job results as success", async () => {
  const f = fixture()
  f.responses["/actions/runs/123/jobs"] = { total_count: 101, jobs: f.jobs }
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["failure", "failure"])
})

test.each(["harness-kit", "action"])("allows a version-only update to an approved CI dependency: %s", async (dependency) => {
  const f = fixture()
  const updated = dependency === "harness-kit"
    ? trustedCi.replace(/check.yml@v\d+\.\d+\.\d+/, "check.yml@v99.0.0")
    : trustedCi.replace(/actions\/checkout@[a-f0-9]{40} # v[^\n]+/g, `actions/checkout@${"d".repeat(40)} # v99.0.0`)
  f.responses[`/contents/.github/workflows/ci.yml?ref=${f.run.head_sha}`] = definition(updated, "updated-pins")
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["success", "success"])
})

// Every action the publisher's normalizer lists. setup-bun is not in the current ci.yml, so each test appends one pinned step per action.
const listedActions = ["actions/checkout", "actions/setup-node", "oven-sh/setup-bun", "jdx/mise-action"]
const withPins = (text: string, pins: Record<string, string>) =>
  `${text}\n${Object.entries(pins).map(([action, sha]) => `      - uses: ${action}@${sha.repeat(40)} # v1.2.3`).join("\n")}\n`
const pinsAt = (sha: string, bumped?: string) =>
  Object.fromEntries([...listedActions, "actions/cache"].map((action) => [action, action === bumped ? "d" : sha]))

test.each(listedActions)("allows a digest-only bump of a listed action: %s", async (action) => {
  const f = fixture()
  f.responses[`/contents/.github/workflows/ci.yml?ref=${"b".repeat(40)}`] = definition(withPins(trustedCi, pinsAt("a")), "trusted-pins")
  f.responses[`/contents/.github/workflows/ci.yml?ref=${f.run.head_sha}`] = definition(withPins(trustedCi, pinsAt("a", action)), "bumped-pin")
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["success", "success"])
})

test("rejects a digest-only bump of an action outside the list: actions/cache", async () => {
  const f = fixture()
  f.responses[`/contents/.github/workflows/ci.yml?ref=${"b".repeat(40)}`] = definition(withPins(trustedCi, pinsAt("a")), "trusted-pins")
  f.responses[`/contents/.github/workflows/ci.yml?ref=${f.run.head_sha}`] = definition(withPins(trustedCi, pinsAt("a", "actions/cache")), "bumped-pin")
  await expect(f.execute()).rejects.toThrow("CI definition differs")
  expect(f.statuses).toEqual([])
})

test.each([
  ["another action owner", (text: string) => text.replace("actions/checkout@", "someone/checkout@")],
  ["another action", (text: string) => text.replace("actions/checkout@", "actions/upload-artifact@")],
  ["mutable workflow ref", (text: string) => text.replace(/check.yml@v\d+\.\d+\.\d+/, "check.yml@main")],
  ["another reusable workflow", (text: string) => text.replace("workflows/check.yml@", "workflows/other.yml@")],
  ["missing step", (text: string) => text.replace(/^\s+- uses: actions\/checkout@[^\n]+\n/m, "")],
])("rejects CI dependency changes outside the version allowlist: %s", async (_reason, edit) => {
  const f = fixture()
  f.responses[`/contents/.github/workflows/ci.yml?ref=${f.run.head_sha}`] = definition(edit(trustedCi), "unapproved-change")
  await expect(f.execute()).rejects.toThrow("CI definition differs")
  expect(f.statuses).toEqual([])
})

test("does not publish if a newer dispatch starts during evaluation", async () => {
  const f = fixture()
  let reads = 0
  Object.defineProperty(f.responses, "/actions/workflows/ci.yml/runs", {
    get: () => ({ workflow_runs: [++reads === 1 ? f.run : { ...f.run, id: 124 }] }),
  })
  await f.execute()
  expect(f.statuses).toEqual([])
})

test.each(["123", "null"])("regeneration dispatches a publisher only for a valid returned CI run id: %s", (runId) => {
  const root = path.join(import.meta.dir, "..")
  const regeneration = parse(readFileSync(path.join(root, ".github/workflows/renovate-regenerate.yml"), "utf8")) as {
    jobs: { push: { steps: { run?: string }[] } }
  }
  const step = regeneration.jobs.push.steps.find((step) => step.run?.includes("/ci.yml/dispatches"))?.run ?? ""
  const handoff = step.slice(step.indexOf("run_id=$(gh api"))
  const dir = mkdtempSync(path.join(tmpdir(), "publisher-handoff-"))
  try {
    const log = path.join(dir, "requests")
    writeExecutable(path.join(dir, "gh"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$REQUESTS"\nif [ "$1" = api ]; then printf "%s\\n" "$RETURNED_RUN_ID"; fi\n')
    const result = Bun.spawnSync(["bash", "-e", "-c", handoff], {
      cwd: root,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: "owner/repo", PR_BRANCH: "renovate/example", DEFAULT_BRANCH: "main", REQUESTS: log, RETURNED_RUN_ID: runId },
      stdout: "pipe", stderr: "pipe",
      // Local CLI stubs do no network or git work. The timeout bounds process startup.
      timeout: 2_000,
    })
    expect(result.exitCode).toBe(runId === "123" ? 0 : 1)
    const requests = readFileSync(log, "utf8").trim().split("\n")
    expect(requests[0]).toBe("api repos/owner/repo/actions/workflows/ci.yml/dispatches --method POST -H X-GitHub-Api-Version: 2026-03-10 -f ref=renovate/example --jq .workflow_run_id")
    if (runId === "123") expect(requests[1]).toBe("workflow run ci-publish.yml --ref main -f run_id=123")
    expect(requests.length).toBe(runId === "123" ? 2 : 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
