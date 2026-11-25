import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentPermission } from "@srobroek/opencode-lib/agent-files"
import {
  AGENT_IDS,
  type AgentId,
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

describe("pi rules and tools stay in step with the agents", () => {
  const GUARDED = new Set(["*", "read", "external_directory", "edit", "shell", "subagent"])

  test.each(AGENT_IDS.map((id) => [id]))("%s has its OpenCode agent's read, edit, shell and subagent rules", (id) => {
    const rules = (frontmatter(join(PLUGIN, "agents.src", `${id}.md`)).permissions as AgentPermission[])
      .filter((rule) => GUARDED.has(rule.action))
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

  test("calls whose target cannot be read are refused", () => {
    expect(effect("refactor", "write", { content: "x" })).toBe("deny")
    expect(effect("refactor", "read", {})).toBe("deny")
    expect(effect("debug", "bash", { command: "  " })).toBe("deny")
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
})

describe("which mode a session runs", () => {
  test("a child is the agent pi-subagents tagged it with", () => {
    expect(childMode('<active_agent name="debug"/>\n\nYou find…', undefined, true)).toBe("debug")
    expect(childMode('<active_agent name="coder"/>', "coder: fix", true)).toBeUndefined()
    expect(childMode("prompt", "refactor: extract", true)).toBe("refactor")
    expect(childMode("prompt", "refactor: extract", false)).toBeUndefined()
  })

  test("/mode enters, switches and leaves, restoring the tools from before the first mode", () => {
    const entered = switchMode({}, "debug", ["read", "bash", "edit"])
    expect(entered).toMatchObject({ state: { mode: "debug", saved: ["read", "bash", "edit"] }, tools: MODE_TOOLS.debug, entered: "debug" })
    const switched = switchMode(entered?.state ?? {}, "concept", MODE_TOOLS.debug)
    expect(switched).toMatchObject({ state: { mode: "concept", saved: ["read", "bash", "edit"] }, left: "debug", entered: "concept" })
    const left = switchMode(switched?.state ?? {}, "off", MODE_TOOLS.concept)
    expect(left).toMatchObject({ state: {}, tools: ["read", "bash", "edit"], left: "concept" })
    expect(switchMode({}, "off", [])).toEqual({ state: {}, notice: "No mode is active." })
    expect(switchMode({}, "build", [])).toBeUndefined()
  })

  test("a stored state is read back only when it names a mode", () => {
    expect(readState({ mode: "refactor", saved: ["read"] })).toEqual({ mode: "refactor", saved: ["read"] })
    expect(readState({ mode: "refactor", saved: [1] })).toEqual({ mode: "refactor" })
    expect(readState({ mode: "build" })).toEqual({})
    expect(readState(undefined)).toEqual({})
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
