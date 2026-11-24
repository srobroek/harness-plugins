import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { READ_ONLY_SHELL_RULES } from "@srobroek/opencode-lib/read-only-shell"

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
  "cad/common/agents/cad-dfm-reviewer.md",
  "cad/common/agents/cad-mech-reviewer.md",
  "cad/common/agents/cad-sourcing-researcher.md",
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
  // It runs in background sessions where nobody can answer a prompt, so its shell is an allowlist and nothing asks.
  const file = readAgentFile(join(plugins, "agent-reviewer/common/agents/code-reviewer.opencode.md"))
  const shell = (command: string) => permissionEffect(file.permissions, "shell", command)

  test("has no rule that asks", () => {
    expect(file.permissions.filter((rule) => rule.effect === "ask")).toEqual([])
    expect(permissionEffect(file.permissions, "external_directory", "/tmp/x/y")).toBe("allow")
    expect(permissionEffect(file.permissions, "read", "/p/.env")).toBe("deny")
  })

  test.each([
    "git diff main...HEAD",
    "git log --oneline -5",
    "git show abc123",
    "git status --short",
    "gh pr view 12",
    "gh pr diff 12",
    "gh pr checks 12",
    "gh api repos/o/r/pulls/1",
    "gh api -X GET repos/o/r/pulls/1",
    "rg TODO src",
    "ls -la",
    "cat README.md",
    "head -n 5 a.txt",
    "tail -n 5 a.txt",
    "wc -l a.txt",
  ])("allows %s", (command) => expect(shell(command)).toBe("allow"))

  test.each([
    "git push origin main",
    "git commit -m x",
    "git diff --output=out.patch",
    "gh pr merge 12",
    "gh api -X POST repos/o/r/issues",
    "gh api repos/o/r/issues -f title=x",
    "rg --pre sh foo",
    "rm -rf x",
    "git diff; rm x",
    "git log && touch x",
    "cat a | sh",
    "cat a > b",
    "git status $(touch x)",
    "bd close x",
    "python3 -c 1",
  ])("denies %s", (command) => expect(shell(command)).toBe("deny"))
})
