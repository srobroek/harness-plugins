import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentPermission, permissionEffect } from "@srobroek/opencode-lib/agent-files"
import { contextModeTools, toolOrder } from "./context-mode-tools.ts"
import {
  AGENT_IDS,
  type AgentId,
  branchMode,
  CODE_RUNNING_TOOLS,
  CONTEXT_ADMIN_TOOLS,
  CONTEXT_TOOLS,
  childMode,
  decideToolCall,
  enterReminder,
  leaveReminder,
  MODE_RULES,
  MODE_TOOLS,
  PI_SCRATCH,
  readState,
  shellWorkdir,
  statusText,
  switchMode,
} from "./policy.ts"

const PLUGIN = join(import.meta.dir, "..")
const root = mkdtempSync(join(tmpdir(), "modes-pi-"))
const home = join(root, "home")
const cwd = join(root, "repo")
const scratch = join(home, PI_SCRATCH.worktrees, "repo", "debug-x")
mkdirSync(join(cwd, "src"), { recursive: true })
mkdirSync(scratch, { recursive: true })
symlinkSync(join(cwd, "src"), join(scratch, "escape"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const env = { cwd, home }
const decide = (mode: AgentId, tool: string, input: unknown) => decideToolCall(mode, tool, input, env)
const effect = (mode: AgentId, tool: string, input: unknown) => decide(mode, tool, input).effect

function frontmatter(file: string): Record<string, unknown> {
  const text = readFileSync(file, "utf8")
  return Bun.YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "") as Record<string, unknown>
}

/** OpenCode's paths and agent names, spelled the way pi's rules spell them. */
function piSpelling(rule: AgentPermission): AgentPermission {
  const resource = rule.resource
    .replace("~/.opencode/debug/", `~/${PI_SCRATCH.ledger}/`)
    .replace("~/.local/share/opencode/worktree/", `~/${PI_SCRATCH.worktrees}/`)
    .replace("~/.opencode/concept/", "~/.pi/concept/")
  return { ...rule, resource: rule.action === "subagent" && resource === "explore" ? "scout" : resource }
}

/** OpenCode helpers pi does without: its own session tools cover `seance`. */
const OPENCODE_ONLY_HELPERS = new Set(["seance"])

describe("pi rules and tools stay in step with the agents", () => {
  const GUARDED = new Set(["*", "read", "external_directory", "edit", "shell", "webfetch", "subagent"])

  test.each(AGENT_IDS.map((id) => [id]))("%s has its OpenCode agent's read, edit, shell, webfetch and subagent rules", (id) => {
    const rules = (frontmatter(join(PLUGIN, "agents.src", `${id}.md`)).permissions as AgentPermission[])
      .filter((rule) => GUARDED.has(rule.action) && !(rule.action === "subagent" && OPENCODE_ONLY_HELPERS.has(rule.resource)))
      .map(piSpelling)
    expect(MODE_RULES[id]).toEqual(rules)
  })

  test.each(AGENT_IDS.map((id) => [id]))("%s.pi.md lists exactly the mode's tools", (id) => {
    const tools = String(frontmatter(join(PLUGIN, "common", "agents", `${id}.pi.md`)).tools)
      .split(",")
      .map((tool) => tool.trim())
    expect(tools).toEqual([...MODE_TOOLS[id]])
  })
})

describe("the tool allowlist", () => {
  test("a tool outside the mode is refused, pi-subagents runtime tools pass", () => {
    expect(decide("refactor", "ast_grep_replace", {})).toEqual({ effect: "deny", reason: "`ast_grep_replace` is not available in Refactor mode" })
    expect(effect("debug", "lsp_navigation", {})).toBe("deny")
    expect(effect("concept", "structured_output", {})).toBe("allow")
    expect(effect("concept", "web_search", { query: "x" })).toBe("allow")
  })

  test("context-mode's code-running tools are refused in every mode; its search and report tools pass", () => {
    expect([...CODE_RUNNING_TOOLS]).toEqual(["ctx_execute", "ctx_batch"])
    for (const id of AGENT_IDS) {
      for (const tool of CODE_RUNNING_TOOLS) {
        expect(MODE_TOOLS[id]).not.toContain(tool)
        expect(decide(id, tool, { language: "shell", code: "git push" })).toEqual({
          effect: "deny",
          reason: `\`${tool}\` runs code the ${id[0]?.toUpperCase()}${id.slice(1)} mode guard cannot check; use bash`,
        })
      }
      for (const tool of ["ctx_search", "ctx_resume", "ctx_stats", "ctx_doctor"]) expect(effect(id, tool, {})).toBe("allow")
      for (const tool of CONTEXT_ADMIN_TOOLS) expect(effect(id, tool, {})).toBe("deny")
    }
  })

  test.each(AGENT_IDS.map((id) => [id]))("%s indexes only content, and a URL under its web rule", (id) => {
    for (const input of [{ path: ".env" }, { path: "." }, { path: "src", content: "x" }]) {
      const verdict = decide(id, "ctx_index", input)
      expect(verdict.effect === "deny" && verdict.reason).toContain("reads files past the mode's read rules")
    }
    expect(effect(id, "ctx_index", { content: "x" })).toBe("allow")
    const url = "https://example.com/doc"
    expect(effect(id, "ctx_index", { url })).toBe(permissionEffect(MODE_RULES[id], "webfetch", url))
    expect(effect(id, "ctx_index", { url })).toBe("allow")
    expect(effect(id, "ctx_index", { url, content: "x" })).toBe("deny")
    expect(effect(id, "ctx_index", {})).toBe("deny")
  })

  test("calls whose target cannot be read are refused", () => {
    expect(effect("refactor", "write", { content: "x" })).toBe("deny")
    expect(effect("refactor", "read", {})).toBe("deny")
    expect(effect("debug", "bash", { command: "  " })).toBe("deny")
  })
})

describe("context-mode's tools", () => {
  const { version, tools, source } = contextModeTools()

  test(`every tool of context-mode ${version} (${source}) is allowed, refused as code-running, or left out`, () => {
    const classes = [new Set(CONTEXT_TOOLS), CODE_RUNNING_TOOLS, CONTEXT_ADMIN_TOOLS]
    const unclassified = tools.filter((tool) => !classes.some((set) => set.has(tool)))
    expect(unclassified).toEqual([])
    expect(classes.flatMap((set) => [...set]).sort()).toEqual([...tools].sort())
    for (const id of AGENT_IDS) expect(MODE_TOOLS[id].filter((tool) => tool.startsWith("ctx_"))).toEqual([...CONTEXT_TOOLS])
  })

  test("the list is read from TOOL_ORDER in context-mode's pi bundle", () => {
    expect(toolOrder('var TOOL_ORDER = Object.freeze(["ctx_execute", "ctx_batch"]);')).toEqual(["ctx_execute", "ctx_batch"])
    expect(() => toolOrder("var OTHER = 1")).toThrow("no TOOL_ORDER")
  })
})

describe("debug", () => {
  test("writes only in a debug-* scratch worktree and the ledger directory", () => {
    expect(decide("debug", "write", { path: "src/a.ts" })).toEqual({ effect: "deny", reason: "Debug mode may not edit src/a.ts" })
    expect(effect("debug", "edit", { path: join(scratch, "a.ts") })).toBe("allow")
    expect(effect("debug", "write", { path: "~/.pi/debug/ledger.md" })).toBe("allow")
    expect(effect("debug", "write", { path: `@${join(scratch, "a.ts")}` })).toBe("allow")
    expect(effect("debug", "write", { path: join(home, PI_SCRATCH.worktrees, "repo", "other", "a.ts") })).toBe("deny")
    expect(effect("debug", "write", { path: join(home, ".opencode", "debug", "ledger.md") })).toBe("deny")
  })

  test("a symlink out of the scratch worktree into the checkout is refused", () => {
    expect(effect("debug", "write", { path: join(scratch, "escape", "a.ts") })).toBe("deny")
  })

  test("creates its worktree and commits there through a leading cd", () => {
    expect(effect("debug", "bash", { command: `git worktree add --detach ${scratch}` })).toBe("allow")
    expect(decide("debug", "bash", { command: `cd ${scratch} && git commit -am x` })).toEqual({ effect: "allow", headCheck: scratch })
    expect(effect("debug", "bash", { command: `git -C ${scratch} commit -am x` })).toBe("deny")
    expect(effect("debug", "bash", { command: `cd ${scratch} && git commit -am x || true` })).toBe("deny")
    expect(effect("debug", "bash", { command: "git commit -am x" })).toBe("deny")
  })

  test("names pi's working-directory form when git needs one", () => {
    const verdict = decide("debug", "bash", { command: "git commit -am x" })
    expect(verdict.effect === "deny" && verdict.reason).toContain("start the call with `cd <worktree> && `")
  })

  test("never pushes, cleans or removes trees", () => {
    expect(decide("debug", "bash", { command: "git push" })).toEqual({ effect: "deny", reason: "Debug mode may not run `git push`" })
    expect(effect("debug", "bash", { command: "ls && rm -rf build" })).toBe("deny")
    expect(effect("debug", "bash", { command: "git stash pop" })).toBe("deny")
  })

  test("launches only its helpers", () => {
    expect(effect("debug", "subagent", { agent: "scout", task: "find x" })).toBe("allow")
    expect(effect("debug", "subagent", { agent: "coder", task: "fix x" })).toBe("deny")
  })
})

describe("refactor", () => {
  test("tests, fixtures and snapshots are frozen", () => {
    for (const path of ["src/a.test.ts", "tests/x.py", "pkg/__snapshots__/a.snap", "fixtures/a.json", "go/a_test.go"]) {
      expect({ path, effect: effect("refactor", "edit", { path }) }).toEqual({ path, effect: "deny" })
    }
    expect(effect("refactor", "edit", { path: "src/a.ts" })).toBe("allow")
  })

  test("writes outside the project need approval", () => {
    expect(decide("refactor", "write", { path: join(root, "elsewhere.ts") })).toEqual({
      effect: "ask",
      reason: `Refactor mode needs the user's approval to edit ${join(root, "elsewhere.ts")}, outside the project`,
    })
  })

  test("refuses history rewrites and launches outside its helpers", () => {
    for (const command of ["git rebase main", "git reset --hard HEAD~1", "git -C . push", "git clean -fd"]) {
      expect({ command, effect: effect("refactor", "bash", { command }) }).toEqual({ command, effect: "deny" })
    }
    expect(effect("refactor", "bash", { command: "git commit -am 'refactor(x): y'" })).toBe("allow")
    expect(effect("refactor", "subagent", { agent: "code-reviewer", task: "review" })).toBe("allow")
    expect(effect("refactor", "subagent", { agent: "coder", task: "x" })).toBe("deny")
  })
})

describe("concept", () => {
  test("writes only design docs and its scratch directory", () => {
    expect(effect("concept", "write", { path: "docs/design/x.md" })).toBe("allow")
    expect(effect("concept", "write", { path: "docs/adr/0001.md" })).toBe("allow")
    expect(effect("concept", "write", { path: "~/.pi/concept/s/brief.md" })).toBe("allow")
    expect(effect("concept", "write", { path: "src/x.ts" })).toBe("deny")
    expect(effect("concept", "write", { path: join(root, "elsewhere.md") })).toBe("deny")
  })

  test("runs read-only git freely and asks for anything else", () => {
    expect(effect("concept", "bash", { command: "git log -3" })).toBe("allow")
    expect(effect("concept", "bash", { command: "python3 -m http.server 8000 --bind 127.0.0.1" })).toBe("allow")
    expect(decide("concept", "bash", { command: "git status && rm x" })).toEqual({
      effect: "ask",
      reason: "Concept mode needs the user's approval to run `rm x`",
    })
  })
})

describe("every mode", () => {
  test.each(AGENT_IDS.map((id) => [id]))("%s asks before reading .env files", (id) => {
    expect(effect(id, "read", { path: ".env" })).toBe("ask")
    expect(effect(id, "read", { path: "config/.env.local" })).toBe("ask")
    expect(effect(id, "read", { path: ".env.example" })).toBe("allow")
    expect(effect(id, "read", { path: "src/a.ts" })).toBe("allow")
  })

  test.each(AGENT_IDS.map((id) => [id]))("%s launches one named helper at a time", (id) => {
    expect(effect(id, "subagent", { workflow: "parallel", args: { tasks: [{ agent: "scout" }] } })).toBe("deny")
    expect(effect(id, "subagent", { task: "anything" })).toBe("deny")
    expect(effect(id, "subagent", { action: "status" })).toBe("allow")
    expect(effect(id, "subagent", { action: "delete", agent: "scout" })).toBe("deny")
  })
})

describe("a leading cd as pi's bash working directory", () => {
  test("applies only when nothing runs after a failed cd", () => {
    expect(shellWorkdir("cd /w && git add -A && git commit -m x", "/r")).toEqual({ command: " git add -A && git commit -m x", workdir: "/w" })
    expect(shellWorkdir("cd /w && git log | head", "/r")).toEqual({ command: " git log | head", workdir: "/w" })
    for (const command of ["cd /w && a || b", "cd /w && a; b", "cd /w && a & b", "cd /w && git commit -m 'a;b'", "cd /w\ngit commit"]) {
      expect(shellWorkdir(command, "/r")).toEqual({ command })
    }
    expect(shellWorkdir("git status", "/r")).toEqual({ command: "git status" })
  })

  test("only a literal directory counts, and the cut is the same match", () => {
    expect(shellWorkdir("cd /w/a.b_c && git commit -m x", "/r")).toEqual({ command: " git commit -m x", workdir: "/w/a.b_c" })
    for (const command of [
      "cd /w/..>/dev/null && git commit -m x",
      "cd /w/lnk>x && git commit -m x",
      "cd /w/a/../b && git commit -m x",
      "cd .. && git commit -m x",
      "cd -P /w && git commit -m x",
      "cd /w",
    ]) {
      expect(shellWorkdir(command, "/r")).toEqual({ command })
    }
  })

  test("debug refuses git that writes after a cd it cannot read literally", () => {
    for (const command of [
      `cd ${scratch}/..>/dev/null && git commit -m x`,
      `cd ${scratch}/escape>x && git commit -m x`,
      `cd ${scratch}/a/.. && git commit -m x`,
      `cd ${scratch} && builtin cd ${cwd} && git commit -m x`,
      `cd ${scratch} && eval cd ${cwd} && git commit -m x`,
      `cd ${scratch} && source ./setup.sh && git commit -m x`,
      `cd ${scratch} && . ./setup.sh && git commit -m x`,
    ]) {
      expect({ command, effect: effect("debug", "bash", { command }) }).toEqual({ command, effect: "deny" })
    }
    expect(decide("debug", "bash", { command: `cd ${scratch} && git commit -m x` })).toEqual({ effect: "allow", headCheck: scratch })
  })
})

describe("which mode a session runs", () => {
  test("a child is the agent pi-subagents tagged it with", () => {
    expect(childMode('<active_agent name="debug"/>\n\nYou find…', undefined, true)).toBe("debug")
    expect(childMode('<active_agent name="coder"/>', "coder: fix", true)).toBeUndefined()
    expect(childMode("prompt", "refactor: extract", true)).toBe("refactor")
    expect(childMode("prompt", "refactor: extract", false)).toBeUndefined()
  })

  const USER = ["read", "bash", "edit"]

  test("/mode enters, switches and leaves, restoring the tools from before the first mode", () => {
    const entered = switchMode({}, "debug", USER)
    expect(entered).toMatchObject({ state: { mode: "debug", saved: USER }, tools: MODE_TOOLS.debug, entered: "debug" })
    const switched = switchMode(entered?.state ?? {}, "concept", MODE_TOOLS.debug)
    expect(switched).toMatchObject({ state: { mode: "concept", saved: USER }, left: "debug", entered: "concept" })
    const left = switchMode(switched?.state ?? {}, "off", MODE_TOOLS.concept)
    expect(left).toMatchObject({ state: { saved: USER }, tools: USER, left: "concept" })
    expect(switchMode({}, "off", [])).toEqual({ state: {}, notice: "No mode is active." })
    expect(switchMode({}, "build", [])).toBeUndefined()
  })

  test("entering after /mode off snapshots the tools active now, not the earlier snapshot", () => {
    expect(switchMode({ saved: USER }, "refactor", ["read", "grep"])?.state).toEqual({ mode: "refactor", saved: ["read", "grep"] })
  })

  test("a stored state keeps its mode and its tool snapshot when they are well formed", () => {
    expect(readState({ mode: "refactor", saved: ["read"] })).toEqual({ mode: "refactor", saved: ["read"] })
    expect(readState({ mode: "refactor", saved: [1] })).toEqual({ mode: "refactor" })
    expect(readState({ saved: ["read"] })).toEqual({ saved: ["read"] })
    expect(readState({ mode: "build" })).toEqual({})
    expect(readState(undefined)).toEqual({})
  })
})

describe("a branch change", () => {
  const USER = ["read", "bash", "edit"]
  const REFACTOR = { mode: "refactor", saved: USER } as const

  test("from a mode to a branch without one restores the user's tools and drops the guard", () => {
    expect(branchMode({}, REFACTOR)).toEqual({ state: { saved: USER }, tools: USER })
  })

  test("prefers the target branch's /mode off snapshot, then the mode being left, then the session's first", () => {
    expect(branchMode({ saved: ["read"] }, REFACTOR, ["ls"]).tools).toEqual(["read"])
    expect(branchMode({}, { mode: "debug" }, ["ls"]).tools).toEqual(["ls"])
  })

  test("keeps the mode on when no snapshot exists, so its tools never run unguarded", () => {
    expect(branchMode({}, { mode: "debug" })).toEqual({ state: { mode: "debug" } })
  })

  test("into a branch with a mode applies that mode, from no mode or from another mode", () => {
    expect(branchMode(REFACTOR, {})).toEqual({ state: REFACTOR, tools: MODE_TOOLS.refactor })
    expect(branchMode({ mode: "concept", saved: USER }, REFACTOR)).toEqual({ state: { mode: "concept", saved: USER }, tools: MODE_TOOLS.concept })
  })

  test("between branches without a mode leaves the tools alone", () => {
    expect(branchMode({ saved: ["read"] }, {})).toEqual({ state: { saved: ["read"] } })
    expect(branchMode({}, {})).toEqual({ state: {} })
  })
})

describe("what the model is told", () => {
  test("the reminders name /mode and the mode's write locations", () => {
    expect(enterReminder("concept")).toContain("`docs/design/`, `docs/adr/`, `docs/decisions/` and `~/.pi/concept/`")
    expect(enterReminder("debug")).toContain("until the user runs `/mode off`")
    expect(leaveReminder("refactor")).toContain("NO LONGER in Refactor mode")
  })

  test("modes_status spells out the debug scratch paths", () => {
    const text = statusText("debug", env)
    expect(text).toContain(join(home, PI_SCRATCH.worktrees, "repo", "debug-<slug>"))
    expect(text).toContain(join(home, PI_SCRATCH.ledger))
    expect(statusText(undefined, env)).toContain("No mode is active")
  })
})
