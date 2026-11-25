import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { READ_ONLY_SHELL_RULES } from "@srobroek/opencode-lib/read-only-shell"
import { TEST_SHELL_RULES } from "@srobroek/opencode-lib/test-shell"

const plugins = join(import.meta.dir, "../plugins")
const agents = [
  "agent-reviewer/common/agents/adversarial-challenger.opencode.md",
  "quality/common/agents/adversarial-challenger.opencode.md",
  "code-challenge/common/agents/code-challenger.md",
  "code-challenge/common/agents/refactor-challenger.md",
  "design/common/agents/design-critic.opencode.md",
  "agent-seance/common/agents/seance.md",
]
// These reviewers also run the project's tests, so they ship the test-shell rules instead.
const testingAgents = ["agent-reviewer/common/agents/code-reviewer.opencode.md", "agent-reviewer/common/agents/security-auditor.opencode.md"]
// The architect writes design and research documents but runs only read-only commands.
const documentWriters = ["architecture/common/agents/architect.opencode.md"]
const rules = [...READ_ONLY_SHELL_RULES]
const testRules = [...TEST_SHELL_RULES]

const cases: Array<[string, typeof rules]> = [...agents.map((path): [string, typeof rules] => [path, rules]), ...testingAgents.map((path): [string, typeof rules] => [path, testRules])]

describe("agents on the shared shell rules", () => {
  // The shipped files are generated, so this catches a stale build or a hand edit as well as a missing marker.
  test.each(cases)("%s ships exactly its shared shell rules and no write tool", (path, expected) => {
    const file = readAgentFile(join(plugins, path))
    expect(file.permissions.filter((rule) => rule.action === "shell")).toEqual(expected)
    for (const action of ["edit", "write", "patch"]) expect(permissionEffect(file.permissions, action)).toBe("deny")
    expect(permissionEffect(file.permissions, "external_directory")).toBe("ask")
  })

  test.each(documentWriters)("%s ships the read-only shell rules beside its edit tool", (path) => {
    const file = readAgentFile(join(plugins, path))
    expect(file.permissions.filter((rule) => rule.action === "shell")).toEqual(rules)
    expect(permissionEffect(file.permissions, "edit")).toBe("allow")
    expect(permissionEffect(file.permissions, "external_directory")).toBe("ask")
  })
})
