// Shared fixtures for the tests that drive the real `landPullRequest` through a scripted
// process boundary (`runner`): one place that knows which argv the forge and git answer.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CliResult, type CliRunner, SAFE_GIT_ARGS } from "./forge-adapter.ts"

/** The argv without the safe-option prefix every checkout-bound Git command carries. */
export const withoutSafeGit = (argv: readonly string[]): string[] =>
  argv[0] === "git" && SAFE_GIT_ARGS.every((part, index) => argv[index + 1] === part)
    ? ["git", ...argv.slice(1 + SAFE_GIT_ARGS.length)]
    : [...argv]

/** A runner that sees Git argv with the safe prefix removed, so the scripted answers match on the verb. */
export const matchingVerbs =
  (inner: CliRunner): CliRunner =>
  (argv, options) =>
    inner(withoutSafeGit(argv), options)

export type Call = {
  argv: string[]
  cwd: string | undefined
  timeoutMs: number
  env: Readonly<Record<string, string>> | undefined
}

export const MERGE_OID = "feedfacecafebabe0123456789abcdef01234567"
export const HEAD_OID = "0123456789abcdef0123456789abcdef01234567"
export const BASE_OID = "1111111111111111111111111111111111111111"
export const TIP_OID = "2222222222222222222222222222222222222222"
export const PARENT_TREE = "3333333333333333333333333333333333333333"
export const LANDED_TREE = "4444444444444444444444444444444444444444"
export const BASE_BRANCH = "omp/integration/omp-plugins-9ej3"
export const REMOTE_URL = "https://github.com/srobroek/omp-plugins.git"
/** What a GitHub landing fetches from: the repository's HTTPS URL, built from its owner/name. */
export const FETCH_URL = "https://github.com/srobroek/omp-plugins.git"
export const BRANCH = "omp/agent/omp-plugins-9ej3.5"
export const NOW = 1_764_000_000_000
export const TITLE = "fix(delivery): land the reviewed head"

/** The reviewed head a merging call must name; only an already-MERGED proof may omit it. */
export const REVIEWED = { expectHeadSha: HEAD_OID } as const

export const completed = (stdout: string, exitCode = 0, stderr = ""): CliResult => ({ ok: true, exitCode, stdout, stderr })

/** A GitHub pull-request payload in `gh pr view --json` spelling. */
export const githubPr = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "PR_node_470",
    number: 470,
    url: "https://github.com/srobroek/omp-plugins/pull/470",
    title: TITLE,
    state: "OPEN",
    baseRefName: BASE_BRANCH,
    headRefName: BRANCH,
    headRefOid: HEAD_OID,
    mergeCommit: null,
    mergedAt: null,
    ...overrides,
  })

export const mergedGithubPr = (overrides: Record<string, unknown> = {}): string =>
  githubPr({ state: "MERGED", mergeCommit: { oid: MERGE_OID }, mergedAt: "2026-09-21T20:00:00Z", ...overrides })

/** A GitHub GraphQL answer for one branch ref: present at `oid`, or an explicit null ref when `oid` is null. */
export const githubRef = (branch: string, oid: string | null, repo = "srobroek/omp-plugins"): string =>
  JSON.stringify({
    data: {
      repository: {
        nameWithOwner: repo,
        ref: oid === null ? null : { prefix: "refs/heads/", name: branch, target: { __typename: "Commit", oid } },
      },
    },
  })

/** A GitLab merge request in `glab mr view --output json` spelling. */
export const gitlabMr = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    iid: 12,
    web_url: "https://gitlab.com/group/project/-/merge_requests/12",
    title: TITLE,
    state: "merged",
    target_branch: "main",
    source_branch: BRANCH,
    sha: HEAD_OID,
    merge_commit_sha: MERGE_OID,
    merged_at: "2026-09-21T20:00:00Z",
    ...overrides,
  })

/** Every fixture directory this file creates, so a test can prove none outlives its test. */
export const created: string[] = []
/** The ones the running test created, removed once it ends. */
export const pending: string[] = []

export function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  created.push(path)
  pending.push(path)
  return path
}

/** A linked worktree of `canonical`, as `git worktree add` lays it out: a `.git` file and an admin directory. */
export function linkedWorktree(canonical: string, name: string): string {
  const path = join(temporaryDirectory("delivery-land-linked-"), name)
  const admin = join(canonical, ".git", "worktrees", name)
  mkdirSync(path, { recursive: true })
  mkdirSync(admin, { recursive: true })
  writeFileSync(join(path, ".git"), `gitdir: ${admin}\n`)
  writeFileSync(join(admin, "commondir"), "../..\n")
  return path
}


