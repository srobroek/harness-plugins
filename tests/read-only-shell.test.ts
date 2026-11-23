import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { READ_ONLY_SHELL_RULES } from "@srobroek/opencode-lib/read-only-shell"

const plugins = join(import.meta.dir, "../plugins")
const agents = [
  "agent-reviewer/common/agents/code-reviewer.opencode.md",
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
