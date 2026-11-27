import { expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

test("registers the business-rules skills and disposes them", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()].sort()).toEqual([
    "business-rules-cel",
    "business-rules-ci",
    "business-rules-guide",
    "business-rules-testing",
  ])
  for (const skill of fake.skills.values())
    expect(String(skill.content)).not.toMatch(/skill:\/\/|rule:\/\/|(?<!`)`(?:bash|eval)`(?!`)|TTSR/)
  await cleanup?.()
  expect(fake.active()).toBe(0)
  expect(fake.skills.size).toBe(0)
})

test("keeps a user's skill of the same id", async () => {
  const fake = createFakeContext({ skills: [{ id: "business-rules-guide", content: "mine" }] })
  await plugin.setup(fake.context)
  expect(fake.skills.get("business-rules-guide")?.content).toBe("mine")
})