/** Remove the fixtures the running test created; call it from the test file's `afterEach`. */
export function cleanupFixtures(): void {
  for (const path of pending.splice(0)) rmSync(path, { recursive: true, force: true })
}

/**
 * A repository whose git reads answer from a real temporary directory.
 *
 * `repoKey` hashes the realpath of the git common directory, so the fixture
 * creates one: the receipt then carries a key that a reader could reproduce, and
 * `canonicalRoot` is the parent this landing was keyed from.
 */
export function repository(): { canonical: string; receipts: string } {
  const canonical = temporaryDirectory("delivery-land-repo-")
  mkdirSync(join(canonical, ".git", "objects"), { recursive: true })
  return { canonical, receipts: temporaryDirectory("delivery-land-receipts-") }
}

export type Answers = {
  prView?: CliResult[]
  merge?: CliResult
  autoDelete?: CliResult
  policy?: CliResult
  enable?: CliResult
  parents?: string
  remoteUrl?: string
  /** What `git rev-parse --verify HEAD^{commit}` answers inside a supplied worktree. */
  worktreeHead?: CliResult
  /** What `git worktree list --porcelain` prints in the repository; empty by default. */
  worktrees?: string
  /** Whether each `git cat-file -e <oid>^{commit}` finds the object, in call order; present once the list is spent. */
  present?: boolean[]
  /** What each `git fetch` answers, in call order; exit 0 once the list is spent. */
  fetch?: CliResult[]
  /** What the approval read (`gh pr view --json author,reviews,comments` or the GitLab approvals API) answers. */
  approval?: CliResult
  /** The approval read once per entry, in call order; the last repeats. Wins over `approval`. */
  approvals?: CliResult[]
  /** The REST review list (`pulls/<n>/reviews`); by default the `gh pr view` approval's reviews in REST spelling. */
  reviews?: CliResult
  /** GitHub classic protection `required_pull_request_reviews` of the base branch; one approval and stale dismissal by default. */
  protection?: CliResult
  /** GitLab `projects/<id>/approval_rules`; one required approval by default. */
  approvalRules?: CliResult
  /** The reviewer permission read once per entry, in call order; the last repeats. Wins over `permission`. */
  permissions?: CliResult[]
  /** GitLab `projects/<id>/approvals` (the project's approval settings); resets on push by default. */
  projectApprovals?: CliResult
  /** GitLab `projects/<id>/members/all/<user>`; Developer access by default. */
  member?: CliResult
  /** What the branch rules read (`gh api repos/<o>/<r>/rules/branches/<base>`) answers; no rules by default. */
  rules?: CliResult
  /** What each merge queue state read (`gh api graphql` query) answers, in call order; the last repeats. */
  queueStates?: CliResult[]
  /** Runs while queue state read `index` (0-based) is in flight; the read answers once it settles. */
  duringQueueState?: (index: number) => Promise<void> | undefined
  /** What the `enqueuePullRequest` mutation answers. */
  enqueue?: CliResult
  /** Runs while the `enqueuePullRequest` mutation is in flight, and supplies its answer. */
  duringEnqueue?: () => Promise<CliResult>
  /** What the forge's compare read (`compare/<oid>...<base>`) answers; "ahead" by default. */
  compare?: CliResult
  /** What the `mergeQueue(branch:)` read after a rules 404 answers. */
  mergeQueueProbe?: CliResult
  /** What the rulesets list read after a rules 404 answers. */
  rulesets?: CliResult
  /** What the GitHub GraphQL read of the base branch's ref answers; its tip is `TIP_OID` by default. GitLab's `ls-remote` always names `TIP_OID`. */
  baseRef?: CliResult
  /** What the GitHub GraphQL read of the head branch's ref answers; an explicit null (absent) by default. GitLab's `ls-remote` always answers absent. */
  headRef?: CliResult
  /** What `git rev-parse <landed>^{tree}` answers; the parent's tree is always `PARENT_TREE`. */
  landedTree?: CliResult
  /** What `git merge-tree --write-tree <parent> <head>` answers. */
  mergeTree?: CliResult
  /** What `git merge-base --is-ancestor` answers. */
  ancestor?: CliResult
  /** What `git merge-base --is-ancestor <landed> <base tip>` answers; `ancestor` when unset. */
  onBase?: CliResult
  /** The version `git --version` prints; 2.45.1 when unset. */
  gitVersion?: string
  /** What the checks read (`gh pr checks` or the GitLab merge request API) answers. */
  checks?: CliResult
  /** The authenticated account (`gh api user`). */
  viewer?: CliResult
  /** A reviewer's `collaborators/<user>/permission`. */
  permission?: CliResult
  /** `commits/<sha>/check-runs`. */
  checkRuns?: CliResult
  /** `commits/<sha>/status`. */
  commitStatus?: CliResult
}

