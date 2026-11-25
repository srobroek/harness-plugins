import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const plugins = join(import.meta.dir, "../../plugins")
// A plugin that also ships to Claude Code keeps the OpenCode form as `<agent>.opencode.md`.
const shipped = (plugin: string, agent: string): string => {
  const directory = join(plugins, plugin, "common", "agents")
  const file = [`${agent}.opencode.md`, `${agent}.md`].map((name) => join(directory, name)).find(existsSync)
  return readFileSync(file ?? join(directory, `${agent}.md`), "utf8")
}

// The rules every reviewer applies (review-standards: rules), and the checklist the full reviewers add.
const RULES = ["Standards check: load `lang-<language>`", "`quality-code-policy`", "A departure with no stated reason", "stack-changing diff"]
const CHECKLIST = ["a helper copied where one shared home exists", "a lint allowed without a stated reason", "with no TypeSpec source"]

const reviewers = [
  { plugin: "agent-reviewer", agent: "code-reviewer", checklist: true },
  { plugin: "agent-reviewer", agent: "pr-reviewer", checklist: true },
  { plugin: "delivery", agent: "pr-reviewer", checklist: true },
  { plugin: "agent-reviewer", agent: "security-auditor", checklist: false },
]

describe("shipped reviewer prompts carry the standards instructions", () => {
  for (const { plugin, agent, checklist } of reviewers) {
    test(`${plugin}/${agent}`, () => {
      const prompt = shipped(plugin, agent)
      for (const phrase of RULES) expect(prompt).toContain(phrase)
      for (const phrase of CHECKLIST) checklist ? expect(prompt).toContain(phrase) : expect(prompt).not.toContain(phrase)
    })
  }
})
