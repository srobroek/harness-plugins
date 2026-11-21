import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { parseAgentFile, permissionEffect, readAgentFile } from "./agent-files.ts"
import { composeAgent } from "./fragments.ts"
import { READ_ONLY_SHELL_RULES } from "./read-only-shell.ts"

const plugins = join(import.meta.dir, "../../plugins")
const agents = [
  "agent-reviewer/common/agents/code-reviewer.opencode.md",
  "agent-reviewer/common/agents/security-reviewer.opencode.md",
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
const effect = (command: string) => permissionEffect(rules, "shell", command)

describe("shared read-only shell rules", () => {
  test.each([
    "git fetch origin pull/7/head",
    "git log -3",
    "git status",
    "git stash list",
    "gh pr diff 7 --repo o/r",
    "gh pr view 7",
    "gh api repos/o/r/pulls/7",
    "gh api repos/o/r -X GET",
    "gh repo clone o/r /tmp/opencode/r",
    "bd show bd-1",
    "bd --json list",
    "bd dep list bd-1",
    "rg foo",
  ])("allows %s", (command) => expect(effect(command)).toBe("allow"))

  test.each([
    "git push origin main",
    "git commit -m x",
    "git reset --hard",
    "git checkout -- .",
    "git restore x",
    "git clean -fd",
    "git rebase main",
    "git merge x",
    "git branch -D x",
    "git tag -d v1",
    "git stash drop",
    "git worktree remove x",
    "git update-ref -d x",
    "git diff --output=x",
    "gh pr merge 7",
    "gh pr create",
    "gh pr comment 7",
    "gh pr review 7 --approve",
    "gh issue close 1",
    "gh release create v1",
    "gh repo delete o/r",
    "gh api repos/o/r/issues -X POST",
    "gh api repos/o/r --method DELETE",
    "gh api repos/o/r/issues -f title=x",
    "glab mr merge 3",
    "bd close bd-1",
    "bd create x",
    "bd update bd-1",
    "bd delete bd-1",
    "bd dep add a b",
    "bd comments add bd-1 x",
    "rm -rf x",
    "mv a b",
    "echo x > file",
    "ast-grep run -p a -r b -U",
  ])("denies %s", (command) => expect(effect(command)).toBe("deny"))

  test("a frontmatter marker expands to the rules, whatever follows it", () => {
    const source = '---\npermissions:\n  # {{rules read-only-shell}}\n  - action: edit\n    resource: "*"\n    effect: deny\n---\nBody\n'
    const file = parseAgentFile(composeAgent(source), "x")
    expect(file.permissions.filter((rule) => rule.action === "shell")).toEqual(rules)
    expect(permissionEffect(file.permissions, "edit")).toBe("deny")
  })

  // The shipped files are generated, so this catches a stale build or a hand edit as well as a missing marker.
  test.each(agents)("%s ships exactly the shared shell rules and no write tool", (path) => {
    const file = readAgentFile(join(plugins, path))
    expect(file.permissions.filter((rule) => rule.action === "shell")).toEqual(rules)
    for (const action of ["edit", "write", "patch"]) expect(permissionEffect(file.permissions, action)).toBe("deny")
    expect(permissionEffect(file.permissions, "external_directory")).toBe("ask")
  })
})
