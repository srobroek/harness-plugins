import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parse } from "@visulima/yaml"

const workflow = parse(readFileSync(path.join(import.meta.dir, "../.github/workflows/ci-publish.yml"), "utf8")) as {
  jobs: { publish: { steps: { run: string }[] } }
}
const script = workflow.jobs.publish.steps[0]?.run.split("<<'JS'\n")[1]?.replace(/\nJS\s*$/, "")
if (!script) throw new Error("Missing CI publisher script")
const execute = new (Object.getPrototypeOf(async () => {}).constructor)("process", "fetch", script)
const trustedCi = readFileSync(path.join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8")
const definition = (text: string, sha = "workflow-blob") => ({ sha, encoding: "base64", content: Buffer.from(text).toString("base64") })

function fixture() {
  const sha = "a".repeat(40)
  const run = {
    id: 123, workflow_id: 10, run_attempt: 1, event: "workflow_dispatch", status: "completed", conclusion: "success",
    path: ".github/workflows/ci.yml", head_sha: sha, head_branch: "renovate/example", head_repository: { full_name: "owner/repo" },
  }
  const pr = { state: "open", user: { login: "renovate[bot]" }, head: { sha, ref: run.head_branch, repo: { full_name: "owner/repo", fork: false } } }
  const jobs = ["check / check", "repo-checks", "changes", "cad"].map((name) => ({ name, status: "completed", conclusion: "success" }))
  const statuses: { sha: string; context: string; state: string; target_url: string }[] = []
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
    return new Response(JSON.stringify(responses[key]))
  }
  const env = { GITHUB_TOKEN: "fixture-token", GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "b".repeat(40), RUN_ID: "123" }
  return { run, pr, jobs, responses, statuses, execute: () => execute({ env }, fetch) }
}

test("publishes the three expected statuses on the exact dispatched head", async () => {
  const f = fixture()
  await f.execute()
  expect(f.statuses.map(({ sha, context, state }) => ({ sha, context, state }))).toEqual([
    { sha: "a".repeat(40), context: "check / check", state: "success" },
    { sha: "a".repeat(40), context: "repo-checks", state: "success" },
    { sha: "a".repeat(40), context: "changes", state: "success" },
  ])
  expect(f.statuses.every((status) => status.target_url === "https://github.com/owner/repo/actions/runs/123")).toBe(true)
})

test.each(["failure", "cancelled", "timed_out"])("publishes failure for an unsuccessful run: %s", async (conclusion) => {
  const f = fixture()
  f.run.conclusion = conclusion
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["failure", "failure", "failure"])
})

test.each(["skipped", "failure"])("never promotes an unsuccessful required job: %s", async (conclusion) => {
  const f = fixture()
  const job = f.jobs[0]
  if (!job) throw new Error("Missing fixture job")
  job.conclusion = conclusion
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["failure", "failure", "failure"])
})

test("publishes pending while a new attempt runs", async () => {
  const f = fixture()
  f.run.status = "in_progress"
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["pending", "pending", "pending"])
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
  expect(f.statuses.map((status) => status.state)).toEqual(["failure", "failure", "failure"])
})

test.each(["success", "skipped", "failure"])("includes the optional cad result in the status: %s", async (conclusion) => {
  const f = fixture()
  const cad = f.jobs.find((job) => job.name === "cad")
  if (!cad) throw new Error("Missing fixture job")
  cad.conclusion = conclusion
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(conclusion === "failure" ? ["failure", "failure", "failure"] : ["success", "success", "success"])
})

test("does not publish when a GitHub API read fails", async () => {
  const f = fixture()
  delete f.responses["/actions/runs/123/jobs"]
  await expect(f.execute()).rejects.toThrow("Unexpected API request")
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
  expect(f.statuses.map((status) => status.state)).toEqual(["failure", "failure", "failure"])
})

test.each(["harness-kit", "action"])("allows a version-only update to an approved CI dependency: %s", async (dependency) => {
  const f = fixture()
  const updated = dependency === "harness-kit"
    ? trustedCi.replace(/check.yml@v\d+\.\d+\.\d+/, "check.yml@v99.0.0")
    : trustedCi.replace(/actions\/checkout@[a-f0-9]{40} # v[^\n]+/g, `actions/checkout@${"d".repeat(40)} # v99.0.0`)
  f.responses[`/contents/.github/workflows/ci.yml?ref=${f.run.head_sha}`] = definition(updated, "updated-pins")
  await f.execute()
  expect(f.statuses.map((status) => status.state)).toEqual(["success", "success", "success"])
})
