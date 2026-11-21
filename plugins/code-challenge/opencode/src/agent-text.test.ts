import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The scout in dogfood round 2 was handed reference paths and read none of them, so the contract is pinned in
// the texts a model reads. Assertions name the contract (read before analysing, a `References read:` reply line,
// reject and re-ask once, the line in the analyse-lens step), not the exact wording.
const common = join(import.meta.dir, "..", "..", "common")
const text = (...parts: string[]) => readFileSync(join(common, ...parts), "utf8")

/** The text from the first match of `start` up to the next match of `end` after it (or the end of the source). */
function section(source: string, start: RegExp, end: RegExp): string {
  const from = source.search(start)
  expect(from).toBeGreaterThanOrEqual(0)
  const to = source.slice(from + 1).search(end)
  return to < 0 ? source.slice(from) : source.slice(from, from + 1 + to)
}

test("code-challenger reads every lens reference before analysing, and ends its reply with a References read: line", () => {
  const agent = text("agents", "code-challenger.md")
  const protocol = section(agent, /^## Protocol/m, /^## Rules/m)
  // Reading comes first: the requirement to read the references appears before the step that reads the target.
  const read = protocol.search(/lens reference/i)
  const target = protocol.search(/\bRead the target\b/i)
  expect(read).toBeGreaterThanOrEqual(0)
  expect(read).toBeLessThan(target)
  expect(protocol).toMatch(/before[^\n]*analy|analy[^\n]*after/i)
  expect(section(agent, /^## Output/m, /^$(?![\s\S])/)).toContain("`References read:`")
})

test("the skill's CHALLENGE step rejects a scout reply without the References read: line or with fewer references, and re-asks once", () => {
  const skill = text("skills", "code-challenge", "SKILL.md")
  const step = section(skill, /^3\. CHALLENGE/m, /^4\. /m)
  expect(step).toContain("`References read:`")
  expect(step).toMatch(/reject/i)
  expect(step).toMatch(/fewer|missing|short/i)
  expect(step).toMatch(/re-ask|ask again|once/i)
  expect(step).toMatch(/\bgap\b/i)
})

test("the analyse-lens step itself asks for the References read: line", () => {
  const formula = Bun.TOML.parse(text("formulas", "mol-challenge-lens.formula.toml")) as {
    steps: { id: string; description: string }[]
  }
  expect(formula.steps.find((step) => step.id === "analyse-lens")?.description).toContain("References read:")
})
