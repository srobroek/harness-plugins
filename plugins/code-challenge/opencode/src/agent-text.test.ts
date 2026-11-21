import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The scout in dogfood round 2 was handed reference paths and read none of them, so the contract is pinned in
// the texts a model reads: the agent must read first and prove it, and the lead must check the proof.
const common = join(import.meta.dir, "..", "..", "common")
const text = (...parts: string[]) => readFileSync(join(common, ...parts), "utf8")

test("code-challenger must read every lens reference in its brief before analysing, and end with a References read: line", () => {
  const agent = text("agents", "code-challenger.md")
  expect(agent).toMatch(/read every lens reference named in the Brief[\s\S]{0,120}BEFORE you analyse/)
  expect(agent).toContain("evidence.md")
  expect(agent).toMatch(/end your reply with a `References read:` line/i)
  expect(agent).toMatch(/lists? the absolute paths you read/i)
})

test("the skill's CHALLENGE step has the lead reject a scout reply without the line or with fewer references, and re-ask once", () => {
  const skill = text("skills", "code-challenge", "SKILL.md")
  const step = skill.slice(skill.indexOf("3. CHALLENGE"), skill.indexOf("4. RESEARCH"))
  expect(step).toContain("`References read:`")
  expect(step).toMatch(/lacks the line/)
  expect(step).toMatch(/fewer references/)
  expect(step).toMatch(/re-ask once/)
  expect(step).toMatch(/gap/)
})

test("the analyse-lens formula step asks for the References read: line", () => {
  const formula = text("formulas", "mol-challenge-lens.formula.toml")
  expect(formula).toContain("`References read:`")
})
