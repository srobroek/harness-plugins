import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// An agent that several plugins ship has one body in `shared/agents/<id>.md`; each plugin keeps its own
// frontmatter. The composed files are committed, so this proves the copies a host may load have one prompt.

const plugins = join(import.meta.dir, "..", "plugins")
const COPIES: Record<string, string[]> = {
  "adversarial-challenger": ["agent-reviewer/common/agents/adversarial-challenger.opencode.md", "quality/common/agents/adversarial-challenger.opencode.md"],
  "pr-reviewer": ["agent-reviewer/common/agents/pr-reviewer.opencode.md", "delivery/common/agents/pr-reviewer.md"],
  researcher: ["agent-researcher/common/agents/researcher.md", "delivery/common/agents/researcher.md"],
}
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/
const body = (text: string) => text.replace(FRONTMATTER, "")

describe("shared agents", () => {
  for (const [id, copies] of Object.entries(COPIES)) {
    test(`${id}: the owner and fallback copies compose to one prompt`, () => {
      const bodies = copies.map((copy) => body(readFileSync(join(plugins, copy), "utf8")))
      expect(bodies[0]?.trim().length).toBeGreaterThan(0)
      expect(new Set(bodies).size).toBe(1)
    })

    test(`${id}: every plugin source includes the shared body`, () => {
      for (const copy of copies) {
        const source = join(plugins, copy.split("/")[0] as string, "agents.src", `${id}.md`)
        expect(body(readFileSync(source, "utf8")).trim()).toBe(`{{include shared/${id}}}`)
      }
    })
  }
})
