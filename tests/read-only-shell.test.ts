import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { READ_ONLY_SHELL_RULES } from "@srobroek/opencode-lib/read-only-shell"
import { guardDecision } from "../scripts/claude-agent-guard"

/** The hook tests start /bin/sh, and some start a stub runtime; about 0.1 s each alone, so 30 s leaves room under load. */
const SPAWN_MS = 30_000

const plugins = join(import.meta.dir, "../plugins")
const agents = [
  "agent-reviewer/common/agents/security-auditor.opencode.md",
  "agent-reviewer/common/agents/adversarial-challenger.opencode.md",
  "quality/common/agents/adversarial-challenger.opencode.md",
  "architecture/common/agents/architect.opencode.md",
  "code-challenge/common/agents/code-challenger.md",
  "code-challenge/common/agents/refactor-challenger.md",
  "design/common/agents/design-critic.opencode.md",
  "agent-seance/common/agents/seance.md",
]
const rules = [...READ_ONLY_SHELL_RULES]

describe("read-only agents", () => {
  // The shipped files are generated, so this catches a stale build or a hand edit as well as a missing marker.
  test.each(agents)("%s ships exactly the shared shell rules and no write tool", (path) => {
    const file = readAgentFile(join(plugins, path))
    expect(file.permissions.filter((rule) => rule.action === "shell")).toEqual(rules)
    for (const action of ["edit", "write", "patch"]) expect(permissionEffect(file.permissions, action)).toBe("deny")
    expect(permissionEffect(file.permissions, "external_directory")).toBe("ask")
  })
})

describe("code-reviewer", () => {
  // It runs in background sessions where nobody can answer a prompt, so nothing asks; it has no shell, and the caller
  // supplies the patch.
  const reviewer = join(plugins, "agent-reviewer")
  const opencode = ["common/agents/code-reviewer.opencode.md", "opencode/agents/code-reviewer.md"]
  const claude = ["common/agents/code-reviewer.claude.md", "claude/agents/code-reviewer.md"]
  const omp = ["common/agents/code-reviewer.omp.md", "omp/agents/code-reviewer.md"]
  const frontmatterTools = (path: string) =>
    (readFileSync(join(reviewer, path), "utf8").match(/^tools: (.*)$/m)?.[1] ?? "").split(", ")

  test.each(opencode)("%s has no shell grant and no rule that asks", (path) => {
    const { permissions } = readAgentFile(join(reviewer, path))
    expect(permissions.filter((rule) => rule.effect === "ask")).toEqual([])
    expect(permissions.filter((rule) => rule.action === "shell" && rule.effect !== "deny")).toEqual([])
    expect(permissionEffect(permissions, "shell", "git diff")).toBe("deny")
    expect(permissionEffect(permissions, "external_directory", "/tmp/x/y")).toBe("allow")
  })

  test.each(opencode.flatMap((path) => [
    [path, "/p/.env", "deny"],
    [path, "/p/.env.local", "deny"],
    [path, "/p/.env.example", "allow"],
    [path, "/p/src/main.ts", "allow"],
  ]))("%s reads %s: %s", (path, file, effect) => {
    expect(permissionEffect(readAgentFile(join(reviewer, path)).permissions, "read", file)).toBe(effect)
  })

  test.each(claude)("%s keeps Read and has no Bash", (path) => {
    const tools = frontmatterTools(path)
    expect(tools).toContain("Read")
    expect(tools).not.toContain("Bash")
  })

  test.each([
    ["/p/.env", "deny"],
    ["/p/.env.local", "deny"],
    ["/p/.env.example", undefined],
    ["/p/src/main.ts", undefined],
  ])("the shipped Claude guard answers Read of %s with %s", (file, decision) => {
    const config = JSON.parse(readFileSync(join(reviewer, "claude/hooks/agent-guards.json"), "utf8"))
    const input = { agent_type: "agent-reviewer:code-reviewer", tool_name: "Read", tool_input: { file_path: file } }
    expect(guardDecision(input, config)?.hookSpecificOutput.permissionDecision).toBe(decision)
  })

  test.each(omp)("%s has no bash", (path) => expect(frontmatterTools(path)).not.toContain("bash"))

  describe("the shipped Claude hook command", () => {
    const root = join(reviewer, "claude")
    const hooks = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8"))
    const command: string = hooks.hooks.PreToolUse[0].hooks[0].command
    const bin = mkdtempSync(join(tmpdir(), "guard-hook-"))
    afterAll(() => rmSync(bin, { recursive: true, force: true }))
    // The command needs cat and grep; every other tool on PATH comes from the case.
    for (const tool of ["cat", "grep"]) symlinkSync(Bun.which(tool) as string, join(bin, tool))
    const runtimes = {
      "no runtime": () => {},
      "a runtime that fails before it answers": () => writeExecutable(join(bin, "node"), "exit 3\n"),
      "a runtime that exits 0 without an answer": () => writeExecutable(join(bin, "node"), "exit 0\n"),
    }
    const run = async (runtime: keyof typeof runtimes, agent: string) => {
      rmSync(join(bin, "node"), { force: true })
      runtimes[runtime]()
      const input = { agent_type: agent, tool_name: "Read", tool_input: { file_path: "/p/src/main.ts" } }
      const proc = Bun.spawn(["/bin/sh", "-c", command], {
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        stdout: "pipe",
        env: { PATH: bin, CLAUDE_PLUGIN_ROOT: root },
      })
      const [out, code] = [await new Response(proc.stdout).text(), await proc.exited]
      return { code, decision: JSON.parse(out).hookSpecificOutput?.permissionDecision }
    }

    test.each(
      (Object.keys(runtimes) as (keyof typeof runtimes)[]).flatMap((runtime) => [
        [runtime, "agent-reviewer:code-reviewer", "deny"],
        [runtime, "agent-reviewer:security-auditor", "ask"],
      ]),
    )("with %s, a Read by %s gets %s", async (runtime, agent, decision) => {
      expect(await run(runtime as keyof typeof runtimes, agent)).toEqual({ code: 0, decision })
    }, SPAWN_MS)
  })
})