/**
 * One runner for every child process the tool may start, recording each argv.
 *
 * Recording all of them in one place is what makes "no merge argv was issued" and
 * "no bd argv was issued" observations rather than assertions about intent. An
 * unexpected command fails loudly instead of returning a plausible default.
 */
/** The `gh pr view` reviews of an approval answer, as the REST review list spells them. */
export function restReviews(answer: CliResult | undefined): unknown[] {
  try {
    const view = JSON.parse(answer?.stdout ?? "{}") as { reviews?: Array<{ state: string; author: { login: string }; commit: { oid: string } }> }
    return (view.reviews ?? []).map((review) => ({ user: { login: review.author.login }, state: review.state, commit_id: review.commit.oid }))
  } catch {
    return []
  }
}

export function runner(answers: Answers, canonical: string): { run: CliRunner; calls: Call[] } {
  const views = [...(answers.prView ?? [])]
  const present = [...(answers.present ?? [])]
  const fetches = [...(answers.fetch ?? [])]
  const approvals = [...(answers.approvals ?? [])]
  let lastApproval: CliResult | undefined
  const permissions = [...(answers.permissions ?? [])]
  /** The next scripted answer; the last one repeats. */
  const next = (queue: CliResult[]): CliResult | undefined => (queue.length > 1 ? queue.shift() : queue[0])
  const states = [...(answers.queueStates ?? [])]
  let stateReads = 0
  const calls: Call[] = []
  const run: CliRunner = (argv, options) => {
    calls.push({ argv: [...argv], cwd: options.cwd, timeoutMs: options.timeoutMs, env: options.env })
    const command = argv.join(" ")
    if (argv[0] === "git" && argv.at(-1) === "--version") return completed(`git version ${answers.gitVersion ?? "2.45.1"}\n`)
    if (command.startsWith("git rev-parse --path-format=absolute --git-common-dir --show-toplevel")) {
      return completed(`${join(canonical, ".git")}\n${canonical}\n`)
    }
    // What the isolated GitHub fetch reads about the checkout's objects.
    if (command === "git rev-parse --show-object-format --git-path objects --git-path shallow --all")
      return completed(`sha1\n${join(canonical, ".git", "objects")}\n${join(canonical, ".git", "shallow")}\n${BASE_OID}\n`)
    if (argv[0] === "git" && argv.includes("show") && argv.includes("-s"))
      return completed(`${answers.parents ?? BASE_OID}\n`)
    const treeOf = argv.find((part) => part.endsWith("^{tree}"))
    if (argv[0] === "git" && argv.includes("rev-parse") && treeOf !== undefined) {
      const parent = (answers.parents ?? BASE_OID).split(" ")[0]
      return treeOf.startsWith(`${parent}^`) ? completed(`${PARENT_TREE}\n`) : (answers.landedTree ?? completed(`${LANDED_TREE}\n`))
    }
    if (argv[0] === "git" && argv.includes("merge-tree")) return answers.mergeTree ?? completed(`${LANDED_TREE}\n`)
    if (argv[0] === "git" && argv.includes("ls-remote") && argv.some((part) => part === `refs/heads/${BASE_BRANCH}` || part === "refs/heads/main"))
      return completed(`${TIP_OID}\trefs/heads/${argv.find((part) => part.startsWith("refs/heads/"))?.slice(11)}\n`)
    if (argv[0] === "git" && argv[1] === "cat-file" && argv[2] === "-e")
      return (present.shift() ?? true) ? completed("") : completed("", 1, "fatal: not a commit")
    if (argv[0] === "git" && argv.includes("fetch")) return fetches.shift() ?? completed("")
    if (command === "git rev-parse --verify HEAD^{commit}") return answers.worktreeHead ?? completed(`${HEAD_OID}\n`)
    if (command.startsWith("git remote get-url")) return completed(`${answers.remoteUrl ?? REMOTE_URL}\n`)
    if (command === "git remote") return completed("origin\n")
    if (command === "git worktree list --porcelain") return completed(answers.worktrees ?? "")
    if (argv[1] === "pr" && argv[2] === "view" && argv.includes("author,reviews,comments")) {
      lastApproval = next(approvals) ?? answers.approval ?? completed("{}")
      return lastApproval
    }
    if (argv[1] === "api" && argv.some((part) => /\/pulls\/\d+\/reviews/.test(part)))
      return answers.reviews ?? completed(JSON.stringify([restReviews(lastApproval ?? answers.approval)]))
    if (argv[1] === "api" && argv[2] === "user") return answers.viewer ?? completed(JSON.stringify({ login: "author" }))
    if (argv[1] === "api" && argv.some((part) => part.includes("/protection/required_pull_request_reviews")))
      return answers.protection ?? completed(JSON.stringify({ required_approving_review_count: 1, dismiss_stale_reviews: true }))
    if (argv[1] === "api" && argv.some((part) => part.endsWith("/approval_rules")))
      return answers.approvalRules ?? completed(JSON.stringify([{ approvals_required: 1 }]))
    if (argv[1] === "api" && argv.some((part) => part.includes("/collaborators/")))
      return next(permissions) ?? answers.permission ?? completed(JSON.stringify({ permission: "write", role_name: "write" }))
    if (argv[1] === "api" && argv.some((part) => part.includes("/check-runs")))
      return answers.checkRuns ?? completed(JSON.stringify({ total_count: 0, check_runs: [] }))
    if (argv[1] === "api" && argv.some((part) => /\/commits\/[0-9a-f]+\/status/.test(part)))
      return answers.commitStatus ?? completed(JSON.stringify({ state: "pending", total_count: 0, statuses: [] }))
    if (argv[0] === "git" && argv.includes("merge-base") && argv.includes("--is-ancestor"))
      return (argv.at(-1) === TIP_OID ? answers.onBase : undefined) ?? answers.ancestor ?? completed("")
    // No fork point: the rebase proof that reads one is shown against real commits elsewhere.
    if (argv[0] === "git" && argv.includes("merge-base")) return completed("", 1)
    if (argv[1] === "api" && argv.some((part) => part.includes("/compare/")))
      return answers.compare ?? completed("ahead\n")
    if (argv[1] === "api" && argv.some((part) => part.includes("/rulesets")))
      return answers.rulesets ?? completed("[]")
    if (argv[1] === "api" && argv[2] === "graphql" && argv.some((part) => part.includes("mergeQueue(branch")))
      return (
        answers.mergeQueueProbe ??
        completed(JSON.stringify({ data: { repository: { nameWithOwner: "srobroek/omp-plugins", mergeQueue: null } } }))
      )
    if (argv[1] === "api" && argv.some((part) => part.includes("/rules/branches/")))
      return answers.rules ?? completed("[]")
    if (argv[1] === "api" && argv[2] === "graphql" && argv.some((part) => part.includes("ref(qualifiedName"))) {
      const branch = argv.find((part) => part.startsWith("ref=refs/heads/"))?.slice("ref=refs/heads/".length) ?? ""
      return branch === BASE_BRANCH || branch === "main"
        ? (answers.baseRef ?? completed(githubRef(branch, TIP_OID)))
        : (answers.headRef ?? completed(githubRef(branch, null)))
    }
    if (argv[1] === "api" && argv[2] === "graphql") {
      if (argv.some((part) => part.startsWith("query=mutation")))
        return answers.duringEnqueue?.() ?? answers.enqueue ?? completed("{}")
      const state = (states.length > 1 ? states.shift() : states[0]) ?? completed("{}")
      const during = answers.duringQueueState?.(stateReads++)
      return during === undefined ? state : during.then(() => state)
    }
    if (argv[1] === "api" && argv.some((part) => part.includes("/merge_requests/") && part.endsWith("/approvals")))
      return next(approvals) ?? answers.approval ?? completed("{}")
    if (argv[1] === "api" && argv.some((part) => part.endsWith("/approvals")))
      return answers.projectApprovals ?? completed(JSON.stringify({ reset_approvals_on_push: true, disable_overriding_approvers_per_merge_request: true }))
    if (argv[1] === "api" && argv.some((part) => part.includes("/members/all/")))
      return answers.member ?? completed(JSON.stringify({ access_level: 30 }))
    if (argv[1] === "api" && argv.some((part) => /\/merge_requests\/\d+$/.test(part)))
      return answers.checks ?? completed("{}")
    if (argv[1] === "pr" && argv[2] === "view") return views.shift() ?? completed(mergedGithubPr())
    if (argv[1] === "mr" && argv[2] === "view") return views.shift() ?? completed(gitlabMr())
    if (argv[1] === "api" && argv.includes(".allow_merge_commit")) return answers.policy ?? completed("true\n")
    if (argv[1] === "api" && argv.includes("-X")) return answers.enable ?? completed("{}\n")
    if (argv[1] === "api") return answers.autoDelete ?? completed("false\n")
    if (argv[1] === "pr" && argv[2] === "merge") return answers.merge ?? completed("")
    if (argv[1] === "mr" && argv[2] === "merge") return answers.merge ?? completed("")
    if (argv.includes("ls-remote")) return { ok: true, exitCode: 2, stdout: "", stderr: "" }
    throw new Error(`the tool issued an unexpected command: ${command}`)
  }
  return { run, calls }
}
